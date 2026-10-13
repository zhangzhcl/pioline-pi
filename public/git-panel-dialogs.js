// Git 面板模态对话框（放弃更改确认、提交弹窗）与目录树构造/渲染逻辑。

import { createFileTypeIcon } from "./file-type-icons.js";
import { t } from "./i18n.js";
import { setButtonIcon } from "./icons.js";
import { bindDialogEscape } from "./ui/dialog-escape.js";

function createToolbarIconButton({ className, icon, label, variant, disabled = false, onClick }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ui-icon-button ui-icon-button--sm ${variant} ${className}`;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.disabled = disabled;
  setButtonIcon(button, icon, { size: 14 });
  button.addEventListener("click", onClick);
  return button;
}

export function createGitPanelToolbar({ snapshot, pushError, pushInProgress, onPush, onAiCommit }) {
  const toolbar = document.createElement("header");
  toolbar.className = "git-panel-toolbar";
  const details = document.createElement("div");
  details.className = "git-panel-details";
  const summary = document.createElement("p");
  summary.className = "git-panel-summary";
  const branch = snapshot.branch || snapshot.headState || "";
  const upstream = snapshot.upstream || t("git.noUpstream");
  summary.textContent = t("git.summary", {
    branch,
    upstream,
    ahead: snapshot.ahead || 0,
    behind: snapshot.behind || 0,
  });
  details.append(summary);
  const stats = document.createElement("p");
  stats.className = "git-panel-stats";
  stats.textContent = t("git.stats", {
    staged: snapshot.counts?.staged || 0,
    changes: snapshot.counts?.changes || 0,
    untracked: snapshot.counts?.untracked || 0,
    additions: snapshot.changeStats?.additions || 0,
    deletions: snapshot.changeStats?.deletions || 0,
    untrackedExcluded: snapshot.changeStats?.untrackedExcludedCount || 0,
    binary: snapshot.changeStats?.binaryFileCount || 0,
  });
  details.append(stats);
  if (pushError) {
    const pushErrorEl = document.createElement("p");
    pushErrorEl.className = "git-panel-push-error";
    pushErrorEl.setAttribute("role", "alert");
    pushErrorEl.textContent = pushError;
    details.append(pushErrorEl);
  }
  toolbar.append(details);
  const actions = document.createElement("div");
  actions.className = "git-panel-toolbar-actions";
  actions.append(
    createToolbarIconButton({
      className: "git-panel-push",
      icon: "arrow-up",
      label: pushInProgress ? t("git.pushing") : t("git.push"),
      variant: "ui-icon-button--ghost",
      disabled: pushInProgress || !snapshot.branch,
      onClick: onPush,
    }),
    createToolbarIconButton({
      className: "git-panel-commit",
      icon: "sparkles",
      label: t("git.aiCommitMessage"),
      variant: "ui-icon-button--primary",
      disabled: snapshot.counts?.staged === 0 || snapshot.counts?.conflicted > 0,
      onClick: onAiCommit,
    }),
  );
  toolbar.append(actions);
  return toolbar;
}

export function confirmDiscardDialog(count) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "git-confirm-dialog-overlay";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    const dialog = document.createElement("div");
    dialog.className = "git-confirm-dialog";
    const message = document.createElement("p");
    message.className = "git-confirm-message";
    message.textContent = t("git.discardConfirm", { count });
    dialog.append(message);
    const actions = document.createElement("div");
    actions.className = "git-confirm-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = t("git.cancel");
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = t("git.discard");
    confirm.className = "git-confirm-discard";
    actions.append(cancel, confirm);
    dialog.append(actions);
    overlay.append(dialog);
    overlay.addEventListener("click", () => {
      // 模态框：不允许点击遮罩关闭，用户必须显式取消或确认。
    });
    let unbindEscape = () => {};
    const finish = (result) => {
      unbindEscape();
      overlay.remove();
      resolve(result);
    };
    unbindEscape = bindDialogEscape(() => finish(false));
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    document.body.append(overlay);
    confirm.focus();
  });
}

export function createCommitDialog({
  aiError,
  pendingConfirmationToken,
  commitMessage,
  onInput,
  onCancel,
  onSubmit,
}) {
  const overlay = document.createElement("div");
  overlay.className = "git-commit-dialog-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "git-commit-dialog-title");
  const dialog = document.createElement("div");
  dialog.className = "git-commit-dialog";
  const title = document.createElement("h3");
  title.id = "git-commit-dialog-title";
  title.textContent = t("git.commit");
  dialog.append(title);
  if (aiError) {
    const error = document.createElement("p");
    error.className = "git-commit-error";
    error.textContent = aiError;
    dialog.append(error);
  }
  if (pendingConfirmationToken) {
    const notice = document.createElement("p");
    notice.className = "git-commit-confirmation";
    notice.textContent = t("git.confirmationRequired");
    dialog.append(notice);
  }
  const textarea = document.createElement("textarea");
  textarea.className = "git-commit-textarea";
  textarea.value = commitMessage || "";
  textarea.setAttribute("aria-label", t("git.commitMessageLabel"));
  textarea.rows = 6;
  textarea.addEventListener("input", () => {
    onInput(textarea.value);
  });
  dialog.append(textarea);
  const actions = document.createElement("div");
  actions.className = "git-commit-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("git.cancel");
  cancel.addEventListener("click", onCancel);
  const submit = document.createElement("button");
  submit.type = "button";
  submit.textContent = t("git.commit");
  submit.className = "git-commit-submit";
  submit.addEventListener("click", () => {
    onSubmit(textarea.value);
  });
  actions.append(cancel, submit);
  dialog.append(actions);
  overlay.append(dialog);
  overlay.addEventListener("click", () => {
    // 模态框：不允许点击遮罩关闭。
  });
  document.body.append(overlay);
  const handle = {
    overlay,
    textarea,
    submit,
    unbindEscape: bindDialogEscape(onCancel),
  };
  textarea.focus();
  return handle;
}

export function buildGitTree(entries) {
  const root = { dirs: new Map(), files: [] };
  for (const entry of entries) {
    const path = entry.displayPath || "";
    const parts = path.split(/[/\\]/).filter(Boolean);
    if (parts.length <= 1) {
      root.files.push(entry);
      continue;
    }
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const segment = parts[i];
      let child = node.dirs.get(segment);
      if (!child) {
        child = {
          dirs: new Map(),
          files: [],
          prefix: parts.slice(0, i + 1).join("/"),
        };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.push(entry);
  }
  return root;
}

export function countGitTreeFiles(node) {
  let count = node.files.length;
  for (const child of node.dirs.values()) count += countGitTreeFiles(child);
  return count;
}

export function groupsForGitEntry(entry) {
  if (entry.entryKind === "unmerged") return ["conflicted"];
  if (entry.entryKind === "untracked") return ["untracked"];
  const groups = [];
  if (entry.xy?.[0] && entry.xy[0] !== ".") groups.push("staged");
  if (entry.xy?.[1] && entry.xy[1] !== ".") groups.push("changes");
  return groups.length > 0 ? groups : ["changes"];
}

export function renderGitTree({ panel, node, container, snapshot, group, prefix }) {
  for (const [segment, child] of node.dirs) {
    const dirKey = `dir:${group}:${child.prefix}`;
    const dirSection = document.createElement("div");
    dirSection.className = "git-directory";
    const dirHeading = document.createElement("button");
    dirHeading.type = "button";
    dirHeading.className = "git-directory-heading git-tree-row";
    if (panel.folded.has(dirKey)) dirHeading.classList.add("collapsed");
    const fileCount = panel.countFiles(child);
    const icon = document.createElement("span");
    icon.className = "git-tree-folder-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.append(
      createFileTypeIcon({
        name: segment,
        isDirectory: true,
        expanded: !panel.folded.has(dirKey),
      }),
    );
    const label = document.createElement("span");
    label.className = "git-tree-label";
    label.textContent = `${prefix ? `${prefix}/` : ""}${segment}`;
    const count = document.createElement("span");
    count.className = "git-tree-count";
    count.textContent = String(fileCount);
    dirHeading.append(icon, label, count);
    dirHeading.setAttribute("aria-expanded", String(!panel.folded.has(dirKey)));
    dirHeading.addEventListener("click", () => {
      panel.folded.has(dirKey) ? panel.folded.delete(dirKey) : panel.folded.add(dirKey);
      panel.render();
    });
    dirSection.append(dirHeading);
    if (!panel.folded.has(dirKey)) {
      const dirBody = document.createElement("div");
      dirBody.className = "git-directory-body";
      panel.renderTree(child, dirBody, snapshot, group, `${prefix ? `${prefix}/` : ""}${segment}`);
      dirSection.append(dirBody);
    }
    container.append(dirSection);
  }
  for (const entry of node.files) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "git-entry git-tree-row";
    const fileName = entry.displayPath.split(/[/\\]/).pop() || entry.displayPath;
    const icon = document.createElement("span");
    icon.className = "git-tree-file-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.append(createFileTypeIcon({ name: fileName }));
    const label = document.createElement("span");
    label.className = "git-tree-label";
    label.textContent = fileName;
    row.append(icon, label);
    row.setAttribute("aria-label", entry.displayPath);
    row.title = entry.displayPath;
    const identity = `${snapshot.snapshotId}:${group}:${entry.pathBytesBase64}`;
    if (panel.selected.has(identity)) {
      row.classList.add("git-entry-selected");
      row.setAttribute("aria-pressed", "true");
    }
    row.addEventListener("click", (event) => {
      if (group === "conflicted") return;
      if (event.shiftKey) {
        panel.selected.has(identity)
          ? panel.selected.delete(identity)
          : panel.selected.add(identity);
        panel.render();
        return;
      }
      const comparison =
        group === "staged" ? "staged" : group === "untracked" ? "untracked" : "changes";
      const requestId = panel.client?.diff?.(
        snapshot.snapshotId,
        group,
        entry.pathBytesBase64,
        comparison,
      );
      if (requestId) panel.onDiffRequest?.(requestId, { ...entry, comparison });
      else panel.openDiff?.({ ...entry, comparison });
    });
    container.append(row);
  }
}
