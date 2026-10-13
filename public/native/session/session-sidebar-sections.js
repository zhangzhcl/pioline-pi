// 会话侧边栏：默认会话分组、置顶分组、项目分组与归档分组 DOM 构建。

import { t } from "../../i18n.js";
import { createIcon } from "../../icons.js";
import {
  buildSidebarSection,
  buildSidebarWorkspaceGroup,
  createRemoteBadge,
} from "../../sidebar-workspace-group.js";
import { isProjectDisconnected } from "../workspace/project-connection-status.js";
import { showProjectContextMenu } from "./session-sidebar-actions.js";
import {
  buildLegacySectionHeader,
  buildSidebarSessionItem,
  buildSidebarToggleRow,
  getProjectVisibleCount,
  groupSessionsByProject,
} from "./session-sidebar-item.js";
import {
  escapeHtml,
  STORAGE,
  workspaceFolderName,
  writeStorage,
} from "./session-sidebar-storage.js";

function createDefaultWorkspaceSession(sidebar) {
  const invoke = globalThis.__TAURI__?.core?.invoke ?? null;
  if (invoke) {
    invoke("open_new_session_in_workspace", { projectPath: "" }).catch((error) =>
      console.error("[Sidebar] Failed to start new chat:", error),
    );
    return;
  }
  sidebar.onCreateSession?.("default");
}

export function renderDefaultWorkspaceSection(sidebar, defaultWorkspaceSessions) {
  const defaultProject = {
    path: "__default-workspace__",
    name: t("sidebar.sessionList"),
    isCurrent: defaultWorkspaceSessions.some(
      (session) => session.isCurrentWorkspace || !session.projectPath,
    ),
    isDefaultWorkspace: true,
    sessions: defaultWorkspaceSessions,
  };
  const canCreateDefaultSession = Boolean(
    globalThis.__TAURI__?.core?.invoke || sidebar.onCreateSession,
  );
  const { section } = buildSidebarSection({
    region: "sessions",
    titleKey: "sidebar.sessionList",
    count: defaultWorkspaceSessions.length || null,
    expanded: !sidebar.sessionsCollapsed,
    onToggle: (expanded) => {
      sidebar.sessionsCollapsed = !expanded;
      writeStorage(STORAGE.sessionsCollapsed, String(sidebar.sessionsCollapsed));
    },
    renderHeaderActions: (header) => {
      if (!canCreateDefaultSession) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "project-new-chat-btn";
      button.title = t("sidebar.startNewChat");
      button.setAttribute("aria-label", t("sidebar.startNewChat"));
      button.textContent = "+";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        createDefaultWorkspaceSession(sidebar);
      });
      header.appendChild(button);
    },
    renderSessions: (body) => {
      if (defaultWorkspaceSessions.length === 0) {
        const empty = document.createElement("div");
        empty.className = "session-loading";
        empty.textContent = t("sidebar.noSavedSessions");
        body.appendChild(empty);
        return;
      }
      const visibleCount = getProjectVisibleCount(
        sidebar,
        defaultProject,
        defaultWorkspaceSessions.length,
      );
      const visible = sidebar.searchQuery
        ? defaultWorkspaceSessions
        : defaultWorkspaceSessions.slice(0, visibleCount);
      for (const session of visible) {
        body.appendChild(buildSidebarSessionItem(sidebar, session));
      }
      if (!sidebar.searchQuery) {
        const toggle = buildSidebarToggleRow(
          sidebar,
          defaultProject,
          visible.length,
          defaultWorkspaceSessions.length,
        );
        if (toggle) body.appendChild(toggle);
      }
    },
  });
  section.classList.add("sessions-group");
  sidebar.container.appendChild(section);
}

