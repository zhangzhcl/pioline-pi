// 会话侧边栏：上下文菜单、重命名、自动标题生成与归档/工作区会话批量删除操作。

import { t } from "../../i18n.js";
import { isSuperAgentProjectPath } from "../../super-agent/session.js";
import { bindDialogEscape } from "../../ui/dialog-escape.js";
import { randomId } from "../utils/random-id.js";
import { cssEscape, STORAGE, writeStorage } from "./session-sidebar-storage.js";

export function showSidebarConfirmDialog({ message, ariaLabel }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "sidebar-confirm-overlay";
    const dialog = document.createElement("div");
    dialog.className = "sidebar-confirm-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", ariaLabel);
    const msgEl = document.createElement("div");
    msgEl.className = "sidebar-confirm-message";
    msgEl.textContent = message;
    dialog.appendChild(msgEl);
    const actions = document.createElement("div");
    actions.className = "sidebar-confirm-actions";
    const noBtn = document.createElement("button");
    noBtn.type = "button";
    noBtn.className = "sidebar-confirm-no";
    noBtn.textContent = t("dialogs.cancel");
    const yesBtn = document.createElement("button");
    yesBtn.type = "button";
    yesBtn.className = "sidebar-confirm-yes";
    yesBtn.textContent = t("sidebar.deleteSession");
    actions.append(noBtn, yesBtn);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    let unbindEscape = () => {};
    function cleanup(result) {
      unbindEscape();
      overlay.remove();
      resolve(result);
    }
    unbindEscape = bindDialogEscape(() => cleanup(false));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) cleanup(false);
    });
    overlay.querySelector(".sidebar-confirm-no").addEventListener("click", () => cleanup(false));
    overlay.querySelector(".sidebar-confirm-yes").addEventListener("click", () => cleanup(true));
    document.body.appendChild(overlay);
  });
}

export async function deleteWorkspaceSessionsBatch(sidebar, project) {
  if (!sidebar.control) return;
  const deletable = sidebar.sessions
    .filter(
      (session) =>
        session.projectPath === project?.path && !isSuperAgentProjectPath(session.projectPath),
    )
    .map((session) => session.id)
    .filter(
      (id) =>
        typeof id === "string" &&
        id &&
        id !== sidebar.activeSessionId &&
        !sidebar.streaming.has(id),
    );
  if (deletable.length === 0) return;
  const ok = await showSidebarConfirmDialog({
    message: t("sidebar.deleteWorkspaceConfirm", { count: deletable.length }),
    ariaLabel: t("sidebar.deleteWorkspaceSessions"),
  });
  if (!ok) return;
  try {
    const { deleted } = await sidebar.control.deleteSessions(deletable);
    const deletedSet = new Set(deleted || []);
    if (deletedSet.size === 0) return;
    for (const id of deletable) {
      if (deletedSet.has(id)) sidebar.pinnedStore?.unpinSession(id);
    }
    sidebar.archived = sidebar.archived.filter((id) => !deletedSet.has(id));
    writeStorage(STORAGE.archived, JSON.stringify(sidebar.archived));
    sidebar.sessions = sidebar.sessions.filter((session) => !deletedSet.has(session.id));
    sidebar.render();
  } catch (error) {
    console.error("[Sidebar] deleteWorkspaceSessions failed:", error);
  }
}

export async function deleteAllArchivedBatch(sidebar) {
  const ids = [...sidebar.archived];
  if (ids.length === 0 || !sidebar.control) return;
  const message = `Delete ${ids.length} archived session${ids.length === 1 ? "" : "s"} permanently? This cannot be undone.`;
  const ok = await showSidebarConfirmDialog({
    message,
    ariaLabel: "Delete archived sessions",
  });
  if (!ok) return;
  try {
    const { deleted } = await sidebar.control.deleteSessions(ids);
    const deletedSet = new Set(deleted);
    sidebar.archived = sidebar.archived.filter((id) => !deletedSet.has(id));
    writeStorage(STORAGE.archived, JSON.stringify(sidebar.archived));
    sidebar.sessions = sidebar.sessions.filter((session) => !deletedSet.has(session.id));
    sidebar.render();
  } catch (error) {
    console.error("[Sidebar] deleteAllArchived failed:", error);
  }
}

