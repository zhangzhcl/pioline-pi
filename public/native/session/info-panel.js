// ABOUTME: Info right-side panel — fixed workspace actions plus scrollable history.
// ABOUTME: Session rows visualize Pi's native tree and synchronize with chat anchors.

/**
 * Info panel — ported from picot-v3 (5dd2bb9) for the 2026-08-21 design.
 *
 * Fixed header plus one scroller:
 * 1. **Workspace** (fixed, never scrolls away): workspace path with an icon-only
 *    copy control, and compact Session Info. Session file + id are abstracted
 *    to one icon each -- clicking the icon copies the value, the tooltip
 *    reveals it.
 *    Open-in-app lives only in the header — it is not duplicated here.
 * 2. **Scroll region**: the injected task analysis section (timing/failure
 *    report plus the optional AI block, built by `session-task-analysis.js`)
 *    and the session history tree projected by `session-tree.js` from the
 *    session's entries + leafId (host `read_session_tree` snapshot). Both
 *    scroll together rather than competing for height in the rail.
 *
 * Interaction contract (design):
 * - Clicking an ACTIVE node scrolls the main chat to the rendered message
 *   (`[data-entry-id]` anchor); it never changes leaf or composer.
 * - Inactive nodes are non-navigable divs (no fake buttons, not focusable).
 * - Inactive branches collapse at their fork point; the summary row is a real
 *   expand/collapse button.
 * - v3's "Resume branch" affordance is NOT ported in this phase: switching the
 *   active leaf requires Pi's native navigateTree RPC (migrated with the
 *   fork/branch work in Phase 3), so rendering it here would promise an action
 *   the runtime cannot yet perform.
 */

import { createIcon } from "../../icons.js";
import { displayLocalPath } from "../../workspace/path-utils.js";
import {
  createInfoTreeBranchDom,
  createInfoTreeNodeRow,
  createSessionInfoRowDom,
  escapeAttribute,
  paintSessionInfoRowDom,
} from "./info-panel-tree-dom.js";
import { describeSessionFile, describeSessionId } from "./session-info.js";
import { buildSessionTree } from "./session-tree.js";

export class InfoPanel {
  /**
   * @param {{
   *   panel: HTMLElement,
   *   actions: { copyWorkspacePath: Function },
   *   t: (key: string, params?: object) => string,
   *   onNavigateLeaf?: (entryId: string) => void,
   *   isStreaming?: () => boolean,
   *   writeText?: (text: string) => Promise<void> | void,
   *   taskAnalysis?: { element: HTMLElement, resetHistory: Function } | null,
   * }} options
   */
  constructor({ panel, actions, t, onNavigateLeaf, isStreaming, writeText, taskAnalysis }) {
    this.panel = panel;
    this.actions = actions;
    this.t = t;
    this.onNavigateLeaf = onNavigateLeaf || (() => {});
    this.isStreaming = isStreaming || (() => false);
    this.writeText = writeText || ((text) => navigator.clipboard?.writeText(text));
    // Built by the composition root: the section owns its own turn sources and
    // state, this view only decides where it sits in the rail.
    this.taskAnalysis = taskAnalysis || null;
    this.workspacePath = "";
    this.sessionFilePath = "";
    this.sessionId = "";
    this.expandedBranches = new Set();
    this.tree = null;
    // Session entries + leafId cache. Full snapshots (read_session_tree /
    // panel re-entry) replace it wholesale.
    this.entries = null;
    this.leafId = null;
    this.selectedEntryId = null;
    this._pendingSelectedScroll = false;
    this._copiedTimer = null;
    this._buildDom();
  }

  _buildDom() {
    const p = this.panel;
    p.classList.add("info-panel");
    p.setAttribute("aria-label", this.t("infoPanel.title"));
    p.replaceChildren();

    this.workspaceSection = document.createElement("section");
    this.workspaceSection.className = "info-panel-workspace";

    // One scroller for everything below the fixed workspace header: the task
    // analysis and the session tree scroll together instead of fighting for
    // height in a rail this narrow.
    this.scrollEl = document.createElement("div");
    this.scrollEl.className = "info-panel-scroll";

    this.historySection = document.createElement("section");
    this.historySection.className = "info-panel-history";
    this.historySection.setAttribute("aria-labelledby", "info-panel-history-heading");

    this.scrollEl.append(...[this.taskAnalysis?.element, this.historySection].filter(Boolean));
    p.append(this.workspaceSection, this.scrollEl);
    this._renderWorkspace();
    this._renderHistory();
  }

  // ── Workspace ───────────────────────────────────────────────────────────

