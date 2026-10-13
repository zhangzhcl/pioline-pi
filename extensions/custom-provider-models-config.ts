// ABOUTME: Provider URL/ID normalization, model payload parsing, and models.json builder/merger.

export type ProviderProtocol = "openai-completions" | "anthropic-messages";

export type ProbeModel = {
  id: string;
  name?: string;
  ownedBy?: string;
  /** Context-window tokens advertised by the upstream relay, when supplied. */
  contextWindow?: number;
  /** Maximum output tokens advertised by the upstream relay, when supplied. */
  maxTokens?: number;
};

export type ProtocolProbeAttempt = {
  protocol: ProviderProtocol;
  ok: boolean;
  status?: number;
  latencyMs: number;
  endpoint: string;
  error?: string;
  models?: ProbeModel[];
};

export type ProtocolProbeResult = {
  baseUrl: string;
  protocol: ProviderProtocol | "unknown";
  confidence: "high" | "medium" | "low" | "none";
  latencyMs?: number;
  models: ProbeModel[];
  attempts: ProtocolProbeAttempt[];
  error?: string;
};

export type ConnectivityProbeResult = {
  ok: boolean;
  protocol: ProviderProtocol;
  latencyMs: number;
  endpoint: string;
  status?: number;
  error?: string;
};

export type ModelsJsonProvider = {
  baseUrl: string;
  api: ProviderProtocol;
  apiKey?: string;
  authHeader?: boolean;
  models: Array<{
    id: string;
    name?: string;
    reasoning?: boolean;
    input?: string[];
    contextWindow?: number;
    maxTokens?: number;
    cost?: Record<string, number>;
    thinkingLevelMap?: Record<string, string | null>;
    compat?: Record<string, unknown>;
  }>;
  compat?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ModelsJsonDocument = {
  providers?: Record<string, ModelsJsonProvider>;
  [key: string]: unknown;
};

const OPENAI_COMPAT_HINTS = [
  "openai",
  "gpt-",
  "o1",
  "o3",
  "deepseek",
  "qwen",
  "glm",
  "moonshot",
  "doubao",
  "yi-",
  "llama",
  "mistral",
  "gemini",
];

const CLAUDE_HINTS = ["claude", "anthropic", "haiku", "sonnet", "opus"];

const NON_CHAT_MODEL_HINTS = [
  "whisper",
  "tts",
  "orpheus",
  "prompt-guard",
  "playai",
  "distil-whisper",
  "canopylabs/",
];

const REASONING_MODEL_HINTS = ["gpt-oss", "o1", "o3", "o4", "/compound"];

const DEFAULT_OPENAI_MAX_TOKENS = 16384;
const GROQ_CHAT_MAX_OUTPUT_TOKENS = 2048;
const GROQ_REASONING_MAX_OUTPUT_TOKENS = 2048;
const MIN_AGENT_CONTEXT_WINDOW = 2048;

export function isLikelyNonChatModel(id: string, contextWindow?: number): boolean {
  const hay = String(id || "").toLowerCase();
  if (!hay) return true;
  if (NON_CHAT_MODEL_HINTS.some((hint) => hay.includes(hint))) return true;
  if (contextWindow && contextWindow > 0 && contextWindow < MIN_AGENT_CONTEXT_WINDOW) return true;
  return false;
}

function looksReasoningModel(id: string): boolean {
  const hay = String(id || "").toLowerCase();
  return REASONING_MODEL_HINTS.some((hint) => hay.includes(hint));
}

function isGroqBaseUrl(baseUrl: string): boolean {
  return /groq\.com/i.test(baseUrl);
}

function openaiCompletionsCompat(baseUrl: string): Record<string, unknown> {
  const groq = isGroqBaseUrl(baseUrl);
  return {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsStore: false,
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
    maxTokensField: groq ? "max_completion_tokens" : "max_tokens",
  };
}

function groqMaxOutputTokens(id: string): number {
  return looksReasoningModel(id) ? GROQ_REASONING_MAX_OUTPUT_TOKENS : GROQ_CHAT_MAX_OUTPUT_TOKENS;
}

function groqThinkingLevelMap(id: string): Record<string, string> | undefined {
  if (!looksReasoningModel(id)) return undefined;
  return {
    off: "low",
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
    max: "high",
  };
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("baseUrl is required");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("baseUrl must be a valid absolute URL (http/https)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  url.hash = "";
  url.search = "";
  let href = url.toString();
  if (href.endsWith("/")) href = href.slice(0, -1);
  return href;
}

export function sanitizeProviderId(raw: string): string {
  const id = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-");
  if (!id) throw new Error("provider id is required");
  if (id.length > 64) throw new Error("provider id is too long (max 64)");
  return id;
}

export function suggestProviderIdFromBaseUrl(baseUrl: string): string {
  let host = "";
  try {
    host = new URL(normalizeBaseUrl(baseUrl)).hostname || "";
  } catch {
    host = String(baseUrl || "")
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .split(":")[0];
  }
  host = host
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!host) return "custom-relay";
  const parts = host.split(".").filter(Boolean);
  let slug = parts.length >= 2 ? `${parts[parts.length - 2]}-${parts[parts.length - 1]}` : host;
  slug = slug.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) slug = "custom-relay";
  if (slug.length > 48) slug = slug.slice(0, 48).replace(/-+$/g, "");
  return slug;
}

