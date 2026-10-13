// ABOUTME: Settings file I/O, thinking/compaction/scoped-model helpers, session rename, and Telegram/SuperAgent helpers for picot-config.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveHomeDir, resolvePiAgentRoot } from "./pi-agent-paths";
import type { TelegramBotIdentity, TelegramWorkerStatusLike } from "./pi-chat-setup";
import type { CatalogRegistry } from "./picot-config-models";
import type { SkillScope, SkillTarget } from "./skill-inventory";
import { parseSshHosts, type SshHostEntry } from "./ssh-remote";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ConfigContext = {
  modelRegistry?: CatalogRegistry;
  cwd?: string;
  model?: unknown;
  sessionManager?: { getSessionFile: () => string | undefined };
  navigateTree?: (
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ) => Promise<{ cancelled?: boolean } | undefined>;
  /** Stream an OAuth operation event to the initiating request's envelope. */
  oauthNotify?: (event: unknown) => void;
  isProjectTrusted?: () => boolean;
};

type ListedSession = { path?: string };
type JsonObject = Record<string, unknown>;

export type SkillInventoryMutation = {
  scope?: unknown;
  target?: unknown;
  enabled?: unknown;
};

export const HOME_DIR = resolveHomeDir();
export const PI_AGENT_ROOT = resolvePiAgentRoot();
export const AGENT_CONFIG_PATH = path.join(PI_AGENT_ROOT, "settings.json");
export const AGENTS_MD_PATH = path.join(PI_AGENT_ROOT, "AGENTS.md");
export const APPEND_SYSTEM_MD_PATH = path.join(PI_AGENT_ROOT, "APPEND_SYSTEM.md");
export const CHAT_CONFIG_PATH = path.join(PI_AGENT_ROOT, "chat", "config.json");
export const CHAT_WORKER_STATUS_DIR = path.join(PI_AGENT_ROOT, "chat", "worker-status");
export const SUPER_AGENT_TASKS_PATH = path.join(PI_AGENT_ROOT, "super-agent", "tasks.json");
export const PISTUDIO_INSTANCES_DIR = path.join(os.homedir(), ".pi", "pistudio-instances");
export const PROJECT_CONFIG_DIR_NAME = ".pi";

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function renameHistoricalSession(filePath: unknown, requestedName: unknown) {
  if (typeof filePath !== "string" || typeof requestedName !== "string") {
    throw new Error("Session path and name are required.");
  }
  const name = requestedName.trim();
  if (!name) throw new Error("Session name cannot be empty.");
  if ([...name].length > 200) throw new Error("Session name cannot exceed 200 characters.");
  if (path.extname(filePath).toLowerCase() !== ".jsonl") {
    throw new Error("Session is not available.");
  }
  let canonicalTarget: string;
  try {
    canonicalTarget = fs.realpathSync.native(filePath);
  } catch {
    throw new Error("Session is not available.");
  }
  const sessions = (await SessionManager.listAll()) as ListedSession[];
  const managed = sessions.find((session) => {
    if (typeof session.path !== "string") return false;
    try {
      return fs.realpathSync.native(session.path) === canonicalTarget;
    } catch {
      return false;
    }
  });
  if (!managed) throw new Error("Session is not available.");
  const manager = SessionManager.open(canonicalTarget);
  manager.appendSessionInfo(name);
  return { filePath: canonicalTarget, name };
}

export function parseSkillScope(value: unknown): SkillScope {
  if (value === "global" || value === "project") return value;
  throw new Error("Invalid skill inventory scope");
}

export function parseSkillTarget(value: unknown): SkillTarget {
  if (!value || typeof value !== "object") throw new Error("Invalid skill inventory mutation");
  const target = value as { kind?: unknown; id?: unknown };
  if (target.kind !== "skill" && target.kind !== "group") {
    throw new Error("Invalid skill inventory mutation");
  }
  if (typeof target.id !== "string" || target.id.length === 0) {
    throw new Error("Invalid skill inventory mutation");
  }
  return { kind: target.kind, id: target.id };
}

export function skillInventoryOptions(scope: SkillScope, ctx: ConfigContext) {
  const cwd = typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
  return {
    scope,
    cwd,
    agentDir: PI_AGENT_ROOT,
    homeDir: HOME_DIR,
    projectTrusted: Boolean(ctx.isProjectTrusted?.()),
  };
}

