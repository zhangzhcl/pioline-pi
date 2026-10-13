// 模型设置页：models.json 主从布局、高级 JSON 编辑器弹窗与持久化。

import { t } from "../../i18n.js";
import { bindDialogEscape } from "../../ui/dialog-escape.js";
import {
  renderModelConfigForm,
  renderModelsListSection,
  renderNewModelForm,
  renderProviderConfigForm,
  renderProviderHealthSection,
} from "./models-config-forms.js";
import { getProviderModels, providerIcon } from "./models-provider-picker.js";
import {
  clearSettingsSaveMessage,
  setSettingsSaveButtonSaving,
  showSettingsSaveError,
  showSettingsSaveSuccess,
} from "./settings-save-status.js";

const MODELS_DOCS_URL =
  "https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md";

const MODELS_JSON_EXAMPLE = `{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
`;

export function createModelsConfigEditorController({
  call,
  apiKeysContainer,
  getCatalogProviders,
  buildApiKeyRow,
  buildModelList,
  checkModelHealth,
  openProviderPicker,
  onModelConfigurationChanged,
}) {
  const inlineModelsPath = document.getElementById("inline-models-path");
  const inlineModelsTextarea = document.getElementById("inline-models-textarea");
  const inlineModelsError = document.getElementById("inline-models-error");
  const inlineModelsSave = document.getElementById("inline-models-save");
  const inlineModelsInsertExample = document.getElementById("inline-models-insert-example");
  const modelsConfigDocsLink = document.getElementById("models-config-docs-link");
  let selectedModelsConfigItem = null;
  let newModelDraft = null;

  function showInlineModelsError(message) {
    showSettingsSaveError(inlineModelsError, message);
  }

  function clearInlineModelsError() {
    clearSettingsSaveMessage(inlineModelsError);
  }

  function selectProvider(providerId) {
    if (providerId) {
      selectedModelsConfigItem = { type: "provider", provider: providerId };
    }
  }

  async function loadInlineModelsEditor() {
    if (!inlineModelsTextarea) return;
    clearInlineModelsError();
    if (!inlineModelsTextarea.value.trim()) {
      inlineModelsTextarea.value = '{\n  "providers": {}\n}';
    }
    if (inlineModelsPath) {
      inlineModelsPath.textContent = t(
        "migrated.native.settings.settingsConfig.textcontent.loading",
      );
    }
    try {
      const data = await call("read_models_config");
      if (!data?.ok) throw new Error(data?.error || "Failed to load models.json");
      try {
        inlineModelsTextarea.value = JSON.stringify(JSON.parse(data.data.content), null, 2);
      } catch {
        inlineModelsTextarea.value = data.data.content;
      }
      renderModelsConfigLayout();
      if (inlineModelsPath) inlineModelsPath.textContent = data.data.path || "";
    } catch (e) {
      if (inlineModelsPath) inlineModelsPath.textContent = "";
      showInlineModelsError(e.message || String(e));
    }
  }

  function renderModelsConfigLayout() {
    if (!inlineModelsTextarea) return;
    let parsed;
    try {
      parsed = JSON.parse(inlineModelsTextarea.value);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    if (
      !parsed.providers ||
      typeof parsed.providers !== "object" ||
      Array.isArray(parsed.providers)
    ) {
      parsed.providers = {};
    }
    const providers = parsed.providers;
    const providerNames = Object.keys(providers);
    const catalogProviders = getCatalogProviders();
    const configuredProviders = catalogProviders
      .filter((provider) => provider.configured)
      .sort((a, b) => (a.displayName || a.provider).localeCompare(b.displayName || b.provider));
    if (
      !selectedModelsConfigItem ||
      (selectedModelsConfigItem.type === "auth" &&
        (providerNames.includes(selectedModelsConfigItem.provider) ||
          !configuredProviders.some(
            (provider) => provider.provider === selectedModelsConfigItem.provider,
          ))) ||
      (selectedModelsConfigItem.type !== "auth" && !providers[selectedModelsConfigItem.provider]) ||
      (selectedModelsConfigItem.type === "model" &&
        !providers[selectedModelsConfigItem.provider].models?.[selectedModelsConfigItem.index]) ||
      (selectedModelsConfigItem.type === "model-new" &&
        selectedModelsConfigItem.provider !== newModelDraft?.provider)
    ) {
      newModelDraft = null;
      const defaultAuthProvider = configuredProviders.find(
        (provider) => !providerNames.includes(provider.provider),
      );
      selectedModelsConfigItem = defaultAuthProvider
        ? { type: "auth", provider: defaultAuthProvider.provider }
        : providerNames[0]
          ? { type: "provider", provider: providerNames[0] }
          : null;
    }

    let layout = document.getElementById("models-config-layout");
    if (!layout) {
      layout = document.createElement("div");
      layout.id = "models-config-layout";
      layout.className = "models-config-layout";
      apiKeysContainer.replaceChildren(layout);

      const openSource = document.createElement("button");
      openSource.type = "button";
      openSource.className = "ui-button ui-button--secondary models-config-source-button";
      openSource.textContent = "Advanced JSON editor";

      const sourceDialog = document.createElement("div");
      sourceDialog.className = "models-json-dialog-backdrop hidden";
      const dialog = document.createElement("section");
      dialog.className = "models-json-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "models-json-dialog-title");
      const header = document.createElement("header");
      header.className = "models-json-dialog-header";
      const heading = document.createElement("div");
      const title = document.createElement("h2");
      title.id = "models-json-dialog-title";
      title.textContent = "Advanced JSON editor";
      heading.append(title, inlineModelsPath);
      const close = document.createElement("button");
      close.type = "button";
      close.className = "ui-icon-button ui-icon-button--ghost";
      close.setAttribute("aria-label", "Close advanced JSON editor");
      close.textContent = "×";
      header.append(heading, close);
      dialog.append(header, inlineModelsTextarea);

      const footer = document.createElement("div");
      footer.className = "models-config-footer";
      const sourceSection = inlineModelsSave?.closest(".settings-section");
      const actions = inlineModelsSave?.closest(".settings-config-actions");
      footer.appendChild(openSource);

      const toolbarStatus = document.createElement("div");
      toolbarStatus.className = "config-editor-error settings-save-status hidden";
      toolbarStatus.id = "models-config-toolbar-status";
      toolbarStatus.setAttribute("role", "status");
      toolbarStatus.setAttribute("aria-live", "polite");
      const toolbarSave = document.createElement("button");
      toolbarSave.type = "button";
      toolbarSave.className = "ui-button ui-button--primary models-config-toolbar-save";
      toolbarSave.textContent = t("actions.save");
      toolbarSave.addEventListener(
        "click",
        () => void persistInlineModelsConfig({ button: toolbarSave, statusEl: toolbarStatus }),
      );
      footer.append(toolbarStatus, toolbarSave);

      if (actions) {
        actions.classList.add("models-json-dialog-actions");
        dialog.appendChild(actions);
      }
      sourceDialog.appendChild(dialog);
      document.body.appendChild(sourceDialog);

      const closeSourceDialog = () => {
        sourceDialog.classList.add("hidden");
        renderModelsConfigLayout();
        openSource.focus();
      };
      openSource.addEventListener("click", () => {
        sourceDialog.classList.remove("hidden");
        inlineModelsTextarea.focus();
      });
      close.addEventListener("click", closeSourceDialog);
      sourceDialog.addEventListener("click", (event) => {
        if (event.target === sourceDialog) closeSourceDialog();
      });
      bindDialogEscape(closeSourceDialog, {
        isActive: () => sourceDialog.isConnected && !sourceDialog.classList.contains("hidden"),
      });
      inlineModelsTextarea.addEventListener("change", renderModelsConfigLayout);

      footer.classList.add("models-config-toolbar");
      apiKeysContainer.append(footer, layout);
      if (sourceSection) sourceSection.hidden = true;
    } else if (layout.parentNode !== apiKeysContainer) {
      apiKeysContainer.prepend(layout);
    }
    layout.replaceChildren();
    const sidebar = document.createElement("aside");
    sidebar.className = "models-config-sidebar";
    const list = document.createElement("div");
    list.className = "models-provider-list";
    const main = document.createElement("section");
    main.className = "models-config-main";

    const sync = () => {
      inlineModelsTextarea.value = JSON.stringify(parsed, null, 2);
      clearInlineModelsError();
    };
    const update = (callback) => {
      callback();
      sync();
      renderModelsConfigLayout();
    };
    const setSelectedItem = (item) => {
      selectedModelsConfigItem = item;
    };
    const getNewModelDraft = () => newModelDraft;
    const setNewModelDraft = (draft) => {
      newModelDraft = draft;
    };

    for (const provider of configuredProviders) {
      if (providerNames.includes(provider.provider)) continue;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "models-provider-item models-auth-provider-item";
      item.classList.toggle(
        "selected",
        selectedModelsConfigItem?.type === "auth" &&
          selectedModelsConfigItem.provider === provider.provider,
      );
      item.append(providerIcon(provider.provider, "models-provider-icon"));
      item.appendChild(
        Object.assign(document.createElement("span"), {
          textContent: provider.displayName || provider.provider,
        }),
      );
      item.addEventListener("click", () => {
        selectedModelsConfigItem = { type: "auth", provider: provider.provider };
        renderModelsConfigLayout();
      });
      list.appendChild(item);
    }

    if (configuredProviders.length && providerNames.length) {
      const divider = document.createElement("div");
      divider.className = "models-provider-divider";
      list.appendChild(divider);
    }

    for (const id of providerNames) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "models-provider-item";
      item.classList.toggle(
        "selected",
        selectedModelsConfigItem?.type === "provider" && selectedModelsConfigItem.provider === id,
      );
      item.append(providerIcon(id, "models-provider-icon"));
      item.appendChild(Object.assign(document.createElement("span"), { textContent: id }));
      item.addEventListener("click", () => {
        selectedModelsConfigItem = { type: "provider", provider: id };
        renderModelsConfigLayout();
      });
      list.appendChild(item);
    }
    sidebar.appendChild(list);

    const add = document.createElement("button");
    add.type = "button";
    add.className = "models-provider-add";
    add.textContent = "+ Add provider";
    add.addEventListener("click", () => openProviderPicker(getCatalogProviders()));
    sidebar.appendChild(add);

    if (!selectedModelsConfigItem) {
      const emptyTitle = document.createElement("h3");
      emptyTitle.textContent = "No providers yet";
      const emptyHint = document.createElement("p");
      emptyHint.textContent = "Add a provider to configure a custom model endpoint.";
      main.append(emptyTitle, emptyHint);
    } else if (selectedModelsConfigItem.type === "auth") {
      const provider = configuredProviders.find(
        (candidate) => candidate.provider === selectedModelsConfigItem.provider,
      );
      if (provider) {
        const card = buildApiKeyRow(provider);
        card.classList.add("provider-manager-card");
        card.querySelector(".api-key-row-header")?.classList.add("provider-manager-card-header");
        card.querySelector(".api-model-list")?.classList.add("provider-manager-model-list");
        main.appendChild(card);
      }
    } else if (selectedModelsConfigItem.type === "provider") {
      renderProviderConfigForm({
        main,
        config: parsed,
        providerName: selectedModelsConfigItem.provider,
        update,
        inlineModelsTextarea,
        showInlineModelsError,
        setSelectedItem,
      });
      renderModelsListSection({
        main,
        config: parsed,
        providerName: selectedModelsConfigItem.provider,
        update,
        setNewModelDraft,
        setSelectedItem,
        renderLayout: renderModelsConfigLayout,
      });
      const catalogProvider = catalogProviders.find(
        (candidate) => candidate.provider === selectedModelsConfigItem.provider,
      );
      const catalogModels = catalogProvider ? getProviderModels(catalogProvider) : [];
      if (catalogProvider?.configured && catalogModels.length > 0) {
        renderProviderHealthSection({
          main,
          provider: catalogProvider,
          buildModelList,
          checkModelHealth,
        });
      }
    } else if (selectedModelsConfigItem.type === "model-new") {
      renderNewModelForm({
        main,
        config: parsed,
        providerName: selectedModelsConfigItem.provider,
        update,
        getNewModelDraft,
        setNewModelDraft,
        setSelectedItem,
        renderLayout: renderModelsConfigLayout,
      });
    } else {
      renderModelConfigForm({
        main,
        config: parsed,
        providerName: selectedModelsConfigItem.provider,
        index: selectedModelsConfigItem.index,
        update,
        inlineModelsTextarea,
        setSelectedItem,
      });
    }
    layout.append(sidebar, main);
  }

  async function persistInlineModelsConfig({ button, statusEl } = {}) {
    if (!inlineModelsTextarea) return;
    const saveButton = button || inlineModelsSave;
    const status = statusEl || inlineModelsError;
    clearSettingsSaveMessage(status);
    const content = inlineModelsTextarea.value;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      showSettingsSaveError(status, `Invalid JSON: ${e.message}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      showSettingsSaveError(status, "models.json must be a JSON object.");
      return;
    }
    if (
      "providers" in parsed &&
      (typeof parsed.providers !== "object" || Array.isArray(parsed.providers))
    ) {
      showSettingsSaveError(status, "'providers' must be an object.");
      return;
    }
    setSettingsSaveButtonSaving(saveButton, true);
    try {
      const data = await call("write_models_config", { content });
      if (!data?.ok) throw new Error(data?.error || "Failed to save models.json");
      showSettingsSaveSuccess(status);
      await onModelConfigurationChanged?.();
    } catch (e) {
      showSettingsSaveError(status, e.message || String(e));
    } finally {
      setSettingsSaveButtonSaving(saveButton, false);
    }
  }

  inlineModelsSave?.addEventListener("click", () => void persistInlineModelsConfig());

  inlineModelsInsertExample?.addEventListener("click", () => {
    if (!inlineModelsTextarea) return;
    const current = inlineModelsTextarea.value.trim();
    if (current && current !== "{}" && current !== '{\n  "providers": {}\n}') {
      if (!confirm("Replace current content with the Ollama example?")) return;
    }
    inlineModelsTextarea.value = MODELS_JSON_EXAMPLE;
    selectedModelsConfigItem = { type: "provider", provider: "ollama" };
    renderModelsConfigLayout();
    clearInlineModelsError();
  });

  modelsConfigDocsLink?.addEventListener("click", (e) => {
    e.preventDefault();
    call("open_external", { url: MODELS_DOCS_URL }).catch((error) => {
      console.warn("[models-page] open_external failed:", error);
    });
  });

  return {
    inlineModelsTextarea,
    loadInlineModelsEditor,
    renderModelsConfigLayout,
    selectProvider,
  };
}
