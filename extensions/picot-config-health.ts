// ABOUTME: Model health check probes (HTTP and agent session) for picot-config.

import * as fs from "node:fs";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { type ProviderProtocol, testProviderConnectivity } from "./custom-provider-probe";
import {
  type CatalogModel,
  type CatalogRegistry,
  credentialKey,
  errMessage,
  MODELS_CONFIG_PATH,
  type ModelHealth,
  type ModelPreferencesStore,
  type RegistryInternals,
  readAuthConfig,
} from "./picot-config-models";

function sanitizeHealthError(error: unknown): string {
  const raw = errMessage(error) || "Health check failed";
  return raw
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "bearer [REDACTED]")
    .slice(0, 240);
}

function protocolFromModelApi(api: unknown): ProviderProtocol | null {
  const value = String(api || "").trim();
  if (value === "anthropic-messages") return "anthropic-messages";
  if (
    value === "openai-completions" ||
    value === "openai-responses" ||
    value === "azure-openai-responses" ||
    value === "mistral-conversations"
  ) {
    return "openai-completions";
  }
  return null;
}

async function resolveProviderApiKeyForHealthCheck(
  registry: CatalogRegistry,
  provider: string,
  model: CatalogModel,
): Promise<string | undefined> {
  if (typeof registry.getApiKeyForProvider === "function") {
    try {
      const key = await registry.getApiKeyForProvider(provider);
      if (typeof key === "string" && key.trim()) return key.trim();
    } catch {
      // fall through
    }
  }
  if (typeof registry.getApiKeyAndHeaders === "function") {
    try {
      const auth = await registry.getApiKeyAndHeaders(model);
      if (auth?.ok !== false && typeof auth?.apiKey === "string" && auth.apiKey.trim()) {
        return auth.apiKey.trim();
      }
    } catch {
      // fall through
    }
  }
  const internals = registry as CatalogRegistry & RegistryInternals;
  const store = internals.runtime?.credentials ?? internals.credentials;
  if (typeof store?.read === "function") {
    try {
      const key = credentialKey(await store.read(provider));
      if (key) return key;
    } catch {
      // fall through
    }
  }
  try {
    const key = credentialKey(readAuthConfig()[provider]);
    if (key) return key;
  } catch {
    // ignore
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(MODELS_CONFIG_PATH, "utf8")) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    const key = parsed.providers?.[provider]?.apiKey;
    if (typeof key === "string" && key.trim()) return key.trim();
  } catch {
    // ignore
  }
  return undefined;
}

async function runHttpModelHealthCheck(
  registry: CatalogRegistry,
  model: CatalogModel,
): Promise<{ ok: boolean; latencyMs: number; error?: string } | null> {
  const protocol = protocolFromModelApi(model.api);
  const baseUrl = typeof model.baseUrl === "string" ? model.baseUrl.trim() : "";
  const provider = typeof model.provider === "string" ? model.provider : "";
  const modelId = typeof model.id === "string" ? model.id : "";
  if (!protocol || !baseUrl || !provider || !modelId) return null;
  const apiKey = await resolveProviderApiKeyForHealthCheck(registry, provider, model);
  if (!apiKey) return null;
  const probe = await testProviderConnectivity({
    baseUrl,
    apiKey,
    protocol,
    modelId,
  });
  return {
    ok: probe.ok,
    latencyMs: probe.latencyMs,
    error: probe.ok
      ? undefined
      : probe.error || (probe.status ? `HTTP ${probe.status}` : "Health check failed"),
  };
}

async function runSessionModelHealthCheck(model: CatalogModel): Promise<{
  ok: boolean;
  error?: string;
}> {
  let sawAssistantText = false;
  const modelRuntime = await ModelRuntime.create();
  const { session } = await createAgentSession({
    model,
    tools: [],
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
  });
  try {
    const unsubscribe = session.subscribe((event: unknown) => {
      const evt = event as {
        assistantMessageEvent?: { type?: string; delta?: string };
        message?: { content?: unknown };
      };
      if (
        evt.assistantMessageEvent?.type === "text_delta" &&
        typeof evt.assistantMessageEvent.delta === "string" &&
        evt.assistantMessageEvent.delta.length > 0
      ) {
        sawAssistantText = true;
      }
      const content = evt.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            (block as { type?: string }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string" &&
            (block as { text: string }).text.trim()
          ) {
            sawAssistantText = true;
          }
        }
      }
    });
    try {
      await session.prompt("Reply exactly: OK");
    } finally {
      unsubscribe();
    }
  } finally {
    session.dispose();
  }
  return {
    ok: sawAssistantText,
    error: sawAssistantText ? undefined : "No assistant text returned",
  };
}

export async function runModelHealthCheck(
  registry: CatalogRegistry,
  model: CatalogModel,
  preferences: ModelPreferencesStore,
): Promise<{ provider: string; modelId: string } & ModelHealth> {
  const provider = model.provider;
  const modelId = model.id;
  const startedAt = Date.now();
  try {
    const httpProbe = await runHttpModelHealthCheck(registry, model);
    const probe = httpProbe ?? (await runSessionModelHealthCheck(model));
    const result: { provider: string; modelId: string } & ModelHealth = {
      provider,
      modelId,
      status: probe.ok ? "healthy" : "unhealthy",
      checkedAt: new Date().toISOString(),
      latencyMs: httpProbe?.latencyMs ?? Date.now() - startedAt,
      error: probe.ok ? undefined : sanitizeHealthError(probe.error || "Health check failed"),
    };
    preferences.setHealth(provider, modelId, result);
    return result;
  } catch (e: unknown) {
    const result: { provider: string; modelId: string } & ModelHealth = {
      provider,
      modelId,
      status: "unhealthy",
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: sanitizeHealthError(e),
    };
    preferences.setHealth(provider, modelId, result);
    return result;
  }
}
