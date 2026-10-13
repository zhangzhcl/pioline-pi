// SuperAgentRuntime 任务卡片 HTML 构建与文本格式化辅助函数。

import { t } from "../i18n.js";

export function isDispatchableProjectPath(path) {
  const normalized = String(path || "").replace(/\/+$/, "");
  return normalized.includes("/") && !normalized.endsWith("/.pi/agent/super-agent");
}

export function sourceHtml(task) {
  if (!task.source || task.source.channel === "local") return "";
  return `<div class="runtime-task-source">${esc(t("inbox.source", { channel: task.source.channel }))}</div>`;
}

export function formatTaskDescription(description) {
  const lines = normalizeTaskDescription(description);
  if (lines.length === 0) return "";

  return lines
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading) {
        return `<div class="runtime-task-section-title">${renderTaskInline(heading[1])}</div>`;
      }

      const bullet = line.match(/^[-*]\s+(.+)$/);
      if (bullet) {
        return `<div class="runtime-task-list-item">${renderTaskInline(bullet[1])}</div>`;
      }

      const numbered = line.match(/^\d+\.\s+(.+)$/);
      if (numbered) {
        return `<div class="runtime-task-list-item">${renderTaskInline(numbered[1])}</div>`;
      }

      return `<div class="runtime-task-paragraph">${renderTaskInline(line)}</div>`;
    })
    .join("");
}

