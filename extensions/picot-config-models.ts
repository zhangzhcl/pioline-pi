// ABOUTME: Model preferences store, model catalog cache, and API credential helpers for picot-config.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ProbeModel, ProviderProtocol } from "./custom-provider-probe";
import { resolvePiAgentRoot } from "./pi-agent-paths";

export { runModelHealthCheck } from "./picot-config-health";

export type ModelHealthStatus = "unknown" | "healthy" | "unhealthy";

export type ModelHealth = {
  status: ModelHealthStatus;
  checkedAt?: string;
  latencyMs?: number;
  error?: string;
};

export type ModelPreferencesFile = {
  visibility?: Record<string, boolean>;
  health?: Record<string, ModelHealth>;
};

export type CatalogModel = ReturnType<ModelRegistry["getAll"]>[number];

export type CatalogRegistry = {
  getAll: () => CatalogModel[];
  getAvailable: () => CatalogModel[] | Promise<CatalogModel[]>;
  getProviderAuthStatus: (provider: string) => {
    configured?: boolean;
    source?: string;
    label?: string;
  };
  getProviderDisplayName: (provider: string) => string;
  refresh: () => undefined | Promise<unknown>;
  getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
  getApiKeyAndHeaders?: (model: CatalogModel) => Promise<{
    ok?: boolean;
    apiKey?: string;
  }>;
};

type ApiKeyCredential = { type: "api_key"; key: string };

type CredentialStoreLike = {
  modify?: (
    provider: string,
    fn: (current: unknown) => Promise<ApiKeyCredential | undefined>,
  ) => Promise<unknown>;
  delete?: (provider: string) => Promise<void>;
  read?: (provider: string) => Promise<unknown>;
};

export type RegistryInternals = {
  runtime?: { credentials?: CredentialStoreLike };
  credentials?: CredentialStoreLike;
  authStorage?: {
    set?: (provider: string, value: ApiKeyCredential) => void | Promise<void>;
    remove?: (provider: string) => void | Promise<void>;
  };
};

const PI_AGENT_ROOT = resolvePiAgentRoot();
export const MODELS_PREFS_PATH = path.join(PI_AGENT_ROOT, "picot-models.json");
export const MODELS_CONFIG_PATH = path.join(PI_AGENT_ROOT, "models.json");
export const AUTH_CONFIG_PATH = path.join(PI_AGENT_ROOT, "auth.json");
const MODEL_LOAD_LOG_PATH = path.join(PI_AGENT_ROOT, "logs", "model-load.log");
const MODEL_REGISTRY_REFRESH_TIMEOUT_MS = 2_000;
const MODEL_LOAD_TRACING_ENABLED = process.env.PICOT_DEV === "1";

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function logModelLoadEvent(event: string, fields: Record<string, unknown> = {}): void {
  if (!MODEL_LOAD_TRACING_ENABLED) return;
  try {
    fs.mkdirSync(path.dirname(MODEL_LOAD_LOG_PATH), { recursive: true });
    const line = `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`;
    fs.appendFileSync(MODEL_LOAD_LOG_PATH, line, "utf8");
  } catch {
    // Best-effort only — never let logging break the caller.
  }
}

export function modelPreferenceKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function normalizeModelHealth(value: unknown): ModelHealth {
  if (!value || typeof value !== "object") return { status: "unknown" };
  const candidate = value as Partial<ModelHealth>;
  if (candidate.status !== "healthy" && candidate.status !== "unhealthy") {
    return { status: "unknown" };
  }
  const health: ModelHealth = {
    status: candidate.status,
    checkedAt: typeof candidate.checkedAt === "string" ? candidate.checkedAt : undefined,
    latencyMs: typeof candidate.latencyMs === "number" ? candidate.latencyMs : undefined,
  };
  if (typeof candidate.error === "string") health.error = candidate.error;
  return health;
}

export class ModelPreferencesStore {
  readonly path: string;

  constructor(filePath = MODELS_PREFS_PATH) {
    this.path = filePath;
  }