export function renderPinnedSidebarSection(sidebar, pinState) {
  const byPath = new Map();
  for (const session of sidebar.sessions) {
    if (!session.projectPath) continue;
    if (!byPath.has(session.projectPath)) byPath.set(session.projectPath, []);
    byPath.get(session.projectPath).push(session);
  }

  const pinnedGroups = [];
  for (const ws of pinState.workspaces) {
    const sessions = (byPath.get(ws.path) || []).filter((s) => !sidebar.isArchived(s.id));
    pinnedGroups.push({
      workspacePin: true,
      unavailable: sessions.length === 0,
      isRemote: sessions.some((s) => s.isRemote),
      workspace: {
        path: ws.path,
        folderName: workspaceFolderName(ws.path, sessions[0]?.projectName),
      },
      sessions,
    });
  }
  for (const id of pinState.sessions) {
    const session = sidebar.sessions.find((s) => s.id === id);
    if (!session || sidebar.isArchived(session.id)) {
      pinnedGroups.push({
        workspacePin: false,
        unavailable: true,
        workspace: null,
        sessions: [{ id }],
      });
    } else if (!pinState.workspaces.some((w) => w.path === session.projectPath)) {
      pinnedGroups.push({
        workspacePin: false,
        unavailable: false,
        isRemote: Boolean(session.isRemote),
        workspace: {
          path: session.projectPath,
          folderName: workspaceFolderName(session.projectPath, session.projectName),
        },
        sessions: [session],
      });
    }
  }

  if (pinnedGroups.length === 0) return;

  const { section } = buildSidebarSection({
    region: "pinned",
    titleKey: "sidebar.pinned",
    count: pinnedGroups.length,
    expanded: !sidebar.pinnedCollapsed,
    onToggle: (expanded) => {
      sidebar.pinnedCollapsed = !expanded;
    },
    renderSessions: (body) => {
      for (const pinned of pinnedGroups) {
        const ws = pinned.workspace;
        const workspaceId = ws?.path || `pinned-session:${pinned.sessions[0]?.id || ""}`;
        const invoke = globalThis.__TAURI__?.core?.invoke ?? null;
        const canCreateSession = Boolean(ws && !pinned.unavailable && invoke);
        const { group } = buildSidebarWorkspaceGroup({
          workspaceId,
          folderName: ws?.folderName || t("sidebar.unavailable"),
          workspacePath: ws?.path || "",
          isRemote: Boolean(pinned.isRemote),
          isDisconnected: isProjectDisconnected(ws?.path),
          sessionCount: pinned.sessions.length,
          expanded: true,
          onNewChat: canCreateSession
            ? () => {
                invoke("open_new_session_in_workspace", { projectPath: ws.path }).catch((error) => {
                  console.error("[Sidebar] Failed to start new chat:", error);
                });
              }
            : null,
          onMoreActions: pinned.workspacePin
            ? (event) =>
                showProjectContextMenu(sidebar, event, { path: ws.path, name: ws.folderName })
            : null,
          renderSessions: (container) => {
            if (pinned.unavailable) {
              const unavailable = document.createElement("div");
              unavailable.className = "pinned-unavailable";
              unavailable.textContent =
                ws?.path || pinned.sessions[0]?.id || t("sidebar.unavailable");
              container.appendChild(unavailable);
              const unpin = document.createElement("button");
              unpin.type = "button";
              unpin.textContent = pinned.workspacePin
                ? t("sidebar.unpinWorkspace")
                : t("sidebar.unpinSession");
              unpin.addEventListener("click", (event) => {
                event.stopPropagation();
                if (pinned.workspacePin) {
                  sidebar.pinnedStore.unpinWorkspace(ws.path);
                } else {
                  sidebar.pinnedStore.unpinSession(pinned.sessions[0].id);
                }
              });
              container.appendChild(unpin);
              return;
            }
            const project = {
              path: ws?.path || workspaceId,
              name: ws?.folderName || workspaceId,
            };
            const visibleCount = getProjectVisibleCount(sidebar, project, pinned.sessions.length);
            const visible = sidebar.searchQuery
              ? pinned.sessions
              : pinned.sessions.slice(0, visibleCount);
            for (const session of visible) {
              container.appendChild(buildSidebarSessionItem(sidebar, session));
            }
            if (!sidebar.searchQuery) {
              const toggle = buildSidebarToggleRow(
                sidebar,
                project,
                visible.length,
                pinned.sessions.length,
              );
              if (toggle) container.appendChild(toggle);
            }
          },
        });
        group.classList.add("pinned-workspace-group");
        body.appendChild(group);
      }
    },
  });
  section.classList.add("pinned-group");
  sidebar.container.appendChild(section);
}

function isProjectCollapsed(sidebar, project) {
  const stored = sidebar.projectsCollapsed[project.path];
  return stored === undefined ? !project.isCurrent : stored === true;
}