  _renderWorkspace() {
    const t = this.t;
    const section = this.workspaceSection;
    section.replaceChildren();

    section.setAttribute("aria-label", t("infoPanel.workspace"));

    const pathRow = document.createElement("div");
    pathRow.className = "info-panel-path-row";

    this.pathEl = document.createElement("div");
    this.pathEl.className = "file-sidebar-path info-panel-path";
    this.pathEl.textContent = displayLocalPath(this.workspacePath) || "—";
    this.pathEl.title = this.workspacePath;

    this.copyBtn = document.createElement("button");
    this.copyBtn.type = "button";
    this.copyBtn.className =
      "ui-icon-button ui-icon-button--xs ui-icon-button--ghost info-panel-copy-path";
    this.copyBtn.title = t("infoPanel.copyPath");
    this.copyBtn.setAttribute("aria-label", t("infoPanel.copyPath"));
    this.copyBtn.append(createIcon("clipboard", { size: 14 }));
    this.copyBtn.addEventListener("click", () => {
      void this._copyPath();
    });

    pathRow.append(this.pathEl, this.copyBtn);
    section.append(pathRow);
    this._renderSessionInfo(section);
  }

  _renderSessionInfo(section) {
    const t = this.t;
    const wrap = document.createElement("section");
    wrap.className = "info-panel-session";
    wrap.setAttribute("aria-labelledby", "info-panel-session-heading");

    const heading = document.createElement("h3");
    heading.className = "info-panel-title";
    heading.id = "info-panel-session-heading";
    heading.dataset.i18n = "sessionInfo.heading";
    heading.textContent = t("sessionInfo.heading");

    // Each row shows the actual value (truncated to one line, full value in
    // the tooltip) instead of hiding it behind an icon-only control -- an
    // icon with no label doesn't say what it does. The copy button stays a
    // separate control next to the value.
    const list = document.createElement("div");
    list.className = "info-panel-session-list";
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", t("sessionInfo.heading"));

    this.fileRow = this._sessionInfoRow({
      labelKey: "sessionInfo.file",
      copyKey: "sessionInfo.copyFile",
      field: "file",
    });
    this.idRow = this._sessionInfoRow({
      labelKey: "sessionInfo.id",
      copyKey: "sessionInfo.copyId",
      field: "id",
    });
    list.append(this.fileRow.row, this.idRow.row);

    wrap.append(heading, list);
    section.append(wrap);
    this._paintSessionInfo();
  }

  _sessionInfoRow({ labelKey, copyKey, field }) {
    return createSessionInfoRowDom({
      t: this.t,
      labelKey,
      copyKey,
      field,
      onCopy: (button) => void this._copySessionField(button),
    });
  }

  _paintSessionInfo() {
    const t = this.t;
    const file = describeSessionFile(this.sessionFilePath, t("sessionInfo.inMemory"));
    const id = describeSessionId(this.sessionId, t("sessionInfo.unavailable"));
    paintSessionInfoRowDom(this.fileRow, this.t, {
      labelKey: "sessionInfo.file",
      copyKey: "sessionInfo.copyFile",
      text: file.text,
      description: file.title || file.text,
      value: file.copyValue,
    });
    paintSessionInfoRowDom(this.idRow, this.t, {
      labelKey: "sessionInfo.id",
      copyKey: "sessionInfo.copyId",
      text: id.text,
      description: id.text,
      value: id.copyValue,
    });
  }

  async _copySessionField(button) {
    const defaultTitle = button._defaultLabel || this.t(button.dataset.copyActionKey);
    const defaultAriaLabel = button._defaultAriaLabel || defaultTitle;
    try {
      const result = this.writeText?.(button.dataset.copyValue || "");
      if (!result) throw new Error("Clipboard unavailable");
      await result;
      button.title = this.t("sessionInfo.copied");
      button.setAttribute("aria-label", this.t("sessionInfo.copied"));
    } catch {
      button.title = this.t("sessionInfo.copyFailed");
      button.setAttribute("aria-label", this.t("sessionInfo.copyFailed"));
    }
    setTimeout(() => {
      button.title = defaultTitle;
      button.setAttribute("aria-label", defaultAriaLabel);
    }, 1500);
  }

  async _copyPath() {
    if (!this.copyBtn) return;
    const copied = await this.actions.copyWorkspacePath();
    if (!copied) return;
    const copiedLabel = this.t("infoPanel.copied");
    const defaultLabel = this.t("infoPanel.copyPath");
    this.copyBtn.title = copiedLabel;
    this.copyBtn.setAttribute("aria-label", copiedLabel);
    clearTimeout(this._copiedTimer);
    this._copiedTimer = setTimeout(() => {
      this.copyBtn.title = defaultLabel;
      this.copyBtn.setAttribute("aria-label", defaultLabel);
    }, 1200);
  }

  /** Update the workspace path. */
  updateWorkspace(path) {
    this.workspacePath = path || "";
    if (this.pathEl) {
      this.pathEl.textContent = displayLocalPath(this.workspacePath) || "—";
      this.pathEl.title = this.workspacePath;
    }
  }