  read(): Required<ModelPreferencesFile> {
    if (!fs.existsSync(this.path)) return { visibility: {}, health: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.path, "utf8")) as ModelPreferencesFile;
      return {
        visibility:
          parsed.visibility &&
          typeof parsed.visibility === "object" &&
          !Array.isArray(parsed.visibility)
            ? parsed.visibility
            : {},
        health:
          parsed.health && typeof parsed.health === "object" && !Array.isArray(parsed.health)
            ? parsed.health
            : {},
      };
    } catch {
      return { visibility: {}, health: {} };
    }
  }

  write(next: Required<ModelPreferencesFile>): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify(next, null, 2), "utf8");
    invalidateModelCatalogCache();
  }

  isVisible(provider: string, modelId: string): boolean {
    return this.read().visibility[modelPreferenceKey(provider, modelId)] !== false;
  }

  setVisibility(provider: string, modelId: string, visible: boolean): void {
    const prefs = this.read();
    prefs.visibility[modelPreferenceKey(provider, modelId)] = visible;
    this.write(prefs);
  }

  getHealth(provider: string, modelId: string): ModelHealth {
    return normalizeModelHealth(this.read().health[modelPreferenceKey(provider, modelId)]);
  }

  setHealth(provider: string, modelId: string, health: ModelHealth): void {
    const prefs = this.read();
    prefs.health[modelPreferenceKey(provider, modelId)] = normalizeModelHealth(health);
    this.write(prefs);
  }
}

const MODEL_CATALOG_CACHE_TTL_MS = 3_000;
let modelCatalogCache: {
  expires: number;
  promise: ReturnType<typeof buildModelCatalogUncached>;
} | null = null;

export function invalidateModelCatalogCache(): void {
  modelCatalogCache = null;
}

export async function buildModelCatalog(
  registry: CatalogRegistry,
  preferences: ModelPreferencesStore,
) {
  if (modelCatalogCache && modelCatalogCache.expires > Date.now()) {
    return modelCatalogCache.promise;
  }
  const promise = buildModelCatalogUncached(registry, preferences);
  modelCatalogCache = { expires: Date.now() + MODEL_CATALOG_CACHE_TTL_MS, promise };
  promise.catch(() => invalidateModelCatalogCache());
  return promise;
}

async function buildModelCatalogUncached(
  registry: CatalogRegistry,
  preferences: ModelPreferencesStore,
) {
  const startedAt = performance.now();
  const allModels = registry.getAll();
  const getAllMs = performance.now() - startedAt;
  const availableModels = await registry.getAvailable();
  const getAvailableMs = performance.now() - startedAt - getAllMs;
  logModelLoadEvent("catalog_built", {
    source: "backend",
    getAllMs: Math.round(getAllMs),
    getAvailableMs: Math.round(getAvailableMs),
    totalMs: Math.round(performance.now() - startedAt),
    modelCount: allModels.length,
    availableCount: availableModels.length,
  });
  const availableKeys = new Set(
    availableModels
      .filter((model) => model.provider && model.id)
      .map((model) => modelPreferenceKey(model.provider as string, model.id as string)),
  );
  const prefs = preferences.read();
  const providerSet = new Set<string>();
  const modelsByProvider = new Map<string, CatalogModel[]>();
  for (const model of allModels) {
    const providerName = model.provider;
    if (!providerName) continue;
    providerSet.add(providerName);
    if (!model.id || !availableKeys.has(modelPreferenceKey(providerName, model.id as string))) {
      continue;
    }
    let list = modelsByProvider.get(providerName);
    if (!list) {
      list = [];
      modelsByProvider.set(providerName, list);
    }
    list.push(model);
  }
  const providerNames = Array.from(providerSet).sort();

  return {
    providers: providerNames.map((providerName) => {
      const status = registry.getProviderAuthStatus(providerName);
      const providerModels = modelsByProvider.get(providerName) ?? [];
      providerModels.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return {
        provider: providerName,
        displayName: registry.getProviderDisplayName(providerName),
        configured: Boolean(status.configured),
        source: status.source,
        label: status.label,
        models: providerModels.map((model) => {
          const modelId = model.id as string;
          const prefKey = modelPreferenceKey(providerName, modelId);
          return {
            provider: providerName,
            id: modelId,
            name: model.name,
            contextWindow: model.contextWindow,
            available: true,
            visible: prefs.visibility[prefKey] !== false,
            health: normalizeModelHealth(prefs.health[prefKey]),
          };
        }),
      };
    }),
  };
}

