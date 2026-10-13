// ABOUTME: Owns the Git tab, status groups, and safe user-visible Git actions.
// ABOUTME: Renders untrusted repository paths with DOM text nodes and delegates writes to GitClient.

import { GitHistoryPanel } from "./git-history-panel.js";
import {
  buildGitTree,
  confirmDiscardDialog,
  countGitTreeFiles,
  createCommitDialog,
  createGitPanelToolbar,
  groupsForGitEntry,
  renderGitTree,
} from "./git-panel-dialogs.js";
import { t } from "./i18n.js";
import { createIcon } from "./icons.js";

function createSectionChevron() {
  const chevron = document.createElement("span");
  chevron.className = "section-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.append(createIcon("chevron-right", { size: 16 }));
  return chevron;
}

// Object-icon rendering for Git entries uses the shared Material file-type
// vocabulary from `file-type-icons.js`, so the Git tree stays visually
// consistent with the File Browser and File Preview tabs.
const GROUPS = ["staged", "changes", "untracked", "conflicted"];

export class GitPanel {
  constructor({
    container,
    client,
    openDiff,
    onDiffRequest,
    onHistoryDiffRequest,
    onStatus,
    fileList,
  } = {}) {
    this.outerContainer = container;
    this.client = client;
    this._subTab = "changes";
    this.subTabBar = document.createElement("div");
    this.subTabBar.className = "git-subtab-bar";
    this.subTabBar.setAttribute("role", "tablist");
    this.container = document.createElement("div");
    this.container.className = "git-subtab-pane git-changes-pane";
    this.historyContainer = document.createElement("div");
    this.historyContainer.className = "git-subtab-pane git-history-pane hidden";
    this.historyPanel = new GitHistoryPanel({
      container: this.historyContainer,
      client,
      onDiffRequest: onHistoryDiffRequest,
    });
    this.outerContainer.replaceChildren(this.subTabBar, this.container, this.historyContainer);
    this._renderSubTabBar();
    this.openDiff = openDiff;
    this.onDiffRequest = onDiffRequest;
    this.onStatus = onStatus;
    this.fileList = fileList;
    this.snapshot = null;
    this.notGitRepo = false;
    this.pendingStatusRequestId = null;
    this.folded = new Set();
    this.selected = new Set();
    this.aiSnapshot = null;
    this.commitMessage = "";
    this.pendingConfirmationToken = null;
    this.commitDialog = null;
    this.aiError = null;
    this.commitInProgress = false;
    this.pendingCommitRequestId = null;
    this.pendingAiRequestId = null;
    this.pushInProgress = false;
    this.pushError = null;
    this.pendingPushRequestId = null;
  }
  setSnapshot(snapshot) {
    this.snapshot = snapshot;
    this.notGitRepo = false;
    this.pendingStatusRequestId = null;
    this.historyPanel?.setUnavailable(false);
    const valid = new Set(
      (snapshot?.entries || []).flatMap((entry) =>
        this.groupsFor(entry).map(
          (group) => `${snapshot.snapshotId}:${group}:${entry.pathBytesBase64}`,
        ),
      ),
    );
    this.selected = new Set(
      [...this.selected].filter(
        (identity) =>
          snapshot &&
          identity.split(":").slice(0, 2).join(":") === snapshot.snapshotId &&
          valid.has(identity),
      ),
    );
    this.render();
    this.onStatus?.(snapshot);
  }
  setNotGitRepo(value = true) {
    this.notGitRepo = value;
    this.pendingStatusRequestId = null;
    this.historyPanel?.setUnavailable(value);
    this.render();
  }
  _renderSubTabBar() {
    for (const name of ["changes", "history"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "git-subtab";
      button.dataset.subtab = name;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(name === this._subTab));
      button.textContent = name === "changes" ? t("git.comparison.changes") : t("git.history");
      button.addEventListener("click", () => this.setSubTab(name));
      this.subTabBar.append(button);
    }
  }
  setSubTab(name) {
    if (name !== "changes" && name !== "history") return;
    const wasHistory = this._subTab === "history";
    this._subTab = name;
    const isHistory = name === "history";
    this.container.classList.toggle("hidden", isHistory);
    this.historyContainer.classList.toggle("hidden", !isHistory);
    for (const button of this.subTabBar.querySelectorAll(".git-subtab")) {
      button.setAttribute("aria-selected", String(button.dataset.subtab === name));
    }
    this.historyPanel.setActive(isHistory);
    if (isHistory && !wasHistory) this.historyPanel.refresh();
  }
  /** True only for the failure of the most recent status probe, so stale or
   *  concurrent non-status failures (diff/write/commit) cannot flip the panel
   *  into the not-a-repository state. */
  isStatusFailure(requestId) {
    return requestId != null && requestId === this.pendingStatusRequestId;
  }
  async refresh() {
    const id = this.client?.command({ type: "status" });
    if (!id) return null;
    this.pendingStatusRequestId = id;
    return id;
  }
  async discard(entries = [], contextGroup = null) {
    if (!entries.length) return null;
    const confirmed = await this.confirmDiscard(entries.length);
    if (!confirmed) return null;
    return this.write("discard", entries, contextGroup);
  }
  confirmDiscard(count) {
    return confirmDiscardDialog(count);
  }
  requestAiCommitMessage() {
    if (
      !this.snapshot ||
      this.snapshot.counts?.staged === 0 ||
      this.snapshot.counts?.conflicted > 0
    )
      return null;
    this.aiError = null;
    const requestId = this.client?.aiCommitMessage();
    this.pendingAiRequestId = requestId || null;
    return requestId;
  }
  applyAiResult(snapshot, message) {
    this.pendingAiRequestId = null;
    this.aiSnapshot = snapshot || null;
    this.commitMessage = message || "";
    this.aiError = null;
    this.openCommitDialog();
  }
  applyAiFailure(error) {
    this.pendingAiRequestId = null;
    // Spec: AI failure/timeout must still open the commit dialog with an empty
    // message so the user can write one by hand. If no AI snapshot exists yet,
    // fall back to the current status snapshot so the commit can still bind to
    // a snapshotId, HEAD and index tree.
    if (!this.aiSnapshot?.snapshotId && this.snapshot?.snapshotId) {
      this.aiSnapshot = {
        snapshotId: this.snapshot.snapshotId,
        headState: this.snapshot.headState,
        headOid: this.snapshot.headOid,
        indexTreeOid: this.snapshot.indexTreeOid,
      };
    }
    this.commitMessage = this.commitMessage || "";
    this.aiError = error || t("git.aiFailed");
    this.openCommitDialog();
  }
  applyConfirmationToken(token) {
    this.pendingConfirmationToken = token || null;
    this.commitInProgress = false;
    if (this.commitDialog) {
      this.openCommitDialog();
    }
  }
  openCommitDialog() {
    if (!this.aiSnapshot?.snapshotId) return;
    this.closeCommitDialog();
    this.commitDialog = createCommitDialog({
      aiError: this.aiError,
      pendingConfirmationToken: this.pendingConfirmationToken,
      commitMessage: this.commitMessage,
      onInput: (value) => {
        this.commitMessage = value;
      },
      onCancel: () => this.closeCommitDialog(),
      onSubmit: (value) => {
        this.commitMessage = value;
        this.commit();
      },
    });
    this.updateCommitDialogState();
  }
  closeCommitDialog() {
    if (!this.commitDialog) return;
    this.commitDialog.unbindEscape?.();
    this.commitDialog.overlay.remove();
    this.commitDialog = null;
  }
  updateCommitDialogState() {
    if (!this.commitDialog) return;
    this.commitDialog.textarea.disabled = this.commitInProgress;
    this.commitDialog.submit.disabled =
      this.commitInProgress || !this.commitDialog.textarea.value.trim();
    this.commitDialog.submit.textContent = this.commitInProgress
      ? t("git.committing")
      : t("git.commit");
  }
  setCommitInProgress(inProgress) {
    this.commitInProgress = Boolean(inProgress);
    if (inProgress) this.updateCommitDialogState();
    else this.closeCommitDialog();
  }
  applyCommitResult(result) {
    const status = result?.status;
    if (status === "succeeded") {
      this.setCommitInProgress(false);
      this.aiSnapshot = null;
      this.commitMessage = "";
      this.pendingConfirmationToken = null;
      this.pendingCommitRequestId = null;
      return;
    }
    this.commitInProgress = false;
    this.pendingCommitRequestId = null;
    if (status === "outcomeUnknown") {
      this.aiError = t("git.outcomeUnknown");
    } else {
      this.aiError = result?.error || t("git.aiFailed");
    }
    if (this.commitDialog) this.openCommitDialog();
  }
  applyCommitFailure(error) {
    this.commitInProgress = false;
    this.aiError = error || t("git.aiFailed");
    if (this.commitDialog) this.openCommitDialog();
  }
  commit(message = this.commitMessage, confirmationToken = this.pendingConfirmationToken) {
    if (!this.aiSnapshot?.snapshotId || !message.trim()) return null;
    this.setCommitInProgress(true);
    const requestId = this.client?.commit(this.aiSnapshot.snapshotId, message, confirmationToken);
    this.pendingCommitRequestId = requestId || null;
    return requestId;
  }
  push() {
    if (this.pushInProgress) return null;
    this.pushError = null;
    this.pushInProgress = true;
    const requestId = this.client?.push();
    this.pendingPushRequestId = requestId || null;
    if (!requestId) this.pushInProgress = false;
    this.render();
    return requestId;
  }
  setPushInProgress(inProgress) {
    this.pushInProgress = Boolean(inProgress);
    this.render();
  }
  applyPushResult(result) {
    this.pushInProgress = false;
    this.pendingPushRequestId = null;
    this.pushError = result?.status === "succeeded" ? null : this.pushErrorText(result?.error);
    this.render();
  }
  /** Map the backend's stable failure codes onto localized copy, and pass
   *  git's own stderr through unchanged when there is no code for it. */
  pushErrorText(error) {
    if (error === "push_detached_head") return t("git.pushDetachedHead");
    if (error === "push_no_remote") return t("git.pushNoRemote");
    if (error === "busy") return t("git.pushBusy");
    const text = typeof error === "string" ? error.trim() : "";
    return text || t("git.pushFailed");
  }
  write(operation, entries = [], contextGroup = null) {
    const snapshotId = this.snapshot?.snapshotId;
    const selected = entries
      .map((entry) => ({
        group: contextGroup || this.groupsFor(entry)[0],
        pathBytesBase64: entry.pathBytesBase64,
        originalPathBytesBase64: entry.originalPathBytesBase64,
      }))
      .filter((entry) => entry.pathBytesBase64);
    const allowedGroups = {
      stage: new Set(["changes", "untracked", "conflicted"]),
      unstage: new Set(["staged"]),
      discard: new Set(["changes"]),
    };
    if (
      !snapshotId ||
      selected.length === 0 ||
      !allowedGroups[operation] ||
      selected.some((entry) => !allowedGroups[operation].has(entry.group))
    )
      return null;
    return this.client?.write(operation, snapshotId, selected);
  }
  destroy() {
    this.closeCommitDialog();
    this.historyPanel?.destroy?.();
    this.container?.replaceChildren();
  }
  render() {
    if (!this.container) return;
    const scrollTop = this.container.scrollTop;
    this.container.replaceChildren();
    const snapshot = this.snapshot;
    if (this.notGitRepo) {
      const empty = document.createElement("p");
      empty.textContent = t("git.notGitRepo");
      this.container.append(empty);
      return;
    }
    if (!snapshot) {
      const empty = document.createElement("p");
      empty.textContent = t("git.noStatus");
      this.container.append(empty);
      return;
    }
    const entriesByGroup = new Map(GROUPS.map((group) => [group, []]));
    for (const entry of snapshot.entries || []) {
      for (const group of this.groupsFor(entry)) {
        entriesByGroup.get(group)?.push(entry);
      }
    }
    const selectedEntriesFor = (group, groupEntries) =>
      groupEntries.filter((entry) =>
        this.selected.has(`${snapshot.snapshotId}:${group}:${entry.pathBytesBase64}`),
      );
    for (const group of GROUPS) {
      const entries = entriesByGroup.get(group) || [];
      const section = document.createElement("section");
      section.className = `git-group git-group-${group}`;
      const heading = document.createElement("div");
      heading.className = `git-group-heading sidebar-section-header${
        this.folded.has(group) ? " collapsed" : ""
      }`;
      const headingId = `git-group-heading-${group}`;
      heading.id = headingId;
      heading.setAttribute("role", "button");
      heading.tabIndex = 0;
      heading.setAttribute("aria-expanded", String(!this.folded.has(group)));
      heading.setAttribute("aria-controls", `git-group-body-${group}`);
      section.setAttribute("role", "region");
      section.setAttribute("aria-labelledby", headingId);
      heading.appendChild(this._createChevron());
      const label = document.createElement("span");
      label.className = "sidebar-section-title";
      label.textContent = t(`git.${group}`);
      const count = document.createElement("span");
      count.className = "sidebar-section-count";
      count.textContent = String(entries.length);
      heading.append(label, count);
      heading.addEventListener("click", () => {
        this.folded.has(group) ? this.folded.delete(group) : this.folded.add(group);
        this.render();
      });
      heading.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        heading.click();
      });
      section.append(heading);
      if (this.folded.has(group)) {
        this.container.append(section);
        continue;
      }
      const body = document.createElement("div");
      body.className = "git-group-body";
      body.id = `git-group-body-${group}`;
      const tree = this.buildTree(entries);
      this.renderTree(tree, body, snapshot, group, "");
      section.append(body);
      if (snapshot.totalEntryCount > snapshot.returnedEntryCount) {
        const hidden = snapshot.totalEntryCount - snapshot.returnedEntryCount;
        const notice = document.createElement("p");
        notice.className = "git-truncation-notice";
        notice.textContent = t("git.truncated", { count: hidden });
        section.append(notice);
      }
      if (entries.length > 0) {
        const selected = selectedEntriesFor(group, entries);
        const actions = document.createElement("div");
        actions.className = "git-group-actions";
        const operations =
          group === "staged"
            ? ["unstage"]
            : group === "changes"
              ? ["stage", "discard"]
              : group === "conflicted"
                ? ["stage"]
                : ["stage"];
        for (const operation of operations) {
          const action = document.createElement("button");
          action.type = "button";
          const targetCount = selected.length > 0 ? selected.length : entries.length;
          action.textContent = `${t(`git.${operation}`)} (${targetCount})`;
          action.addEventListener("click", () => {
            const targets = selected.length > 0 ? selected : entries;
            if (operation === "discard") this.discard(targets, group);
            else this.write(operation, targets, group);
          });
          actions.append(action);
        }
        section.append(actions);
      }
      this.container.append(section);
    }
    this.container.prepend(
      createGitPanelToolbar({
        snapshot,
        pushError: this.pushError,
        pushInProgress: this.pushInProgress,
        onPush: () => this.push(),
        onAiCommit: () => this.requestAiCommitMessage(),
      }),
    );
    this.container.scrollTop = scrollTop;
  }
  buildTree(entries) {
    return buildGitTree(entries);
  }
  renderTree(node, container, snapshot, group, prefix) {
    renderGitTree({
      panel: this,
      node,
      container,
      snapshot,
      group,
      prefix,
    });
  }
  countFiles(node) {
    return countGitTreeFiles(node);
  }
  _createChevron() {
    return createSectionChevron();
  }
  groupsFor(entry) {
    return groupsForGitEntry(entry);
  }
  groupFor(entry) {
    return this.groupsFor(entry)[0];
  }
}
