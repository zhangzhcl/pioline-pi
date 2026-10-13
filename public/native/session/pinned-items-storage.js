// ABOUTME: Storage normalization, capacity error, and legacy Favourites migration for Pinned Items.

export const PINNED_ITEMS_KEY = "picot-pinned-items";
export const PINNED_ITEMS_EVENT = "picot:pinned-items-change";
export const FAVOURITES_STORAGE_KEY = "pi-studio-favourites";
export const FAVOURITES_MIGRATED_FLAG = "picot-pinned-favourites-migrated";
export const MAX_PINNED_ITEMS = 20;
export const PINNED_SCHEMA_VERSION = 1;

export function defaultStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function defaultWindow() {
  return typeof window !== "undefined" ? window : null;
}

/**
 * Error thrown when a mutation would exceed the item-count limit. The
 * existing storage value is left untouched; `previousState` holds the last
 * committed state so callers can render localized feedback without losing data.
 */
export class PinnedCapacityError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = "PinnedCapacityError";
    this.attemptedCount = context.attemptedCount ?? 0;
    this.limitCount = context.limitCount ?? MAX_PINNED_ITEMS;
    this.previousState = context.previousState ?? { workspaces: [], sessions: [] };
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, PinnedCapacityError);
    }
  }
}

export function normalizeWorkspaceRecord(record) {
  if (!record || typeof record !== "object") return null;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!path) return null;
  return { id: path, path };
}

/**
 * Build a normalized, deduplicated Pin state from arbitrary input.
 */
export function normalizePinnedState(payload) {
  const workspaces = [];
  const sessions = [];

  if (!payload || typeof payload !== "object") return { workspaces, sessions };

  const rawWorkspaces = Array.isArray(payload.workspaces) ? payload.workspaces : [];
  const seenWorkspaceIds = new Set();
  for (const record of rawWorkspaces) {
    const normalized = normalizeWorkspaceRecord(record);
    if (!normalized || seenWorkspaceIds.has(normalized.id)) continue;
    seenWorkspaceIds.add(normalized.id);
    workspaces.push(normalized);
  }

  const rawSessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const seenSessions = new Set();
  for (const session of rawSessions) {
    if (typeof session !== "string" || !session || seenSessions.has(session)) continue;
    seenSessions.add(session);
    sessions.push(session);
  }

  return { workspaces, sessions };
}

export function serializeState(state) {
  return {
    v: PINNED_SCHEMA_VERSION,
    workspaces: state.workspaces.map((workspace) => ({ id: workspace.id, path: workspace.path })),
    sessions: state.sessions.slice(),
  };
}

export function serializedForCompare(state) {
  return JSON.stringify(serializeState(state));
}

export function samePinnedState(a, b) {
  return serializedForCompare(a) === serializedForCompare(b);
}

export function itemCount(state) {
  return (state.workspaces?.length ?? 0) + (state.sessions?.length ?? 0);
}

function readStorageValue(storageRef) {
  try {
    const raw = storageRef?.getItem?.(PINNED_ITEMS_KEY);
    return raw ?? null;
  } catch {
    // localStorage access can fail in sandboxed or disabled contexts.
  }
  return null;
}

/**
 * Read and normalize the current Pin storage value. Malformed values resolve to an
 * empty state so the UI stays usable and recoverable.
 */
export function readPinnedItems(storageRef = defaultStorage()) {
  const value = readStorageValue(storageRef);
  if (!value) return { workspaces: [], sessions: [] };
  try {
    return normalizePinnedState(JSON.parse(value));
  } catch {
    return { workspaces: [], sessions: [] };
  }
}

function markMigrated(storageRef, migratedFlagKey) {
  try {
    storageRef?.setItem?.(migratedFlagKey, "1");
  } catch {
    // Storage may be unavailable; migration will retry on the next load.
  }
}

export function migrateFavouritesWithWrite(
  writeFn,
  { storageRef = defaultStorage(), migratedFlagKey = FAVOURITES_MIGRATED_FLAG } = {},
) {
  const result = { migrated: [], pendingLegacySessions: [], capacityError: null, skipped: false };

  let alreadyMigrated = false;
  try {
    alreadyMigrated = storageRef?.getItem?.(migratedFlagKey) === "1";
  } catch {
    alreadyMigrated = false;
  }
  if (alreadyMigrated) {
    result.skipped = true;
    return result;
  }

  let raw = null;
  try {
    raw = storageRef?.getItem ? storageRef.getItem(FAVOURITES_STORAGE_KEY) : null;
  } catch {
    raw = null;
  }
  if (raw === null) {
    markMigrated(storageRef, migratedFlagKey);
    return result;
  }

  let parsed = [];
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }
  const legacySessions = Array.isArray(parsed)
    ? parsed.filter((session) => typeof session === "string" && session)
    : [];

  if (legacySessions.length === 0) {
    markMigrated(storageRef, migratedFlagKey);
    return result;
  }

  const current = readPinnedItems(storageRef);
  const existing = new Set(current.sessions);
  const toAdd = [];
  for (const session of legacySessions) {
    if (!existing.has(session) && !toAdd.includes(session)) toAdd.push(session);
  }

  if (toAdd.length === 0) {
    markMigrated(storageRef, migratedFlagKey);
    return result;
  }

  const mergedSessions = [...toAdd, ...current.sessions];
  try {
    writeFn({ workspaces: current.workspaces, sessions: mergedSessions }, storageRef);
    markMigrated(storageRef, migratedFlagKey);
    result.migrated = toAdd;
    return result;
  } catch (error) {
    if (error instanceof PinnedCapacityError) {
      result.capacityError = error;
      result.pendingLegacySessions = toAdd;
      return result;
    }
    throw error;
  }
}