export function showSidebarMenu(sidebar, event, rows) {
  sidebar.closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "session-context-menu";

  for (const entry of rows) {
    if (entry.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement("div");
    row.className = "context-menu-item";
    row.textContent = entry.label;
    row.addEventListener("click", (ev) => {
      ev.stopPropagation();
      sidebar.closeContextMenu();
      entry.action();
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  let x = event.clientX;
  let y = event.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  sidebar.contextMenu = menu;
}

export function showSessionContextMenu(sidebar, event, session) {
  event.preventDefault();
  const isPinned = sidebar.pinnedStore?.isSessionPinned(session.id) ?? false;
  const workspacePinned = session.projectPath
    ? (sidebar.pinnedStore?.isWorkspacePinned(session.projectPath) ?? false)
    : false;
  const rows = [
    {
      label: sidebar.isFavourite(session.id) ? t("sidebar.unfavourite") : t("sidebar.favourite"),
      action: () => sidebar.toggleFavourite(session.id),
    },
    {
      label: sidebar.isArchived(session.id) ? t("sidebar.unarchive") : t("sidebar.archive"),
      action: () => sidebar.toggleArchived(session.id),
    },
  ];
  if (session.id === sidebar.activeSessionId) {
    rows.push({
      label: t("sidebar.generateTitle"),
      action: () => void generateSessionTitle(sidebar, session),
    });
  }
  if (session.filePath && !workspacePinned) {
    rows.push({ separator: true });
    rows.push({
      label: isPinned ? t("sidebar.unpinSession") : t("sidebar.pinSession"),
      action: () => {
        if (isPinned) {
          sidebar.pinnedStore.unpinSession(session.id);
        } else {
          sidebar.pinnedStore.pinSession(session.id);
        }
        sidebar.render();
      },
    });
    rows.push({
      label: t("sidebar.rename"),
      action: () => startSessionRename(sidebar, session),
    });
  } else if (session.filePath) {
    rows.push({ separator: true });
    rows.push({
      label: t("sidebar.rename"),
      action: () => startSessionRename(sidebar, session),
    });
  }
  showSidebarMenu(sidebar, event, rows);
}

export function showProjectContextMenu(sidebar, event, project) {
  event.preventDefault();
  const isWorkspacePinned = sidebar.pinnedStore?.isWorkspacePinned(project.path) ?? false;
  const rows = [
    {
      label: t("sidebar.archiveWorkspaceSessions"),
      action: () => sidebar.archiveProject(project),
    },
    { separator: true },
    {
      label: isWorkspacePinned ? t("sidebar.unpinWorkspace") : t("sidebar.pinWorkspace"),
      action: () => {
        if (isWorkspacePinned) {
          sidebar.pinnedStore.unpinWorkspace(project.path);
        } else {
          sidebar.pinnedStore.pinWorkspace(project.path, project.path);
        }
        sidebar.render();
      },
    },
    { separator: true },
    {
      label: t("sidebar.deleteWorkspaceSessions"),
      action: () => sidebar.deleteWorkspaceSessions(project),
    },
  ];
  showSidebarMenu(sidebar, event, rows);
}

export async function generateSessionTitle(sidebar, session, target = sidebar.getTarget()) {
  if (!sidebar.config) return false;
  const item = sidebar.container.querySelector(
    `.session-item[data-session-id="${cssEscape(session.id)}"]`,
  );
  const titleEl = item?.querySelector(".session-title");
  const previousTitle = titleEl?.textContent || session.name || "";
  if (titleEl) titleEl.textContent = t("sidebar.generatingTitle");

  try {
    const result = await sidebar.config.call(
      "generate_session_title",
      {},
      { timeoutMs: 100_000, target },
    );
    const title = result?.data?.title?.trim();
    if (!result?.ok || !title) throw new Error(result?.error || t("sidebar.generateTitleError"));
    await sidebar.runtime.request({ type: "set_session_name", name: title }, target, {
      idempotencyKey: randomId(),
    });
    session.name = title;
    if (titleEl) {
      titleEl.textContent = title;
      titleEl.title = title;
    }
    return true;
  } catch (error) {
    if (titleEl) titleEl.textContent = previousTitle;
    console.error("[Sidebar] Generate title failed:", error);
    return false;
  }
}

export function startSessionRename(sidebar, session) {
  const item = sidebar.container.querySelector(
    `.session-item[data-session-id="${cssEscape(session.id)}"]`,
  );
  const titleEl = item?.querySelector(".session-title");
  if (!titleEl) return;
  const current = titleEl.textContent;
  const input = document.createElement("input");
  input.className = "session-rename-input";
  input.value = current;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const name = input.value.trim();
    if (name && name !== current) {
      try {
        if (session.id === sidebar.activeSessionId) {
          await sidebar.runtime.request({ type: "set_session_name", name }, sidebar.getTarget(), {
            idempotencyKey: randomId(),
          });
        } else {
          const result = await sidebar.config.call("rename_historical_session", {
            filePath: session.filePath,
            name,
          });
          if (!result?.ok) throw new Error(result?.error || "Session rename failed");
        }
        for (const candidate of sidebar.sessions) {
          if (candidate.filePath === session.filePath) candidate.name = name;
        }
        session.name = name;
        void sidebar.load({ quiet: true });
      } catch (error) {
        console.error("[Sidebar] Rename failed:", error);
      }
    }
    const el = document.createElement("div");
    el.className = "session-title";
    el.title = name || current;
    el.textContent = name || current;
    input.replaceWith(el);
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    } else if (event.key === "Escape") {
      input.value = current;
      input.blur();
    }
  });
}
