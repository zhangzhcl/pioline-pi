import { t } from "../../i18n.js";
import { isSuperAgentProjectPath } from "../../super-agent/session.js";
import { isSuperAgentEnabled } from "../../super-agent/settings.js";
import { createLoadingPlaceholder } from "../../ui/loading-placeholder.js";
import { subscribeProjectConnectionStatus } from "../workspace/project-connection-status.js";
import { createPinnedItemsStore, migrateFavourites, startPinnedItemsSync } from "./pinned-items.js";
import { deleteAllArchivedBatch, deleteWorkspaceSessionsBatch } from "./session-sidebar-actions.js";
import { applySidebarSearchFilter, runFullTextSidebarSearch } from "./session-sidebar-search.js";
import {
  renderArchivedSidebarSection,
  renderDefaultWorkspaceSection,
  renderPinnedSidebarSection,
  renderProjectsSidebarSection,
} from "./session-sidebar-sections.js";
import {
  asSuperAgentSession,
  buildUpsertSessionSummary,
  cssEscape,
  formatSessionTime,
  hydrateSidebarStatuses,
  isDefaultWorkspaceId,
  LOAD_RETRY_DELAYS_MS,
  latestSession,
  MAX_RECENT_SESSIONS,
  readArray,
  readObject,
  readSessionCache,
  recordRecentSessionIds,
  STORAGE,
  sessionListSignature,
  workspaceFolderName,
  writeSessionCache,
  writeStorage,
} from "./session-sidebar-storage.js";

export { formatSessionTime, workspaceFolderName };

export class SessionSidebar {
  constructor(
    container,
    {
      data,
      runtime,
      control,
      config,
      getTarget,
      onSelect,
      onCreateSession,
      onSessionsLoaded,
      onAgentInboxSessionChange,
      loadSessions,
      cacheScope,
    },
  ) {
    this.container = container;
    this.data = data;
    this.runtime = runtime;
    this.control = control;
    this.config = config;
    this.getTarget = getTarget;
    this.onSelect = onSelect;
    this.onCreateSession = onCreateSession;
    this.onSessionsLoaded = onSessionsLoaded;
    this.onAgentInboxSessionChange = onAgentInboxSessionChange;
    this.loadSessions = loadSessions;
    this.cacheScope = cacheScope;

    this.sessions = [];
    this.activeSessionId = getTarget()?.sessionId ?? null;
    this.favourites = readArray(STORAGE.favourites);
    this.archived = readArray(STORAGE.archived);
    this.archivedCollapsed = localStorage.getItem(STORAGE.archivedCollapsed) !== "false";
    this.projectsCollapsed = readObject(STORAGE.projectsCollapsed);
    this.recent = readArray(STORAGE.recent).slice(0, MAX_RECENT_SESSIONS);
    this.recentCollapsed = localStorage.getItem(STORAGE.recentCollapsed) !== "false";
    this.registeredWorkspaces = [];
    this.sessionsCollapsed = localStorage.getItem(STORAGE.sessionsCollapsed) === "true";
    this.pinnedCollapsed = false;
    this.unread = new Set(readArray(STORAGE.unread));
    this.streaming = new Set();

    this.searchQuery = "";
    this._searchResults = null;
    this._searchTimer = null;
    this._visibleCountsByProject = new Map();
    this._loadSeq = 0;
    this._loadCommitted = 0;
    this.contextMenu = null;

    this.pinnedStore = createPinnedItemsStore();
    try {
      const migration = migrateFavourites();
      if (migration.pendingLegacySessions?.length > 0) {
        console.warn(
          `[Sidebar] Pin migration deferred ${migration.pendingLegacySessions.length} legacy favourites (capacity).`,
        );
      }
    } catch (error) {
      console.error("[Sidebar] Pin migration failed:", error);
    }
    this._unsubscribePinned = this.pinnedStore.subscribe(() => this.render());
    this._stopPinnedSync = startPinnedItemsSync({});
    this._unsubscribeConnectionStatus = subscribeProjectConnectionStatus(() => this.render());

    this._onDocumentClick = () => this.closeContextMenu();
    document.addEventListener("click", this._onDocumentClick);
  }

