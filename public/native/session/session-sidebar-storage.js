// 会话侧边栏：本地存储读写、会话列表缓存、相对时间格式化与状态特征纯函数。

import { isSuperAgentProjectPath } from "../../super-agent/session.js";
import { basenameLocalPath } from "../../workspace/path-utils.js";

export const INITIAL_LIMIT = 8;
export const STEP = 10;
export const LOAD_RETRY_DELAYS_MS = [250, 750, 1500];
export const MAX_RECENT_SESSIONS = 5;

export const STORAGE = {
  favourites: "picot-favourites",
  archived: "picot-archived",
  archivedCollapsed: "picot-archived-collapsed",
  projectsCollapsed: "picot-projects-collapsed",
  sessionCache: "picot-session-list-cache",
  latestSessionCache: "picot-session-list-cache:latest",
  unread: "picot-unread",
  recent: "picot-recent-sessions",
  recentCollapsed: "picot-recent-collapsed",
  sessionsCollapsed: "picot-sessions-collapsed",
};

/** Sidebar label for a workspace path. Windows `\\?\UNC\...` paths have no `/`. */
export function workspaceFolderName(path, projectName) {
  const fromName = typeof projectName === "string" ? projectName.trim() : "";
  if (fromName && !/[\\/]/.test(fromName)) return fromName;
  return basenameLocalPath(path) || fromName || path || "";
}

export function readObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function readArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 侧边栏偏好属于尽力而为的持久化；配额或无痕模式错误不应阻塞实时交互。
  }
}

export function sessionCacheKey(workspaceId) {
  return `${STORAGE.sessionCache}:${workspaceId}`;
}

export function rebaseCachedSessions(sessions, activeSessionId) {
  const active = sessions.find((session) => session?.id === activeSessionId);
  const activeProjectPath = active?.projectPath;
  if (!activeProjectPath) return sessions;
  return sessions.map((session) => ({
    ...session,
    isCurrentWorkspace: session?.projectPath === activeProjectPath,
  }));
}

export function readSessionCache(workspaceId, activeSessionId) {
  try {
    const workspaceValue = JSON.parse(localStorage.getItem(sessionCacheKey(workspaceId)) || "[]");
    if (Array.isArray(workspaceValue) && workspaceValue.length > 0) return workspaceValue;
    const latestValue = JSON.parse(localStorage.getItem(STORAGE.latestSessionCache) || "[]");
    return Array.isArray(latestValue) ? rebaseCachedSessions(latestValue, activeSessionId) : [];
  } catch {
    return [];
  }
}

export function writeSessionCache(workspaceId, sessions) {
  try {
    const serialized = JSON.stringify(sessions);
    localStorage.setItem(sessionCacheKey(workspaceId), serialized);
    localStorage.setItem(STORAGE.latestSessionCache, serialized);
  } catch {
    // 缓存写入失败不影响实时会话列表。
  }
}

export function sessionListSignature(sessions) {
  return JSON.stringify(
    (sessions ?? []).map((session) => ({
      id: session?.id ?? null,
      name: session?.name ?? null,
      firstMessage: session?.firstMessage ?? null,
      timestamp: session?.timestamp ?? null,
      modifiedAtMs: session?.modifiedAtMs ?? null,
      projectPath: session?.projectPath ?? null,
      projectName: session?.projectName ?? null,
      isCurrentWorkspace: session?.isCurrentWorkspace === true,
      kind: session?.kind ?? null,
      status: session?.status ?? null,
      state: session?.state ?? null,
      isWorking: session?.isWorking === true,
      unread: session?.unread === true,
      hasUnread: session?.hasUnread === true,
      target: session?.target ?? null,
      filePath: session?.filePath ?? null,
    })),
  );
}

export function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

export function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function isWorkingSession(session) {
  return (
    session?.status === "working" || session?.state === "working" || session?.isWorking === true
  );
}

export function hasLiveStatus(session) {
  return session?.status != null || session?.state != null || session?.isWorking != null;
}

export function isUnreadSession(session) {
  return session?.unread === true || session?.hasUnread === true;
}

export function sessionTimeMs(session) {
  const modified = Number(session?.modifiedAtMs);
  if (Number.isFinite(modified) && modified > 0) return modified;
  const parsed = Date.parse(session?.timestamp || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function asSuperAgentSession(session) {
  if (!session) return null;
  return {
    ...session,
    kind: "super-agent",
    name: "Agent Inbox",
    projectName: "Agent Inbox",
  };
}

export function latestSession(sessions) {
  let latest = null;
  let latestTime = -Infinity;
  for (const session of sessions ?? []) {
    const time = sessionTimeMs(session);
    if (latest === null || time > latestTime) {
      latest = session;
      latestTime = time;
    }
  }
  return latest;
}

export function mergeSessionSummary(existing, incoming) {
  return {
    ...(existing ?? {}),
    ...(incoming ?? {}),
    name: incoming?.name ?? existing?.name ?? null,
    firstMessage: existing?.firstMessage ?? incoming?.firstMessage ?? null,
    timestamp: incoming?.timestamp ?? existing?.timestamp ?? new Date().toISOString(),
    modifiedAtMs: incoming?.modifiedAtMs ?? existing?.modifiedAtMs ?? Date.now(),
  };
}

export function recordRecentSessionIds(recent, id, sessions) {
  if (!id) return null;
  const session = sessions.find((entry) => entry.id === id);
  if (session && isSuperAgentProjectPath(session.projectPath)) return null;
  const next = [id, ...recent.filter((existing) => existing !== id)].slice(0, MAX_RECENT_SESSIONS);
  if (next.length === recent.length && next.every((item, idx) => item === recent[idx])) {
    return null;
  }
  return next;
}

export function hydrateSidebarStatuses({
  sessions,
  activeSessionId,
  streaming,
  unread,
  authoritative = false,
}) {
  const listedIds = new Set();
  for (const session of sessions) {
    if (!session?.id) continue;
    listedIds.add(session.id);
    if (isWorkingSession(session)) streaming.add(session.id);
    else if (authoritative || hasLiveStatus(session)) streaming.delete(session.id);

    if (isUnreadSession(session) && session.id !== activeSessionId) unread.add(session.id);
    else if (session.id === activeSessionId) unread.delete(session.id);
  }
  if (authoritative) {
    for (const id of streaming) {
      if (!listedIds.has(id)) streaming.delete(id);
    }
  }
}

export function formatSessionTime(isoTimestamp) {
  if (!isoTimestamp) return "";
  try {
    const date = new Date(isoTimestamp);
    if (Number.isNaN(date.getTime())) return "";
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (days === 1) return "Yesterday";
    if (days < 7) return date.toLocaleDateString([], { weekday: "long" });
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
