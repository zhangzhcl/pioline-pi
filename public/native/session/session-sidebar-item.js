// 会话侧边栏：单条会话条目、项目可见数量计算、展开/收起切换行与按项目分组纯函数。

import { t } from "../../i18n.js";
import { createIcon } from "../../icons.js";
import { showSessionContextMenu, startSessionRename } from "./session-sidebar-actions.js";
import { INITIAL_LIMIT, STEP } from "./session-sidebar-storage.js";

let sharedDomParser = null;

export function buildLegacySectionHeader(className, innerHtml) {
  const header = document.createElement("div");
  header.className = `project-header ${className}`;
  sharedDomParser ??= new DOMParser();
  const doc = sharedDomParser.parseFromString(innerHtml, "text/html");
  header.append(...doc.body.childNodes);
  return header;
}

export function buildSidebarSessionItem(
  sidebar,
  session,
  { showArchiveButton = true, showPinButton = true } = {},
) {
  const item = document.createElement("div");
  item.className = "session-item";
  item.dataset.sessionId = session.id;
  if (session.id === sidebar.activeSessionId) item.classList.add("active");
  if (sidebar.unread.has(session.id)) item.classList.add("unread");
  if (sidebar.streaming.has(session.id)) item.classList.add("streaming", "mirror-live");

  const title = session.name || session.firstMessage || t("sidebar.emptySession");
  const isArchived = sidebar.isArchived(session.id);
  const isPinned = sidebar.pinnedStore?.isSessionPinned(session.id) ?? false;
  const pinBtnLabel = isPinned ? t("sidebar.unpinSession") : t("sidebar.pinSession");
  const archiveBtnLabel = isArchived ? t("sidebar.unarchiveSession") : t("sidebar.archiveSession");

  const titleRow = document.createElement("div");
  titleRow.className = "session-title-row";
  const titleElement = document.createElement("div");
  titleElement.className = "session-title";
  titleElement.title = title;
  titleElement.textContent = title;
  titleRow.appendChild(titleElement);

  const actionSlot = document.createElement("span");
  actionSlot.className = "session-action-slot";
  titleRow.appendChild(actionSlot);
  item.appendChild(titleRow);

  item.addEventListener("click", () => sidebar.onSelect(session));
  item.addEventListener("contextmenu", (event) => showSessionContextMenu(sidebar, event, session));

  if (showPinButton && session.filePath) {
    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "session-pin-btn";
    pinBtn.title = pinBtnLabel;
    pinBtn.setAttribute("aria-label", pinBtnLabel);
    pinBtn.setAttribute("aria-pressed", String(isPinned));
    const pinIconWrap = document.createElement("span");
    pinIconWrap.className = "session-pin-icon";
    const pinGlyph = createIcon("pin", { size: 13 });
    if (pinGlyph) pinIconWrap.appendChild(pinGlyph);
    pinBtn.appendChild(pinIconWrap);
    pinBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (sidebar.pinnedStore?.isSessionPinned(session.id)) {
        sidebar.pinnedStore.unpinSession(session.id);
      } else {
        sidebar.pinnedStore.pinSession(session.id);
      }
      sidebar.render();
    });
    actionSlot.appendChild(pinBtn);
  }

  if (session.filePath) {
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "session-rename-btn";
    const renameLabel = t("sidebar.rename");
    renameBtn.title = renameLabel;
    renameBtn.setAttribute("aria-label", renameLabel);
    const renameIcon = createIcon("pencil", { size: 13 });
    if (renameIcon) renameBtn.appendChild(renameIcon);
    renameBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      startSessionRename(sidebar, session);
    });
    actionSlot.appendChild(renameBtn);
  }

  if (showArchiveButton) {
    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "session-archive-btn";
    archiveBtn.title = archiveBtnLabel;
    archiveBtn.setAttribute("aria-label", archiveBtnLabel);
    const archiveGlyph = createIcon("archive");
    if (archiveGlyph) archiveBtn.appendChild(archiveGlyph);
    archiveBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      sidebar.toggleArchived(session.id);
    });
    actionSlot.appendChild(archiveBtn);
  }

  return item;
}

function projectVisibleKey(project) {
  return project.path || project.name || "unknown";
}

export function getProjectVisibleCount(sidebar, project, totalCount) {
  const stored = sidebar._visibleCountsByProject.get(projectVisibleKey(project));
  if (typeof stored === "number" && Number.isFinite(stored)) {
    return Math.max(INITIAL_LIMIT, Math.min(totalCount, Math.floor(stored)));
  }
  return Math.min(totalCount, INITIAL_LIMIT);
}

export function setProjectVisibleCount(sidebar, project, count) {
  sidebar._visibleCountsByProject.set(projectVisibleKey(project), Math.max(INITIAL_LIMIT, count));
}

export function buildSidebarToggleRow(sidebar, project, visibleCount, totalCount) {
  const hasMore = visibleCount < totalCount;
  const canShowLess = visibleCount > INITIAL_LIMIT;
  if (!hasMore && !canShowLess) return null;
  const row = document.createElement("div");
  row.className = "project-sessions-toggle-row";
  if (hasMore) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "project-sessions-toggle";
    more.textContent = t("sidebar.showMore");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      setProjectVisibleCount(sidebar, project, visibleCount + STEP);
      sidebar.render();
    });
    row.appendChild(more);
  }
  if (canShowLess) {
    const less = document.createElement("button");
    less.type = "button";
    less.className = "project-sessions-toggle project-sessions-toggle-less";
    less.textContent = t("sidebar.showLess");
    less.addEventListener("click", (event) => {
      event.stopPropagation();
      setProjectVisibleCount(sidebar, project, Math.max(INITIAL_LIMIT, visibleCount - STEP));
      sidebar.render();
    });
    row.appendChild(less);
  }
  return row;
}

export function groupSessionsByProject(sessions) {
  const order = [];
  const byPath = new Map();
  for (const session of sessions) {
    const path = session.projectPath || "unknown";
    if (!byPath.has(path)) {
      byPath.set(path, {
        path,
        name: session.projectName || path,
        isCurrent: Boolean(session.isCurrentWorkspace),
        isRemote: false,
        isDefaultWorkspace: false,
        sessions: [],
      });
      order.push(path);
    }
    byPath.get(path).isRemote ||= Boolean(session.isRemote);
    byPath.get(path).isDefaultWorkspace ||= Boolean(session.isDefaultWorkspace);
    byPath.get(path).sessions.push(session);
  }
  return order.map((path) => byPath.get(path));
}