export function buildSidebarProjectGroup(sidebar, project) {
  const group = document.createElement("div");
  group.className = `project-group${project.isCurrent ? " current-project" : ""}`;
  const collapsed = isProjectCollapsed(sidebar, project);

  const invoke = globalThis.__TAURI__?.core?.invoke ?? null;
  const canCreateSession = Boolean(invoke || (project.isCurrent && sidebar.onCreateSession));
  const displayName = project.isDefaultWorkspace ? t("sidebar.sessionList") : project.name;
  const newChatLabel = project.isDefaultWorkspace
    ? t("sidebar.startNewChat")
    : t("sidebar.newChatInProject", { name: project.name });
  const newChatButtonHtml = canCreateSession
    ? `<button class="project-new-chat-btn" title="${escapeHtml(newChatLabel)}" aria-label="${escapeHtml(newChatLabel)}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>`
    : "";

  const moreActionsLabel = t("sidebar.workspaceActions");
  const moreActionsButtonHtml = `<button type="button" class="workspace-more-actions-btn" title="${escapeHtml(moreActionsLabel)}" aria-label="${escapeHtml(moreActionsLabel)}"></button>`;

  const header = buildLegacySectionHeader(
    `project-group-header${collapsed ? " collapsed" : ""}`,
    `<span class="chevron folder-icon">
      <svg class="folder-closed-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
      <svg class="folder-open-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>
    </span>
    <span class="project-name" title="${escapeHtml(project.path)}">${escapeHtml(displayName)}</span>
    <span class="project-count">${project.sessions.length}</span>
    ${newChatButtonHtml}
    ${moreActionsButtonHtml}`,
  );

  header.querySelector(".project-new-chat-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const create = invoke
      ? invoke("open_new_session_in_workspace", { projectPath: project.path })
      : sidebar.onCreateSession?.(sidebar.getTarget()?.workspaceId);
    create?.catch((error) => {
      console.error("[Sidebar] Failed to start new chat:", error);
    });
  });

  if (project.isRemote) {
    header
      .querySelector(".folder-icon")
      ?.replaceWith(createRemoteBadge({ disconnected: isProjectDisconnected(project.path) }));
  }

  const moreActionsEl = header.querySelector(".workspace-more-actions-btn");
  if (moreActionsEl) {
    const moreIcon = createIcon("ellipsis", { size: 14 });
    if (moreIcon) moreActionsEl.replaceChildren(moreIcon);
    moreActionsEl.addEventListener("click", (event) => {
      event.stopPropagation();
      showProjectContextMenu(sidebar, event, project);
    });
  }

  const list = document.createElement("div");
  list.className = `project-sessions${collapsed ? " collapsed" : ""}`;

  const visibleCount = getProjectVisibleCount(sidebar, project, project.sessions.length);
  const visible = sidebar.searchQuery ? project.sessions : project.sessions.slice(0, visibleCount);
  visible.forEach((session) => {
    list.appendChild(buildSidebarSessionItem(sidebar, session));
  });
  if (canCreateSession && !sidebar.searchQuery) {
    const newInProject = document.createElement("button");
    newInProject.type = "button";
    newInProject.className = "project-sessions-new-chat";
    newInProject.textContent = t("sidebar.newChatInProject", { name: project.name });
    newInProject.addEventListener("click", (event) => {
      event.stopPropagation();
      const create = invoke
        ? invoke("open_new_session_in_workspace", { projectPath: project.path })
        : sidebar.onCreateSession?.(sidebar.getTarget()?.workspaceId);
      create?.catch((error) => {
        console.error("[Sidebar] Failed to start new chat:", error);
      });
    });
    list.appendChild(newInProject);
  }
  if (!sidebar.searchQuery) {
    const toggle = buildSidebarToggleRow(sidebar, project, visible.length, project.sessions.length);
    if (toggle) list.appendChild(toggle);
  }

  header.addEventListener("click", () => {
    const next = !isProjectCollapsed(sidebar, project);
    sidebar.projectsCollapsed[project.path] = next;
    writeStorage(STORAGE.projectsCollapsed, JSON.stringify(sidebar.projectsCollapsed));
    header.classList.toggle("collapsed", next);
    list.classList.toggle("collapsed", next);
  });
  header.addEventListener("contextmenu", (event) =>
    showProjectContextMenu(sidebar, event, project),
  );

  group.appendChild(header);
  group.appendChild(list);
  return group;
}

export function renderProjectsSidebarSection(sidebar, projectSessions) {
  const projects = groupSessionsByProject(projectSessions);
  const knownPaths = new Set(projects.map((project) => project.path));
  for (const workspace of sidebar.registeredWorkspaces) {
    if (workspace.isDefaultWorkspace) continue;
    if (knownPaths.has(workspace.path)) continue;
    projects.push({
      path: workspace.path,
      name: workspace.folderName || workspace.path,
      isCurrent: workspace.workspaceId === sidebar.getTarget()?.workspaceId,
      isRemote: false,
      isDefaultWorkspace: false,
      sessions: [],
    });
  }
  if (projects.length === 0) return;
  const { section: projectsSection } = buildSidebarSection({
    region: "projects",
    titleKey: "sidebar.projects",
    count: projects.length,
    expanded: true,
    renderSessions: (body) => {
      for (const project of projects) {
        body.appendChild(buildSidebarProjectGroup(sidebar, project));
      }
    },
  });
  projectsSection.classList.add("projects-group");
  sidebar.container.appendChild(projectsSection);
}

export function renderArchivedSidebarSection(sidebar, archived) {
  if (archived.length === 0) return;
  const { section: archivedSection, header: archivedHeader } = buildSidebarSection({
    region: "archived",
    titleKey: "sidebar.archived",
    count: archived.length,
    expanded: !sidebar.archivedCollapsed,
    onToggle: (expanded) => {
      sidebar.archivedCollapsed = !expanded;
      writeStorage(STORAGE.archivedCollapsed, String(sidebar.archivedCollapsed));
    },
    renderSessions: (body) => {
      for (const s of archived) {
        body.appendChild(buildSidebarSessionItem(sidebar, s, { showArchiveButton: false }));
      }
    },
    renderHeaderActions: (header) => {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "archived-delete-all-btn";
      const deleteLabel = t("sidebar.deleteAllArchived");
      deleteBtn.title = deleteLabel;
      deleteBtn.setAttribute("aria-label", deleteLabel);
      const trashGlyph = createIcon("trash-2", { size: 13 });
      if (trashGlyph) deleteBtn.replaceChildren(trashGlyph);
      deleteBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        sidebar.deleteAllArchived();
      });
      header.appendChild(deleteBtn);
    },
  });
  archivedSection.classList.add("archived-group");
  archivedHeader.classList.add("archived-header");
  sidebar.container.appendChild(archivedSection);
}
