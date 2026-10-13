// ABOUTME: Model catalog, visibility, health check, API key, and custom provider ops for picot-config.

import * as fs from "node:fs";
import {
  buildModelsJsonProviderEntry,
  detectProviderProtocol,
  fetchUpstreamModels,
  type ModelsJsonDocument,
  mergeProviderIntoModelsJson,
  normalizeBaseUrl,
  resolveProviderId,
  testProviderConnectivity,
} from "./custom-provider-probe";
import {
  asProviderProtocol,
  buildModelCatalog,
  type CatalogRegistry,
  invalidateModelCatalogCache,
  logModelLoadEvent,
  MODELS_CONFIG_PATH,
  type ModelPreferencesStore,
  modelPreferenceKey,
  parseProbeModels,
  refreshRegistryBestEffort,
  removeStoredApiKey,
  runModelHealthCheck,
  setStoredApiKey,
} from "./picot-config-models";
import {
  AGENT_CONFIG_PATH,
  asString,
  backupConfigFile,
  readConfigFile,
  readEnabledModels,
  readSettingsObject,
  scopedModelId,
  setScopedModel,
  writeConfigFile,
} from "./picot-config-settings";

export async function handleModelConfigOp(
  op: string,
  params: Record<string, unknown>,
  registry: CatalogRegistry | undefined,
  requireRegistry: () => CatalogRegistry,
  preferences: ModelPreferencesStore,
): Promise<{ ok: true; data?: unknown } | null> {
  switch (op) {
    case "list_model_catalog": {
      const handlerStartedAt = performance.now();
      const catalog = await buildModelCatalog(requireRegistry(), preferences);
      logModelLoadEvent("list_model_catalog_handled", {
        source: "backend",
        totalMs: Math.round(performance.now() - handlerStartedAt),
      });
      return { ok: true, data: catalog };
    }

    case "list_model_visibility": {
      return { ok: true, data: { visibility: preferences.read().visibility } };
    }

    case "log_client_perf": {
      const event = asString(params.event) || "client_event";
      const { event: _event, ...fields } = params;
      logModelLoadEvent(event, { source: "frontend", ...fields });
      return { ok: true };
    }

    case "set_model_visibility": {
      const provider = asString(params.provider);
      const modelId = asString(params.modelId);
      if (!provider || !modelId) throw new Error("provider and modelId are required");
      const visible = params.visible === true;
      preferences.setVisibility(provider, modelId, visible);
      return { ok: true, data: { provider, modelId, visible } };
    }

    case "check_model_health": {
      const reg = requireRegistry();
      const provider = asString(params.provider);
      const modelId = asString(params.modelId);
      if (!provider) throw new Error("provider is required");
      const availableKeys = new Set(
        (await reg.getAvailable())
          .filter((model) => model.provider && model.id)
          .map((model) => modelPreferenceKey(model.provider as string, model.id as string)),
      );
      const models = reg.getAll().filter((model) => {
        if (model.provider !== provider || !model.id) return false;
        if (modelId) return model.id === modelId;
        return availableKeys.has(modelPreferenceKey(provider, model.id as string));
      });
      if (models.length === 0) throw new Error("No matching models available for health check");
      const results = await Promise.all(
        models.map((model) => runModelHealthCheck(reg, model, preferences)),
      );
      return { ok: true, data: { results } };
    }

    case "set_api_key": {
      const provider = asString(params.provider);
      const apiKey = asString(params.apiKey);
      if (!provider) throw new Error("provider is required");
      if (!apiKey) throw new Error("apiKey is required");
      await setStoredApiKey(registry, provider, apiKey);
      if (registry) {
        await registry.refresh();
        invalidateModelCatalogCache();
      }
      return { ok: true, data: { provider } };
    }

    case "remove_api_key": {
      const provider = asString(params.provider);
      if (!provider) throw new Error("provider is required");
      await removeStoredApiKey(registry, provider);
      if (registry) {
        await registry.refresh();
        invalidateModelCatalogCache();
      }
      return { ok: true, data: { provider } };
    }

    case "list_scoped_models": {
      const models = readEnabledModels(readSettingsObject(AGENT_CONFIG_PATH));
      return { ok: true, data: { modelIds: models.map(scopedModelId) } };
    }

    case "set_scoped_model":
      return {
        ok: true,
        data: setScopedModel(params.provider, params.modelId, params.enabled),
      };

    case "read_models_config":
      return { ok: true, data: readConfigFile(MODELS_CONFIG_PATH, '{\n  "providers": {}\n}\n') };

    case "write_models_config": {
      const content = params.content;
      if (typeof content !== "string") throw new Error("content must be a string");
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("models.json must be a JSON object");
      }
      if (
        "providers" in parsed &&
        (typeof parsed.providers !== "object" || Array.isArray(parsed.providers))
      ) {
        throw new Error("'providers' must be an object");
      }
      backupConfigFile(MODELS_CONFIG_PATH);
      writeConfigFile(MODELS_CONFIG_PATH, content);
      const refreshed = await refreshRegistryBestEffort(registry);
      return { ok: true, data: { path: MODELS_CONFIG_PATH, refreshed } };
    }

    case "detect_custom_provider": {
      const preferredRaw = asString(params.preferred) || "auto";
      const preferred =
        preferredRaw === "openai-completions" || preferredRaw === "anthropic-messages"
          ? preferredRaw
          : "auto";
      const result = await detectProviderProtocol({
        baseUrl: asString(params.baseUrl),
        apiKey: asString(params.apiKey),
        preferred,
      });
      return { ok: true, data: result };
    }

    case "list_custom_provider_models": {
      const listed = await fetchUpstreamModels({
        baseUrl: asString(params.baseUrl),
        apiKey: asString(params.apiKey),
        protocol: asProviderProtocol(params.protocol),
      });
      return { ok: true, data: listed };
    }

    case "test_custom_provider": {
      const result = await testProviderConnectivity({
        baseUrl: asString(params.baseUrl),
        apiKey: asString(params.apiKey),
        protocol: asProviderProtocol(params.protocol),
        modelId: asString(params.modelId) || undefined,
      });
      return { ok: true, data: result };
    }

    case "save_custom_provider": {
      const protocol = asProviderProtocol(params.protocol);
      const baseUrl = normalizeBaseUrl(asString(params.baseUrl));
      const providerId = resolveProviderId(asString(params.providerId), baseUrl);
      const models = parseProbeModels(params);
      if (models.length === 0) throw new Error("Select at least one model");
      const apiKey = asString(params.apiKey);
      const storeKey = params.storeKey !== false;
      const includeApiKeyInFile = params.includeApiKeyInFile === true;
      if (storeKey && !apiKey) throw new Error("apiKey is required when storeKey is true");
      const entry = buildModelsJsonProviderEntry({
        baseUrl,
        protocol,
        models,
        apiKey,
        includeApiKeyInFile,
      });
      let existing: unknown = { providers: {} };
      if (fs.existsSync(MODELS_CONFIG_PATH)) {
        try {
          existing = JSON.parse(fs.readFileSync(MODELS_CONFIG_PATH, "utf8"));
        } catch {
          existing = { providers: {} };
        }
      }
      const merged = mergeProviderIntoModelsJson(existing as ModelsJsonDocument, providerId, entry);
      writeConfigFile(MODELS_CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
      let keyStored = false;
      if (storeKey && apiKey) {
        await setStoredApiKey(registry, providerId, apiKey);
        keyStored = true;
      }
      const refreshed = await refreshRegistryBestEffort(registry);
      return {
        ok: true,
        data: {
          providerId,
          baseUrl,
          protocol,
          modelCount: models.length,
          keyStored,
          refreshed,
          path: MODELS_CONFIG_PATH,
        },
      };
    }

    default:
      return null;
  }
}