export function resolveProviderId(raw: string | undefined, baseUrl?: string): string {
  const trimmed = String(raw || "").trim();
  if (trimmed) {
    try {
      return sanitizeProviderId(trimmed);
    } catch {
      // fall through to baseUrl / default
    }
  }
  if (baseUrl && String(baseUrl).trim()) {
    return sanitizeProviderId(suggestProviderIdFromBaseUrl(baseUrl));
  }
  throw new Error(
    "provider id is required (use English letters/numbers, or leave blank to auto-fill from Base URL)",
  );
}

export function joinUrl(baseUrl: string, pathPart: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const part = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  if (base.endsWith("/v1") && part.startsWith("/v1/")) {
    return `${base}${part.slice(3)}`;
  }
  return `${base}${part}`;
}

export function openaiAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export function anthropicAuthHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
}

function positiveTokenLimit(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function modelTokenLimit(item: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = positiveTokenLimit(item[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function parseOpenAiModels(payload: unknown): ProbeModel[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const models: ProbeModel[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || !id.trim()) continue;
    if (isLikelyNonChatModel(id.trim())) continue;
    const name =
      typeof record.name === "string"
        ? record.name
        : typeof record.display_name === "string"
          ? record.display_name
          : undefined;
    const ownedBy = typeof record.owned_by === "string" ? record.owned_by : undefined;
    const contextWindow = modelTokenLimit(record, [
      "context_window",
      "contextWindow",
      "context_length",
      "contextLength",
      "max_context_tokens",
      "maxContextTokens",
    ]);
    const maxTokens = modelTokenLimit(record, [
      "max_output_tokens",
      "maxOutputTokens",
      "max_tokens",
      "maxTokens",
      "output_token_limit",
      "outputTokenLimit",
    ]);
    models.push({
      id: id.trim(),
      name,
      ownedBy,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
    });
  }
  return models.filter((model) => !isLikelyNonChatModel(model.id, model.contextWindow));
}

export function parseAnthropicModels(payload: unknown): ProbeModel[] {
  const fromData = parseOpenAiModels(payload);
  if (fromData.length > 0) return fromData;
  if (!payload || typeof payload !== "object") return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const out: ProbeModel[] = [];
  for (const item of models) {
    if (typeof item === "string" && item.trim()) {
      out.push({ id: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const id =
      typeof (item as { id?: unknown }).id === "string"
        ? (item as { id: string }).id
        : typeof (item as { name?: unknown }).name === "string"
          ? (item as { name: string }).name
          : "";
    if (!id.trim()) continue;
    const record = item as Record<string, unknown>;
    const name =
      typeof record.display_name === "string"
        ? record.display_name
        : typeof record.name === "string"
          ? record.name
          : undefined;
    const contextWindow = modelTokenLimit(record, [
      "context_window",
      "contextWindow",
      "context_length",
      "contextLength",
      "max_context_tokens",
    ]);
    const maxTokens = modelTokenLimit(record, [
      "max_output_tokens",
      "maxOutputTokens",
      "max_tokens",
      "maxTokens",
      "output_token_limit",
    ]);
    out.push({
      id: id.trim(),
      name,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
    });
  }
  return out;
}

export function scoreProtocolFromModels(models: ProbeModel[], preferred: ProviderProtocol): number {
  if (models.length === 0) return preferred === "openai-completions" ? 1 : 0;
  let openaiHits = 0;
  let claudeHits = 0;
  for (const model of models) {
    const hay = `${model.id} ${model.name || ""} ${model.ownedBy || ""}`.toLowerCase();
    if (CLAUDE_HINTS.some((h) => hay.includes(h))) claudeHits += 1;
    if (OPENAI_COMPAT_HINTS.some((h) => hay.includes(h))) openaiHits += 1;
  }
  if (preferred === "anthropic-messages") {
    return claudeHits * 3 + (models.length > 0 ? 1 : 0) - openaiHits;
  }
  return openaiHits * 2 + (models.length > 0 ? 2 : 0) - claudeHits;
}

export function buildModelsJsonProviderEntry(options: {
  baseUrl: string;
  protocol: ProviderProtocol;
  models: Array<string | ProbeModel>;
  apiKey?: string;
  includeApiKeyInFile?: boolean;
}): ModelsJsonProvider {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const models = options.models
    .map((m) => {
      const id = typeof m === "string" ? m.trim() : String(m.id || "").trim();
      if (!id) return null;
      const advertisedContext = typeof m === "string" ? undefined : m.contextWindow;
      if (
        options.protocol === "openai-completions" &&
        isLikelyNonChatModel(id, advertisedContext)
      ) {
        return null;
      }
      const name = typeof m === "string" ? undefined : m.name ? String(m.name) : undefined;
      const looksClaude = /claude|opus|sonnet|haiku|anthropic/i.test(id);
      const contextWindow =
        typeof m === "string"
          ? looksClaude
            ? 200000
            : 128000
          : m.contextWindow || (looksClaude ? 200000 : 128000);
      let maxTokens =
        typeof m === "string"
          ? looksClaude
            ? 8192
            : DEFAULT_OPENAI_MAX_TOKENS
          : m.maxTokens || (looksClaude ? 8192 : DEFAULT_OPENAI_MAX_TOKENS);
      if (isGroqBaseUrl(baseUrl)) {
        maxTokens = looksReasoningModel(id)
          ? Math.min(groqMaxOutputTokens(id), contextWindow)
          : Math.min(maxTokens, groqMaxOutputTokens(id), contextWindow);
      } else {
        maxTokens = Math.min(maxTokens, contextWindow);
      }
      const thinkingLevelMap = isGroqBaseUrl(baseUrl) ? groqThinkingLevelMap(id) : undefined;
      return {
        id,
        ...(name ? { name } : {}),
        reasoning:
          looksClaude || looksReasoningModel(id) || options.protocol === "anthropic-messages",
        input: ["text"] as string[],
        contextWindow,
        maxTokens,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        ...(isGroqBaseUrl(baseUrl) && looksReasoningModel(id)
          ? { compat: { supportsReasoningEffort: true } }
          : {}),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    })
    .filter((m): m is NonNullable<typeof m> => Boolean(m));
  if (models.length === 0) {
    throw new Error("At least one model id is required");
  }
  const entry: ModelsJsonProvider = {
    baseUrl,
    api: options.protocol,
    models,
  };
  if (options.protocol === "openai-completions") {
    entry.compat = openaiCompletionsCompat(baseUrl);
    entry.authHeader = true;
  }
  if (options.includeApiKeyInFile && options.apiKey) {
    entry.apiKey = options.apiKey;
  }
  return entry;
}

export function mergeProviderIntoModelsJson(
  existing: unknown,
  providerId: string,
  entry: ModelsJsonProvider,
): ModelsJsonDocument {
  const id = sanitizeProviderId(providerId);
  const doc: ModelsJsonDocument =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as ModelsJsonDocument) }
      : { providers: {} };
  const providers =
    doc.providers && typeof doc.providers === "object" && !Array.isArray(doc.providers)
      ? { ...doc.providers }
      : {};
  providers[id] = entry;
  doc.providers = providers;
  return doc;
}
