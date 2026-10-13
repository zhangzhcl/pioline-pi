// ABOUTME: DOM builders for InfoPanel session info rows and session tree nodes/branches.

import { createIcon } from "../../icons.js";

export function escapeAttribute(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function roleName(t, row) {
  return row.role === "user" ? t("infoPanel.roleUser") : t("infoPanel.roleAssistant");
}

function previewFallback(t, row) {
  if (row.statusOnly) {
    return row.stopReason === "aborted" ? t("infoPanel.statusAborted") : t("infoPanel.statusError");
  }
  if (row.hasImages) return t("infoPanel.imageMessage");
  return "";
}

export function createSessionInfoRowDom({ t, labelKey, copyKey, field, onCopy }) {
  const row = document.createElement("div");
  row.className = "info-panel-session-row";

  const label = document.createElement("span");
  label.className = "info-panel-session-label";
  const labelText = document.createElement("span");
  labelText.className = "info-panel-session-label-text";
  labelText.dataset.i18n = labelKey;
  labelText.textContent = t(labelKey);
  label.append(labelText);
  label.title = t(labelKey);

  const value = document.createElement("span");
  value.className = "info-panel-session-value";
  value.dataset.sessionField = field;

  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "ui-icon-button ui-icon-button--xs ui-icon-button--ghost info-panel-session-copy";
  button.dataset.copySessionField = field;
  button.dataset.copyLabelKey = labelKey;
  button.dataset.copyActionKey = copyKey;
  button.append(createIcon("clipboard", { size: 13 }));
  button.addEventListener("click", () => {
    void onCopy(button);
  });

  row.append(label, value, button);
  return { row, value, button };
}

export function paintSessionInfoRowDom(entry, t, { labelKey, copyKey, text, description, value }) {
  if (!entry) return;
  entry.value.textContent = text;
  entry.value.title = description;
  const button = entry.button;
  button.dataset.copyValue = value;
  const label = `${t(labelKey)}: ${description} · ${t(copyKey)}`;
  button.title = t(copyKey);
  button.setAttribute("aria-label", label);
  button._defaultLabel = t(copyKey);
  button._defaultAriaLabel = label;
}

export function createInfoTreeNodeRow({
  t,
  row,
  topLevel = false,
  selectedEntryId,
  isStreaming,
  onSelectEntry,
  onNavigateLeaf,
}) {
  const el = document.createElement(row.isActive ? "button" : "div");
  el.className = "info-panel-row";
  if (topLevel) el.classList.add("info-panel-row-top");
  el.dataset.entryId = row.entryId;
  el.style.setProperty("--row-depth", String(row.depth));
  if (row.isActive) {
    el.type = "button";
    el.classList.add("active");
    el.setAttribute("role", "treeitem");
    el.setAttribute(
      "aria-label",
      `${roleName(t, row)}: ${row.previewText || previewFallback(t, row)}`,
    );
    el.addEventListener("click", () => {
      onSelectEntry(row.entryId);
    });
  } else {
    el.classList.add("inactive");
    el.setAttribute("role", "treeitem");
    el.setAttribute("aria-disabled", "true");
  }
  if (selectedEntryId === row.entryId) el.classList.add("selected");
  if (row.isCurrentLeaf) {
    el.classList.add("current-leaf");
    el.setAttribute("aria-current", "true");
  }

  const role = document.createElement("span");
  role.className = `info-panel-role ${row.role === "user" ? "user" : "assistant"}`;
  role.setAttribute("aria-hidden", "true");
  if (row.role === "user") {
    role.classList.add("info-panel-role-dot");
  } else {
    role.append(createIcon("sparkles", { size: 11, filled: true }));
  }

  const preview = document.createElement("span");
  preview.className = "info-panel-preview";
  preview.textContent = row.previewText || previewFallback(t, row);

  el.append(role, preview);

  if (!row.isActive && row.isFullLeaf) {
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "info-panel-resume";
    resume.textContent = t("infoPanel.resumeBranch");
    resume.setAttribute(
      "aria-label",
      `${t("infoPanel.resumeBranch")}: ${row.previewText || previewFallback(t, row)}`,
    );
    if (isStreaming()) {
      resume.disabled = true;
      resume.title = t("infoPanel.resumeStreamingBlocked");
    }
    resume.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!resume.disabled) onNavigateLeaf(row.entryId);
    });
    el.append(resume);
  }
  return el;
}

export function createInfoTreeBranchDom({
  t,
  branch,
  expandedBranches,
  onToggleBranch,
  renderNodeRow,
}) {
  const wrap = document.createElement("div");
  wrap.className = "info-panel-branch";
  wrap.dataset.branchId = branch.entryId;

  const expanded = expandedBranches.has(branch.entryId);
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "info-panel-branch-summary";
  summary.style.setProperty("--row-depth", String(branch.depth));
  summary.setAttribute("aria-expanded", String(expanded));
  summary.setAttribute(
    "aria-label",
    `${t("infoPanel.branch")} · ${t("infoPanel.turns", { count: branch.turnCount })}`,
  );
  const caret = document.createElement("span");
  caret.className = "info-panel-caret";
  caret.textContent = expanded ? "▾" : "▸";
  caret.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "info-panel-preview";
  text.textContent = `${t("infoPanel.branch")} · ${t("infoPanel.turns", { count: branch.turnCount })}`;
  summary.append(caret, text);
  summary.addEventListener("click", () => {
    onToggleBranch(branch.entryId);
  });
  wrap.append(summary);

  if (expanded) {
    const group = document.createElement("div");
    group.className = "info-panel-branch-group";
    group.setAttribute("role", "group");
    for (const row of branch.rows) {
      group.append(
        row.kind === "branch"
          ? createInfoTreeBranchDom({
              t,
              branch: row,
              expandedBranches,
              onToggleBranch,
              renderNodeRow,
            })
          : renderNodeRow(row),
      );
    }
    wrap.append(group);
  }
  return wrap;
}