export function credentialKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cred = value as { type?: string; key?: unknown; access?: unknown };
  if (cred.type === "api_key" && typeof cred.key === "string" && cred.key.trim()) {
    return cred.key.trim();
  }
  if (cred.type === "oauth" && typeof cred.access === "string" && cred.access.trim()) {
    return cred.access.trim();
  }
  return undefined;
}

export function readAuthConfig(): Record<string, unknown> {
  if (!fs.existsSync(AUTH_CONFIG_PATH)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function writeAuthConfig(auth: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(AUTH_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(auth, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(AUTH_CONFIG_PATH, 0o600);
  } catch {
    // chmod is best-effort on platforms/filesystems that do not support POSIX modes.
  }
}

export async function setStoredApiKey(
  registry: CatalogRegistry | undefined,
  provider: string,
  apiKey: string,
): Promise<void> {
  const internals = registry as (CatalogRegistry & RegistryInternals) | undefined;
  const credentials = internals?.runtime?.credentials;
  if (credentials?.modify) {
    await credentials.modify(provider, async () => ({ type: "api_key", key: apiKey }));
    return;
  }
  if (internals?.authStorage?.set) {
    await internals.authStorage.set(provider, { type: "api_key", key: apiKey });
    return;
  }
  const auth = readAuthConfig();
  auth[provider] = { type: "api_key", key: apiKey };
  writeAuthConfig(auth);
}

export async function removeStoredApiKey(
  registry: CatalogRegistry | undefined,
  provider: string,
): Promise<void> {
  const internals = registry as (CatalogRegistry & RegistryInternals) | undefined;
  const credentials = internals?.runtime?.credentials;
  if (credentials?.delete) {
    await credentials.delete(provider);
    return;
  }
  if (internals?.authStorage?.remove) {
    await internals.authStorage.remove(provider);
    return;
  }
  if (!fs.existsSync(AUTH_CONFIG_PATH)) return;
  const auth = readAuthConfig();
  delete auth[provider];
  writeAuthConfig(auth);
}

export function asProviderProtocol(value: unknown): ProviderProtocol {
  if (value === "openai-completions" || value === "anthropic-messages") return value;
  throw new Error("protocol must be openai-completions or anthropic-messages");
}

export function parseProbeModels(params: Record<string, unknown>): ProbeModel[] {
  const modelsRaw = params.models;
  if (Array.isArray(modelsRaw)) {
    return modelsRaw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        id: typeof item.id === "string" ? item.id.trim() : "",
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        ...(typeof item.contextWindow === "number" ? { contextWindow: item.contextWindow } : {}),
        ...(typeof item.maxTokens === "number" ? { maxTokens: item.maxTokens } : {}),
      }))
      .filter((model) => Boolean(model.id));
  }
  const modelIds = params.modelIds;
  if (!Array.isArray(modelIds)) return [];
  return modelIds
    .map((id) => (typeof id === "string" ? id.trim() : ""))
    .filter(Boolean)
    .map((id) => ({ id }));
}

export async function refreshRegistryBestEffort(registry?: CatalogRegistry): Promise<boolean> {
  if (!registry) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), MODEL_REGISTRY_REFRESH_TIMEOUT_MS);
      timer.unref?.();
    });
    const refresh = (async () => {
      await registry.refresh();
      invalidateModelCatalogCache();
      return true;
    })().catch(() => false);
    return await Promise.race([refresh, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