export function normalizeTaskDescription(description) {
  return String(description ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+(#{1,6})\s+/g, "\n$1 ")
    .replace(/[ \t]+[-*]\s+(?=(?:\p{Extended_Pictographic}|\*\*|\[|[A-Z0-9]))/gu, "\n- ")
    .replace(/[ \t]+(\d+)\.\s+/g, "\n$1. ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function renderTaskInline(text) {
  return esc(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

export function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escAttr(str) {
  return esc(str);
}

export function isTypingTarget(target) {
  return Boolean(
    target?.closest?.(
      "input, textarea, select, [contenteditable='true'], [role='combobox'], .ui-select-popover",
    ),
  );
}

export function formatHistoryTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function renderQuickActionsHtml(task) {
  const actions = [];
  if (task.status === "pending") {
    actions.push(
      `<button class="sa-btn" data-action="prompt-task" data-task-id="${escAttr(task.id)}" type="button">${esc(t("inbox.promptAi"))}</button>`,
    );
    if (isDispatchableProjectPath(task.targetProject)) {
      actions.push(
        `<button class="sa-btn sa-btn-approve" data-action="approve" data-task-id="${escAttr(task.id)}" type="button">${esc(t("inbox.approve"))}</button>`,
      );
    }
    actions.push(
      `<button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${escAttr(task.id)}" type="button">${esc(t("inbox.dismiss"))}</button>`,
    );
  } else if (task.status === "done") {
    actions.push(
      `<button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${escAttr(task.id)}" type="button">${esc(t("inbox.clear"))}</button>`,
    );
  }
  if (actions.length === 0) return "";
  return `<span class="runtime-quick-actions">${actions.join("")}</span>`;
}

export function renderHistoryHtml(task, historyTaskIds) {
  if (!Array.isArray(task.events) || task.events.length === 0) return "";
  const open = historyTaskIds.has(task.id);
  const items = open
    ? `<div class="runtime-task-history-list">
        ${task.events
          .map(
            (event) => `<div class="runtime-task-history-item">
              <span>${esc(formatHistoryTimestamp(event.at))}</span>
              <strong>${esc(event.type || event.status || "event")}</strong>
              <p>${esc(event.message || event.status || "")}</p>
            </div>`,
          )
          .join("")}
      </div>`
    : "";
  return `<div class="runtime-task-history">
    <button class="sa-btn" data-action="toggle-history" data-task-id="${escAttr(task.id)}" type="button">${esc(t("inbox.history"))}</button>
    ${items}
  </div>`;
}

export function renderProjectPickerHtml(task, projects, projectsLoadedOnce) {
  const targetProject = String(task.targetProject || "");
  const projectOptions = [...projects];
  if (targetProject && !projectOptions.some((project) => project.cwd === targetProject)) {
    projectOptions.unshift({
      name: targetProject.split("/").pop() || targetProject,
      cwd: targetProject,
      status: "unknown",
    });
  }
  const options = [
    `<option value="">${esc(t("inbox.chooseProject"))}</option>`,
    ...projectOptions.map((project) => {
      const selected = project.cwd === targetProject ? " selected" : "";
      const label =
        project.status === "running"
          ? t("inbox.projectRunning", { name: project.name || project.cwd })
          : project.name || project.cwd;
      return `<option value="${escAttr(project.cwd)}"${selected}>${esc(label)}</option>`;
    }),
  ].join("");
  const hint = targetProject
    ? t("inbox.project", { name: targetProject.split("/").pop() || targetProject })
    : projectsLoadedOnce
      ? t("inbox.chooseProjectBeforeApproval")
      : t("inbox.loadingProjects");
  return `
    <label class="runtime-project-picker">
      <span>${esc(hint)}</span>
      <select
        class="ui-select ui-select--sm runtime-project-select"
        data-action="select-project"
        data-task-id="${escAttr(task.id)}"
        aria-label="${escAttr(t("inbox.chooseProject"))}"
      >
        ${options}
      </select>
    </label>`;
}

export function renderTaskCardShell(task, body, isExpanded = true) {
  return `<div class="runtime-task-card status-${esc(task.status)} ${isExpanded ? "is-expanded" : "is-collapsed"}"
    data-task-id="${escAttr(task.id)}" role="button" tabindex="0" aria-expanded="${isExpanded}">
    <div class="runtime-task-header">
      <span class="runtime-status-dot"></span>
      <span class="runtime-task-title">${esc(task.title || t("inbox.untitled"))}</span>
      ${renderQuickActionsHtml(task)}
      <span class="runtime-task-expand-icon" aria-hidden="true"></span>
    </div>
    ${body}
  </div>`;
}

export function renderTaskCardHtml({
  task,
  expandedTaskIds,
  historyTaskIds,
  projects,
  projectsLoadedOnce,
}) {
  const isExpanded = expandedTaskIds.has(task.id);
  const hasTargetProject = isDispatchableProjectPath(task.targetProject);
  const projectName = task.targetProject?.split("/").pop() || "";
  let body = "";

  if (isExpanded) {
    if (task.description) {
      body += `<div class="runtime-task-desc">${formatTaskDescription(task.description)}</div>`;
    }
    body += sourceHtml(task);

    if (task.status === "pending") {
      body += renderProjectPickerHtml(task, projects, projectsLoadedOnce);
      body += `
        <div class="runtime-approve-row">
          <button class="sa-btn" data-action="prompt-task" data-task-id="${escAttr(task.id)}">${esc(t("inbox.promptAi"))}</button>
          ${
            hasTargetProject
              ? `<button class="sa-btn sa-btn-approve" data-action="approve" data-task-id="${escAttr(task.id)}">${esc(t("inbox.approve"))}</button>`
              : ""
          }
          <button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${escAttr(task.id)}">✕</button>
        </div>`;
    } else if (task.status === "done" || task.status === "running") {
      if (hasTargetProject) {
        body += `<div class="runtime-task-target">${esc(t("inbox.target", { name: projectName }))}</div>`;
      }
      if (task.dispatch?.childSessionId || task.dispatch?.childPort) {
        const canOpen = Boolean(task.dispatch?.childSessionId);
        body += `<div class="runtime-approve-row">
          <button class="sa-btn" data-action="view-session" data-task-id="${escAttr(task.id)}" ${canOpen ? "" : `disabled title="${escAttr(t("inbox.waitingForSession"))}"`}>${esc(t("inbox.viewSession"))}</button>
          ${task.status === "running" ? `<button class="sa-btn sa-btn-dismiss" data-action="force-cancel" data-task-id="${escAttr(task.id)}">${esc(t("inbox.forceCancel"))}</button>` : ""}
        </div>`;
      } else if (task.status === "running") {
        body += `<div class="runtime-approve-row">
          <button class="sa-btn sa-btn-dismiss" data-action="force-cancel" data-task-id="${escAttr(task.id)}">${esc(t("inbox.forceCancel"))}</button>
        </div>`;
      }
    } else if (
      task.status === "failed" ||
      task.status === "blocked" ||
      task.status === "needs_input"
    ) {
      body += `<div class="runtime-task-error">${esc(task.result?.failReason || task.failReason || t("inbox.waitingForInput"))}</div>`;
      if (hasTargetProject) {
        body += `<div class="runtime-task-target">${esc(t("inbox.project", { name: projectName }))}</div>`;
        body += `
          <div class="runtime-approve-row">
            <button class="sa-btn sa-btn-approve" data-action="retry" data-task-id="${escAttr(task.id)}">${esc(t("inbox.retry"))}</button>
            <button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${escAttr(task.id)}">${esc(t("inbox.dismiss"))}</button>
          </div>`;
      } else {
        body += `
          <div class="runtime-task-missing-target">${esc(t("inbox.chooseProjectWhenCreating"))}</div>
          <div class="runtime-approve-row">
            <button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${escAttr(task.id)}">${esc(t("inbox.dismiss"))}</button>
          </div>`;
      }
    }
    body += renderHistoryHtml(task, historyTaskIds);
  }

  return renderTaskCardShell(task, body, isExpanded);
}