  #save(key, value) {
    writeStorage(key, JSON.stringify(value));
  }

  isFavourite(id) {
    return this.favourites.includes(id);
  }

  isArchived(id) {
    return this.archived.includes(id);
  }

  toggleFavourite(id) {
    const idx = this.favourites.indexOf(id);
    if (idx >= 0) this.favourites.splice(idx, 1);
    else this.favourites.push(id);
    this.#save(STORAGE.favourites, this.favourites);
    this.render();
  }

  toggleArchived(id) {
    const idx = this.archived.indexOf(id);
    if (idx >= 0) this.archived.splice(idx, 1);
    else this.archived.push(id);
    this.#save(STORAGE.archived, this.archived);
    this.render();
  }

  #recordRecent(id) {
    const next = recordRecentSessionIds(this.recent, id, this.sessions);
    if (!next) return;
    this.recent = next;
    this.#save(STORAGE.recent, this.recent);
  }

  archiveProject(project) {
    const ids = this.sessions
      .filter(
        (session) =>
          session.projectPath === project.path && !isSuperAgentProjectPath(session.projectPath),
      )
      .map((session) => session.id);
    if (ids.length === 0) return;

    const projectIds = new Set(ids);
    this.archived = [...new Set([...this.archived, ...ids])];
    this.favourites = this.favourites.filter((id) => !projectIds.has(id));
    this.#save(STORAGE.archived, this.archived);
    this.#save(STORAGE.favourites, this.favourites);
    this.render();
  }

  async deleteWorkspaceSessions(project) {
    return deleteWorkspaceSessionsBatch(this, project);
  }

  async deleteAllArchived() {
    return deleteAllArchivedBatch(this);
  }

  setActive(sessionId) {
    this.activeSessionId = sessionId;
    if (sessionId && this.unread.has(sessionId)) {
      this.unread.delete(sessionId);
      this.#save(STORAGE.unread, [...this.unread]);
    }
    this.#recordRecent(sessionId);
    this.container.querySelectorAll(".session-item").forEach((el) => {
      const isActive = el.dataset.sessionId === sessionId;
      el.classList.toggle("active", isActive);
      if (isActive) el.classList.remove("unread");
    });
  }

  markUnread(id) {
    if (!id || id === this.activeSessionId || this.unread.has(id)) return;
    this.unread.add(id);
    this.#save(STORAGE.unread, [...this.unread]);
    this.#applyStatus(id);
  }

  markRead(id) {
    if (!id || !this.unread.has(id)) return;
    this.unread.delete(id);
    this.#save(STORAGE.unread, [...this.unread]);
    this.#applyStatus(id);
  }

  setStreaming(id, streaming) {
    if (!id) return;
    const had = this.streaming.has(id);
    if (streaming && !had) this.streaming.add(id);
    else if (!streaming && had) this.streaming.delete(id);
    else return;
    this.#applyStatus(id);
  }

  clearStreaming() {
    if (this.streaming.size === 0) return;
    const ids = [...this.streaming];
    this.streaming.clear();
    ids.forEach((id) => {
      this.#applyStatus(id);
    });
  }

  #applyStatus(id) {
    this.container
      .querySelectorAll(`.session-item[data-session-id="${cssEscape(id)}"]`)
      .forEach((el) => {
        el.classList.toggle("unread", this.unread.has(id));
        el.classList.toggle("streaming", this.streaming.has(id));
        el.classList.toggle("mirror-live", this.streaming.has(id));
      });
  }

  async load({ quiet = false, retryAttempt = 0 } = {}) {
    const seq = ++this._loadSeq;
    const workspaceId = this.getTarget()?.workspaceId ?? this.cacheScope;
    if (!workspaceId) return;
    let renderedFromCache = false;
    if (!quiet && this.sessions.length === 0) {
      const cachedSessions = readSessionCache(workspaceId, this.activeSessionId);
      if (cachedSessions.length > 0) {
        this.sessions = cachedSessions;
        this.#hydrateStatuses(this.sessions);
        this.onSessionsLoaded?.(this.sessions);
        this.render();
        renderedFromCache = true;
      }
    }
    if (!quiet && this.sessions.length === 0) {
      this.container.replaceChildren(
        ...Array.from({ length: 6 }, () => {
          const skel = document.createElement("div");
          skel.className = "session-skeleton";
          const skelTitle = document.createElement("div");
          skelTitle.className = "session-skeleton-title";
          skel.appendChild(skelTitle);
          return skel;
        }),
      );
    }
    const previousSignature = sessionListSignature(this.sessions);
    try {
      const response = this.loadSessions
        ? await this.loadSessions()
        : await this.data.listAllSessions(workspaceId);
      if (seq < this._loadCommitted) return;
      this._loadCommitted = seq;
      const receivedSessions = response.sessions ?? [];
      const nextWorkspaces = Array.isArray(response.workspaces) ? response.workspaces : null;
      const workspacesChanged =
        nextWorkspaces != null &&
        JSON.stringify(nextWorkspaces) !== JSON.stringify(this.registeredWorkspaces);
      if (nextWorkspaces) this.registeredWorkspaces = nextWorkspaces;
      const nextSessions =
        receivedSessions.length === 0 && this.sessions.length > 0
          ? [...this.sessions]
          : receivedSessions;
      const activeId = this.activeSessionId;
      if (activeId && !nextSessions.some((session) => session?.id === activeId)) {
        const local = this.sessions.find((session) => session?.id === activeId);
        if (local) nextSessions.unshift(local);
      }
      const changed = sessionListSignature(nextSessions) !== previousSignature;
      this.sessions = nextSessions;
      this.#hydrateStatuses(this.sessions, { authoritative: true });
      writeSessionCache(workspaceId, this.sessions);
      this.onSessionsLoaded?.(this.sessions);
      this.syncAgentInboxNav();
      if (changed || workspacesChanged || (!quiet && !renderedFromCache)) this.render();
    } catch (error) {
      if (seq < this._loadCommitted) return;
      const retryDelay = LOAD_RETRY_DELAYS_MS[retryAttempt];
      if (retryDelay != null) {
        console.warn("[Sidebar] Session load failed; retrying:", error);
        if (!quiet && this.sessions.length === 0) {
          this.container.replaceChildren(
            createLoadingPlaceholder({
              className: "session-loading",
              label: t("sidebar.loadingSessions"),
            }),
          );
        }
        setTimeout(() => {
          if (seq === this._loadSeq) {
            this.load({ quiet: true, retryAttempt: retryAttempt + 1 });
          }
        }, retryDelay);
        return;
      }
      console.error("[Sidebar] Failed to load sessions:", error);
      if (this.sessions.length > 0) return;
      const loadingEl = document.createElement("div");
      loadingEl.className = "session-loading";
      loadingEl.textContent = `${t("sidebar.failedToLoadSessions")} `;
      const retryLink = document.createElement("button");
      retryLink.className = "retry-link";
      retryLink.id = "retry-load-sessions";
      retryLink.textContent = t("sidebar.retry");
      loadingEl.appendChild(retryLink);
      this.container.replaceChildren(loadingEl);
      retryLink.addEventListener("click", () => this.load());
    }
  }

  isDefaultWorkspaceId(workspaceId) {
    return isDefaultWorkspaceId(workspaceId, this.registeredWorkspaces, this.sessions);
  }

  upsertSession(session) {
    if (!session?.id) return;
    const index = this.sessions.findIndex((existing) => existing.id === session.id);
    const existing = index >= 0 ? this.sessions[index] : null;
    const next = buildUpsertSessionSummary({
      existing,
      session,
      currentWorkspaceId: this.getTarget()?.workspaceId ?? session?.workspaceId ?? "",
      registeredWorkspaces: this.registeredWorkspaces,
      sessions: this.sessions,
    });

    if (index >= 0) this.sessions.splice(index, 1);
    this.sessions.unshift(next);
    this.#hydrateStatuses(this.sessions);
    writeSessionCache(this.getTarget()?.workspaceId, this.sessions);
    this.onSessionsLoaded?.(this.sessions);
    this.render();
  }

  setSearchQuery(query) {
    this.searchQuery = (query || "").toLowerCase().trim();
    if (this._searchTimer) clearTimeout(this._searchTimer);
    if (!this.searchQuery) {
      this._searchResults = null;
      this.applySearch();
      return;
    }
    this.applySearch();
    if (this.searchQuery.length >= 2) {
      this._searchTimer = setTimeout(() => runFullTextSidebarSearch(this, this.searchQuery), 300);
    }
  }

  applySearch() {
    applySidebarSearchFilter(this);
  }

  #hydrateStatuses(sessions, { authoritative = false } = {}) {
    hydrateSidebarStatuses({
      sessions,
      activeSessionId: this.activeSessionId,
      streaming: this.streaming,
      unread: this.unread,
      authoritative,
    });
    this.#save(STORAGE.unread, [...this.unread]);
  }

  syncAgentInboxNav() {
    const superAgentEnabled = isSuperAgentEnabled();
    const superAgentSessions = this.sessions.filter((session) =>
      isSuperAgentProjectPath(session.projectPath),
    );
    const agentInboxSession = superAgentEnabled
      ? asSuperAgentSession(latestSession(superAgentSessions))
      : null;
    this.onAgentInboxSessionChange?.(agentInboxSession);
  }

  render() {
    this.syncAgentInboxNav();
    this.container.replaceChildren();

    const pinState = this.pinnedStore.getState();
    const hasAnyPins = pinState.workspaces.length > 0 || pinState.sessions.length > 0;

    if (this.sessions.length === 0 && !hasAnyPins) {
      const empty = document.createElement("div");
      empty.className = "session-loading";
      empty.textContent = t("sidebar.noSavedSessions");
      this.container.appendChild(empty);
      return;
    }

    const pinnedWorkspacePaths = new Set(pinState.workspaces.map((w) => w.path || w.id));
    const pinnedSessionIds = new Set(pinState.sessions);
    const archivedIds = new Set(this.archived);
    const archived = [];
    const regular = [];
    for (const session of this.sessions) {
      if (isSuperAgentProjectPath(session.projectPath)) continue;
      if (archivedIds.has(session.id)) {
        archived.push(session);
      } else if (
        !pinnedSessionIds.has(session.id) &&
        !(session.projectPath && pinnedWorkspacePaths.has(session.projectPath))
      ) {
        regular.push(session);
      }
    }

    const defaultWorkspaceSessions = [];
    const projectSessions = [];
    for (const session of regular) {
      if (session.isDefaultWorkspace === true || !session.projectPath) {
        defaultWorkspaceSessions.push(session);
      } else {
        projectSessions.push(session);
      }
    }

    renderDefaultWorkspaceSection(this, defaultWorkspaceSessions);
    renderPinnedSidebarSection(this, pinState);
    renderProjectsSidebarSection(this, projectSessions);
    renderArchivedSidebarSection(this, archived);

    if (this.searchQuery) this.applySearch();
  }

  closeContextMenu() {
    this.contextMenu?.remove();
    this.contextMenu = null;
  }

  setSessionName(sessionId, name) {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    session.name = name || "";
    const title = session.name || session.firstMessage || "Empty session";
    const titleEl = this.container.querySelector(
      `.session-item[data-session-id="${cssEscape(sessionId)}"] .session-title`,
    );
    if (!titleEl) return;
    titleEl.textContent = title;
    titleEl.title = title;
  }

  destroy() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    this.closeContextMenu();
    if (this._onDocumentClick) {
      document.removeEventListener("click", this._onDocumentClick);
    }
    try {
      this._unsubscribePinned?.();
    } catch (error) {
      console.error("[Sidebar] Pin unsubscribe failed:", error);
    }
    try {
      this._stopPinnedSync?.();
    } catch (error) {
      console.error("[Sidebar] Pin sync stop failed:", error);
    }
    try {
      this._unsubscribeConnectionStatus?.();
    } catch (error) {
      console.error("[Sidebar] Connection-status unsubscribe failed:", error);
    }
    try {
      this.pinnedStore?.destroy?.();
    } catch (error) {
      console.error("[Sidebar] Pin store destroy failed:", error);
    }
  }
}