  /** Update Session Info (jsonl file path + session id). */
  updateSessionInfo({ filePath, sessionId } = {}) {
    const changed = this.sessionId !== (sessionId || "");
    this.sessionFilePath = filePath || "";
    this.sessionId = sessionId || "";
    // The task analysis describes the session that was active when it ran.
    if (changed) this.taskAnalysis?.resetHistory();
    this._paintSessionInfo();
  }

  // ── Session history ─────────────────────────────────────────────────────

  _renderHistory() {
    const t = this.t;
    const section = this.historySection;
    section.replaceChildren();

    const heading = document.createElement("div");
    heading.className = "info-panel-history-heading";
    const h3 = document.createElement("h3");
    h3.className = "info-panel-title";
    h3.id = "info-panel-history-heading";
    h3.dataset.i18n = "infoPanel.sessionHistory";
    h3.textContent = t("infoPanel.sessionHistory");
    const status = document.createElement("span");
    status.className = "info-panel-status";
    status.textContent = `● ${t("infoPanel.activePath")}`;
    heading.append(h3, status);

    this.treeScroll = document.createElement("div");
    this.treeScroll.className = "info-panel-tree-scroll";
    this.treeScroll.setAttribute("role", "tree");
    this.treeScroll.setAttribute("aria-labelledby", "info-panel-history-heading");

    section.append(heading, this.treeScroll);
    this._renderTree();
  }

  /** Replace the tree data (host-authoritative snapshot) and re-render. */
  updateTree({ entries, leafId } = {}) {
    this.entries = Array.isArray(entries) ? entries : [];
    this.leafId = leafId ?? null;
    this._rebuildTree();
  }

  _rebuildTree() {
    this.tree = buildSessionTree({ entries: this.entries, leafId: this.leafId });
    // Prune expand-state for branches that no longer exist.
    const alive = new Set();
    const collect = (rows) => {
      for (const row of rows) {
        if (row.kind === "branch") {
          alive.add(row.entryId);
          collect(row.rows);
        }
      }
    };
    collect(this.tree.rows);
    for (const id of [...this.expandedBranches]) {
      if (!alive.has(id)) this.expandedBranches.delete(id);
    }
    this._renderTree();
    if (this._pendingSelectedScroll && this.selectedEntryId) {
      this._pendingSelectedScroll = false;
      this.scrollToSelectedEntry();
    }
  }

  _renderTree() {
    if (!this.treeScroll) return;
    this.treeScroll.replaceChildren();
    const rows = this.tree?.rows ?? [];
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "info-panel-tree-empty";
      empty.textContent = this.t("infoPanel.empty");
      this.treeScroll.append(empty);
      return;
    }
    for (const row of rows) {
      this.treeScroll.append(
        row.kind === "branch" ? this._renderBranch(row) : this._nodeRowEl(row, true),
      );
    }
  }

  _nodeRowEl(row, topLevel = false) {
    return createInfoTreeNodeRow({
      row,
      topLevel,
      t: this.t,
      selectedEntryId: this.selectedEntryId,
      isStreaming: () => this.isStreaming(),
      onSelectEntry: (entryId) => this._scrollToMessage(entryId),
      onNavigateLeaf: (entryId) => this.onNavigateLeaf(entryId),
    });
  }

  /** Collapsed inactive branch: summary toggle + (expanded) subtree rows. */
  _renderBranch(branch) {
    return createInfoTreeBranchDom({
      branch,
      t: this.t,
      expandedBranches: this.expandedBranches,
      onToggleBranch: (branchId) => {
        if (this.expandedBranches.has(branchId)) {
          this.expandedBranches.delete(branchId);
        } else {
          this.expandedBranches.add(branchId);
        }
        this._renderTree();
      },
      renderNodeRow: (row) => this._nodeRowEl(row),
    });
  }

  selectEntry(entryId) {
    this.selectedEntryId = entryId == null ? null : String(entryId);
    const rows = this.treeScroll?.querySelectorAll(".info-panel-row") || [];
    for (const row of rows) {
      row.classList.toggle("selected", row.dataset.entryId === this.selectedEntryId);
    }
  }

  scrollToSelectedEntry() {
    if (!this.selectedEntryId || this.panel.classList.contains("hidden")) {
      this._pendingSelectedScroll = Boolean(this.selectedEntryId);
      return;
    }
    const row = this.treeScroll?.querySelector(
      `[data-entry-id="${escapeAttribute(this.selectedEntryId)}"]`,
    );
    if (!row) {
      this._pendingSelectedScroll = true;
      return;
    }
    this._pendingSelectedScroll = false;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  _scrollToMessage(entryId) {
    this.selectEntry(entryId);
    const safeId = escapeAttribute(entryId);
    const target = [...document.querySelectorAll(`[data-entry-id="${safeId}"]`)].find(
      (candidate) => !this.panel.contains(candidate),
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("info-panel-flash");
    target.addEventListener("animationend", () => target.classList.remove("info-panel-flash"), {
      once: true,
    });
  }
}
