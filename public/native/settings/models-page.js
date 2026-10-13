// Settings → Models 页薄门面：协调模型目录加载、OAuth 认证能力、API Key 卡片与 models.json 主从编辑器。

import { onLocaleChange, t } from "../../i18n.js";
import { createModelsCatalogRowsController } from "./models-catalog-rows.js";
import { createModelsConfigEditorController } from "./models-config-editor.js";
import { createModelsHealthAndKeyController } from "./models-health-and-key-editor.js";
import { createModelsOAuthLoginDialog } from "./models-oauth-login.js";
import {
  buildCodexConnectedCard,
  createProviderPickerController,
  isCodexProvider,
} from "./models-provider-picker.js";

export function setupModelsPage({ configGateway, oauthGateway, onModelConfigurationChanged }) {
  const call = (op, params, options) => configGateway.call(op, params, options);
  const oauthCall = (op, params, options) =>
    oauthGateway
      ? oauthGateway.command({ type: op, ...params }, options)
      : Promise.reject(new Error("oauth unavailable"));
  const apiKeysContainer = document.getElementById("settings-api-keys");
  const providerExpansionState = new Map();
  const modelSearchState = new Map();
  let catalogProviders = [];
  let codexOAuthCapability = null;
  let oauthDialog = null;

  let healthAndKeyController;
  const catalogRowsController = createModelsCatalogRowsController({
    call,
    apiKeysContainer,
    providerExpansionState,
    modelSearchState,
    getCatalogProviders: () => catalogProviders,
    onModelConfigurationChanged,
    onOpenApiKeyEditor: (row, provider) => healthAndKeyController.openApiKeyEditor(row, provider),
    onRemoveApiKey: (provider) => healthAndKeyController.removeApiKey(provider),
    onCheckModelHealth: (provider) => healthAndKeyController.checkModelHealth(provider),
  });

  healthAndKeyController = createModelsHealthAndKeyController({
    call,
    apiKeysContainer,
    getProviderModelRows: catalogRowsController.getProviderModelRows,
    onModelConfigurationChanged,
    loadApiKeysPanel: () => loadApiKeysPanel(),
  });

  let configEditorController;
  const providerPickerController = createProviderPickerController({
    call,
    apiKeysContainer,
    hasOAuthGateway: () => Boolean(oauthGateway),
    getCodexOAuthCapability: () => codexOAuthCapability,
    startOAuthLogin: () => startOAuthLogin(),
    logoutCodex: () => logoutCodex(),
    buildApiKeyRow: catalogRowsController.buildApiKeyRow,
    openApiKeyEditor: healthAndKeyController.openApiKeyEditor,
    onCustomProviderSaved: async (providerId) => {
      configEditorController.selectProvider(providerId);
      await loadInlineModelsEditor();
      await loadApiKeysPanel();
    },
  });

  configEditorController = createModelsConfigEditorController({
    call,
    apiKeysContainer,
    getCatalogProviders: () => catalogProviders,
    buildApiKeyRow: catalogRowsController.buildApiKeyRow,
    buildModelList: catalogRowsController.buildModelList,
    checkModelHealth: healthAndKeyController.checkModelHealth,
    openProviderPicker: providerPickerController.openProviderPicker,
    onModelConfigurationChanged,
  });

  async function loadInlineModelsEditor() {
    return configEditorController.loadInlineModelsEditor();
  }

  async function loadApiKeysPanel(options = {}) {
    if (!apiKeysContainer) return;
    catalogRowsController.rememberProviderExpansionState();
    const scrollContainer = options.preserveUi ? getSettingsScrollContainer() : null;
    const scrollTop = scrollContainer?.scrollTop ?? 0;
    if (!options.preserveUi) {
      const loading = document.createElement("div");
      loading.className = "settings-api-keys-loading";
      loading.textContent = t("settings.loadingProviders");
      apiKeysContainer.replaceChildren(loading);
    }
    let data;
    const startedAt = performance.now();
    console.info("[MODEL-LOAD] requesting model catalog", {
      preserveUi: Boolean(options.preserveUi),
    });
    try {
      data = await call("list_model_catalog");
    } catch (error) {
      logModelLoadOutcome(startedAt, "error", { message: error?.message || String(error) });
      renderApiKeysPanelError(error?.message || t("settings.apiKeys.loadFailed"));
      restoreScroll(scrollContainer, scrollTop);
      return;
    }
    if (!data?.ok || !Array.isArray(data.data?.providers)) {
      logModelLoadOutcome(startedAt, "empty", { error: data?.error });
      renderApiKeysPanelError(data?.error || t("settings.apiKeys.loadFailed"));
      restoreScroll(scrollContainer, scrollTop);
      return;
    }
    logModelLoadOutcome(startedAt, "ok", { providerCount: data.data.providers.length });
    renderApiKeysPanel(data.data.providers);
    restoreScroll(scrollContainer, scrollTop);
  }

  function logModelLoadOutcome(startedAt, outcome, fields = {}) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.info("[MODEL-LOAD] catalog request finished", { outcome, elapsedMs, ...fields });
    call("log_client_perf", {
      event: "list_model_catalog_roundtrip",
      outcome,
      elapsedMs,
      ...fields,
    }).catch(() => {});
  }

  function getSettingsScrollContainer() {
    return (
      apiKeysContainer?.closest?.(".settings-content") ||
      document.scrollingElement ||
      document.documentElement
    );
  }

  function restoreScroll(scrollContainer, scrollTop) {
    if (!scrollContainer) return;
    requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollTop;
    });
  }

  function renderApiKeysPanelError(message) {
    apiKeysContainer.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "settings-api-keys-empty";
    const msg = document.createElement("div");
    msg.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "ui-button ui-button--secondary config-editor-cancel";
    retry.textContent = t("actions.retry");
    retry.style.marginTop = "var(--space-2)";
    retry.addEventListener("click", () => loadApiKeysPanel());
    wrap.appendChild(msg);
    wrap.appendChild(retry);
    apiKeysContainer.appendChild(wrap);
  }

  function renderApiKeysPanel(providers) {
    catalogProviders = providers;
    if (configEditorController.inlineModelsTextarea) {
      if (!configEditorController.inlineModelsTextarea.value.trim()) {
        configEditorController.inlineModelsTextarea.value = '{\n  "providers": {}\n}';
      }
      configEditorController.renderModelsConfigLayout();
      return;
    }

    apiKeysContainer.replaceChildren();
    const configured = providers.filter(
      (provider) => provider.configured && !isCodexProvider(provider),
    );
    for (const provider of configured.sort((a, b) =>
      (a.displayName || a.provider).localeCompare(b.displayName || b.provider),
    )) {
      apiKeysContainer.appendChild(catalogRowsController.buildApiKeyRow(provider));
    }
    if (codexOAuthCapability?.configured) {
      apiKeysContainer.appendChild(buildCodexConnectedCard({ onLogout: () => logoutCodex() }));
    }
  }

  async function loadOAuthCapability() {
    if (!oauthGateway) return;
    try {
      const resp = await oauthCall("get_oauth_login_capabilities");
      const providers =
        resp?.success && Array.isArray(resp.data?.providers) ? resp.data.providers : [];
      codexOAuthCapability = providers.find((p) => p.providerId === "openai-codex") ?? null;
    } catch {
      codexOAuthCapability = null;
    }
    if (apiKeysContainer?.isConnected && catalogProviders.length > 0) {
      renderApiKeysPanel(catalogProviders);
    }
  }

  function startOAuthLogin() {
    oauthDialog?.destroy();
    oauthDialog = createModelsOAuthLoginDialog({
      command: (frame) => oauthCall(frame.type, frame),
      subscribe: (handler) => oauthGateway.subscribe(handler),
      openExternal: (url) => {
        call("open_external", { url }).catch((error) => {
          console.warn("[models-page] open_external failed:", error);
        });
      },
      copyText: (text) => {
        void navigator.clipboard?.writeText(text);
      },
      onSuccess: async () => {
        await onModelConfigurationChanged?.();
        await loadApiKeysPanel();
        await loadOAuthCapability();
        await loadInlineModelsEditor();
      },
      onTerminal: () => {},
    });
    void oauthDialog.start().catch((error) => {
      console.warn("[models-page] OAuth login failed to start:", error);
    });
  }

  async function logoutCodex() {
    const ok = confirm(t("settings.models.oauth.logoutConfirm", { provider: "OpenAI Codex" }));
    if (!ok) return;
    const resp = await call("oauth_logout", { provider: "openai-codex" }).catch(() => null);
    if (resp?.ok) {
      await onModelConfigurationChanged?.();
      await loadApiKeysPanel();
      await loadOAuthCapability();
    }
  }

  onLocaleChange(() => {
    if (apiKeysContainer?.isConnected) void loadApiKeysPanel({ preserveUi: true });
  });

  return { loadApiKeysPanel, loadInlineModelsEditor, loadOAuthCapability };
}