export function readConfigFile(
  filePath: string,
  fallback: string,
): { content: string; path: string } {
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : fallback;
  return { content, path: filePath };
}

export function writeConfigFile(filePath: string, content: unknown): void {
  if (typeof content !== "string") throw new Error("content must be a string");
  try {
    JSON.parse(content);
  } catch (error) {
    throw new Error(
      `content is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

export function readTextFile(filePath: string): { content: string; path: string; exists: boolean } {
  const exists = fs.existsSync(filePath);
  const content = exists ? fs.readFileSync(filePath, "utf8") : "";
  return { content, path: filePath, exists };
}

export function writeTextFile(filePath: string, content: unknown): void {
  if (typeof content !== "string") throw new Error("content must be a string");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

export function backupConfigFile(configPath: string): void {
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, `${configPath}.bak`);
  }
}

export function readSettingsObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Pi settings at ${filePath} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Pi settings must be a JSON object: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

export function writeSettingsObject(filePath: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.picot-settings-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, filePath);
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function asThinkingLevel(value: unknown): ThinkingLevel {
  const level = asString(value);
  if (THINKING_LEVELS.has(level as ThinkingLevel)) return level as ThinkingLevel;
  throw new Error(`Unsupported thinking level: ${level || String(value)}`);
}

export function resolveSettingsPath(
  scope: unknown,
  ctx: ConfigContext,
): { scope: "global" | "project"; path: string } {
  const normalizedScope = asString(scope) || "global";
  if (normalizedScope === "global") return { scope: "global", path: AGENT_CONFIG_PATH };
  if (normalizedScope !== "project")
    throw new Error(`Unsupported settings scope: ${normalizedScope}`);
  const cwd = asString(ctx.cwd);
  if (!cwd) throw new Error("Project settings require an active workspace");
  if (ctx.isProjectTrusted && !ctx.isProjectTrusted()) {
    throw new Error("Project settings cannot be changed until the workspace is trusted");
  }
  return {
    scope: "project",
    path: path.join(cwd, PROJECT_CONFIG_DIR_NAME, "settings.json"),
  };
}

export function readGlobalSshHostRegistry(): Record<string, SshHostEntry> {
  return parseSshHosts(readSettingsObject(AGENT_CONFIG_PATH).sshHosts);
}

function getProjectSettings(
  ctx: ConfigContext,
): { path: string; settings: Record<string, unknown> } | null {
  const cwd = asString(ctx.cwd);
  if (!cwd || (ctx.isProjectTrusted && !ctx.isProjectTrusted())) return null;
  const settingsPath = path.join(cwd, PROJECT_CONFIG_DIR_NAME, "settings.json");
  return { path: settingsPath, settings: readSettingsObject(settingsPath) };
}

export function getDefaultThinkingLevel(scope: unknown, ctx: ConfigContext) {
  const requestedScope = asString(scope) || "global";
  if (requestedScope === "project" || requestedScope === "effective") {
    const project = getProjectSettings(ctx);
    const projectValue = project?.settings.defaultThinkingLevel;
    if (
      project &&
      typeof projectValue === "string" &&
      THINKING_LEVELS.has(projectValue as ThinkingLevel)
    ) {
      return { level: projectValue, source: "project", path: project.path };
    }
    if (requestedScope === "project") {
      const writableProject = resolveSettingsPath("project", ctx);
      return { level: "off", source: "pi_default", path: writableProject.path };
    }
  }
  const globalValue = readSettingsObject(AGENT_CONFIG_PATH).defaultThinkingLevel;
  if (typeof globalValue === "string" && THINKING_LEVELS.has(globalValue as ThinkingLevel)) {
    return { level: globalValue, source: "global", path: AGENT_CONFIG_PATH };
  }
  return { level: "off", source: "pi_default", path: AGENT_CONFIG_PATH };
}

export function setDefaultThinkingLevel(level: unknown, scope: unknown, ctx: ConfigContext) {
  const thinkingLevel = asThinkingLevel(level);
  const target = resolveSettingsPath(scope, ctx);
  const settings = readSettingsObject(target.path);
  settings.defaultThinkingLevel = thinkingLevel;
  writeSettingsObject(target.path, settings);
  return { level: thinkingLevel, scope: target.scope, path: target.path };
}

function getCompactionEnabled(settings: Record<string, unknown>): boolean | undefined {
  const compaction = settings.compaction;
  if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) return undefined;
  const enabled = (compaction as Record<string, unknown>).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}

export function getDefaultAutoCompaction(scope: unknown, ctx: ConfigContext) {
  const requestedScope = asString(scope) || "global";
  if (requestedScope === "project" || requestedScope === "effective") {
    const project = getProjectSettings(ctx);
    const projectValue = project ? getCompactionEnabled(project.settings) : undefined;
    if (typeof projectValue === "boolean") {
      return { enabled: projectValue, source: "project", path: project?.path };
    }
    if (requestedScope === "project") {
      const writableProject = resolveSettingsPath("project", ctx);
      return { enabled: true, source: "pi_default", path: writableProject.path };
    }
  }
  const globalValue = getCompactionEnabled(readSettingsObject(AGENT_CONFIG_PATH));
  if (typeof globalValue === "boolean") {
    return { enabled: globalValue, source: "global", path: AGENT_CONFIG_PATH };
  }
  return { enabled: true, source: "pi_default", path: AGENT_CONFIG_PATH };
}

export function setDefaultAutoCompaction(enabled: unknown, scope: unknown, ctx: ConfigContext) {
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
  const target = resolveSettingsPath(scope, ctx);
  const settings = readSettingsObject(target.path);
  const existing = settings.compaction;
  const compaction =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  compaction.enabled = enabled;
  settings.compaction = compaction;
  writeSettingsObject(target.path, settings);
  return { enabled, scope: target.scope, path: target.path };
}

export function readEnabledModels(settings: Record<string, unknown>): string[] {
  return Array.isArray(settings.enabledModels)
    ? settings.enabledModels.filter(
        (model): model is string => typeof model === "string" && model.trim().length > 0,
      )
    : [];
}

export function scopedModelId(pattern: string): string {
  const suffixIndex = pattern.lastIndexOf(":");
  return suffixIndex === -1 ? pattern : pattern.slice(0, suffixIndex);
}

export function setScopedModel(provider: unknown, modelId: unknown, enabled: unknown) {
  const normalizedProvider = asString(provider);
  const normalizedModelId = asString(modelId);
  if (!normalizedProvider || !normalizedModelId) {
    throw new Error("provider and modelId are required");
  }
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
  const reference = `${normalizedProvider}/${normalizedModelId}`;
  const settings = readSettingsObject(AGENT_CONFIG_PATH);
  const current = readEnabledModels(settings);
  const withoutModel = current.filter((pattern) => scopedModelId(pattern) !== reference);
  const models = enabled ? [...withoutModel, reference] : withoutModel;
  if (models.length > 0) settings.enabledModels = models;
  else delete settings.enabledModels;
  writeSettingsObject(AGENT_CONFIG_PATH, settings);
  return {
    provider: normalizedProvider,
    modelId: normalizedModelId,
    enabled,
    modelIds: models.map(scopedModelId),
  };
}

function readJsonFile(filePath: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

export function getChatWorkerStatuses(): TelegramWorkerStatusLike[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(CHAT_WORKER_STATUS_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readJsonFile(path.join(CHAT_WORKER_STATUS_DIR, entry)))
    .filter((value): value is JsonObject & TelegramWorkerStatusLike => Boolean(value));
}

export type SuperAgentProject = { name: string; cwd: string; status: string };

export function listSuperAgentProjects(): SuperAgentProject[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(PISTUDIO_INSTANCES_DIR);
  } catch {
    return [];
  }
  const byCwd = new Map<string, SuperAgentProject>();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const record = readJsonFile(path.join(PISTUDIO_INSTANCES_DIR, entry)) as
      | { cwd?: unknown }
      | undefined;
    const cwd = typeof record?.cwd === "string" ? record.cwd.replace(/\/+$/, "") : "";
    if (!cwd || cwd.endsWith("/.pi/agent/super-agent")) continue;
    byCwd.set(cwd, { name: cwd.split("/").pop() || cwd, cwd, status: "running" });
  }
  return [...byCwd.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function telegramBotPayload(identity: TelegramBotIdentity) {
  return {
    id: identity.id,
    name: identity.name,
    username: identity.username,
    webUrl: identity.username ? `https://web.telegram.org/k/#@${identity.username}` : undefined,
    appUrl: identity.username ? `tg://resolve?domain=${identity.username}` : undefined,
  };
}

export function openExternal(url: string): void {
  const platform = process.platform;
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    execFile(command, args, { windowsHide: true }, () => {});
  } catch {
    // Best-effort; frontend falls back to window.open.
  }
}
