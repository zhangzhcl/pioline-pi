// 模型设置页：供应商卡片、模型列表、可见性开关与搜索过滤状态同步。

import { t } from "../../i18n.js";
import {
  describeModelHealth,
  describeModelStatus,
  describeProviderSummary,
  healthDotClass,
} from "./models-health-and-key-editor.js";
import { escapeSelectorValue, getProviderModels } from "./models-provider-picker.js";

export function createModelsCatalogRowsController({
  call,
  apiKeysContainer,
  providerExpansionState,
  modelSearchState,
  getCatalogProviders,
  onModelConfigurationChanged,
  onOpenApiKeyEditor,
  onRemoveApiKey,
  onCheckModelHealth,
}) {
  function rememberProviderExpansionState() {
    if (!apiKeysContainer) return;
    for (const row of apiKeysContainer.querySelectorAll(".api-key-row[data-provider]")) {
      const modelList = row.querySelector(".api-model-list");
      if (modelList) {
        providerExpansionState.set(
          row.dataset.provider,
          !modelList.classList.contains("collapsed"),
        );
      }
    }
  }

  function getProviderModelRows(provider) {
    if (!apiKeysContainer) return [];
    return [
      ...apiKeysContainer.querySelectorAll(
        `.api-model-row[data-provider="${escapeSelectorValue(provider)}"]`,
      ),
    ];
  }

  function findProviderState(provider) {
    return getCatalogProviders().find((entry) => entry.provider === provider) ?? null;
  }

  function getProviderRow(provider) {
    return (
      apiKeysContainer?.querySelector(
        `.api-key-row[data-provider="${escapeSelectorValue(provider)}"]`,
      ) ?? null
    );
  }

  function applyProviderHeaderState(row, provider) {
    if (!row) return;
    const models = getProviderModels(provider);
    const enabledCount = models.filter((model) => model.visible !== false).length;
    const allEnabled = models.length > 0 && enabledCount === models.length;

    const summary = row.querySelector(".api-key-row-summary");
    if (summary) summary.textContent = describeProviderSummary(models);

    const healthBtn = row.querySelector(".api-model-check-visible");
    if (healthBtn) {
      healthBtn.disabled = !models.some((model) => model.visible !== false && model.available);
    }

    const selectAll = row.querySelector(".api-model-select-all-toggle");
    if (selectAll) {
      selectAll.disabled = false;
      selectAll.checked = allEnabled;
      selectAll.indeterminate = enabledCount > 0 && !allEnabled;
      selectAll.setAttribute(
        "aria-label",
        t(allEnabled ? "settings.apiKeys.deselectAll" : "settings.apiKeys.selectAll", {
          provider: provider.displayName || provider.provider,
        }),
      );
    }
  }

  function syncProviderModelState(provider) {
    const state = findProviderState(provider);
    const models = state ? getProviderModels(state) : [];
    for (const modelRow of getProviderModelRows(provider)) {
      const toggle = modelRow.querySelector(".api-model-visibility-toggle");
      if (!toggle) continue;
      const model = models.find((entry) => entry.id === modelRow.dataset.modelId);
      toggle.disabled = false;
      if (model) toggle.checked = model.visible !== false;
    }
    const row = getProviderRow(provider);
    if (state && row) {
      applyProviderHeaderState(row, state);
    } else {
      const selectAll = row?.querySelector(".api-model-select-all-toggle");
      if (selectAll) selectAll.disabled = false;
    }
  }

  async function setProviderModelsVisibility(provider, visible) {
    const state = findProviderState(provider);
    const rows = getProviderModelRows(provider);
    const toggles = rows
      .map((row) => row.querySelector(".api-model-visibility-toggle"))
      .filter(Boolean);
    const modelsToUpdate = rows.filter(
      (row) => row.querySelector(".api-model-visibility-toggle")?.checked !== visible,
    );
    if (modelsToUpdate.length === 0) {
      syncProviderModelState(provider);
      return;
    }

    const selectAll = getProviderRow(provider)?.querySelector(".api-model-select-all-toggle");
    if (selectAll) selectAll.disabled = true;
    for (const toggle of toggles) toggle.disabled = true;
    for (const row of modelsToUpdate) {
      const resp = await call("set_model_visibility", {
        provider,
        modelId: row.dataset.modelId,
        visible,
      }).catch(() => null);
      if (!resp?.ok) {
        syncProviderModelState(provider);
        return;
      }
      const model = state
        ? getProviderModels(state).find((entry) => entry.id === row.dataset.modelId)
        : null;
      if (model) model.visible = visible;
    }
    syncProviderModelState(provider);
    await onModelConfigurationChanged?.();
  }

  function buildModelRow(model) {
    const row = document.createElement("div");
    row.className = "api-model-row";
    row.dataset.provider = model.provider;
    row.dataset.modelId = model.id;
    row.dataset.available = String(model.available);

    const health = model.health || { status: "unknown" };
    const healthDot = document.createElement("span");
    healthDot.className = `api-model-health-dot ${healthDotClass(health)}`;
    healthDot.title = describeModelHealth(health);

    const label = document.createElement("div");
    label.className = "api-model-label";
    const name = document.createElement("div");
    name.className = "api-model-name";
    name.textContent = model.name || model.id;
    const meta = document.createElement("div");
    meta.className = "api-model-health-status";
    meta.textContent = describeModelStatus(model);
    label.appendChild(name);
    label.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "api-model-actions";

    const visibilityLabel = document.createElement("label");
    visibilityLabel.className = "api-model-visibility";
    const visibility = document.createElement("input");
    visibility.type = "checkbox";
    visibility.className = "api-model-visibility-toggle";
    visibility.setAttribute(
      "aria-label",
      t("settings.apiKeys.enableModel", { model: model.name || model.id }),
    );
    visibility.checked = model.visible !== false;
    visibility.addEventListener("change", async () => {
      const visible = visibility.checked;
      visibility.disabled = true;
      const resp = await call("set_model_visibility", {
        provider: model.provider,
        modelId: model.id,
        visible,
      }).catch(() => null);
      if (resp?.ok) {
        model.visible = visible;
        syncProviderModelState(model.provider);
        await onModelConfigurationChanged?.();
      } else {
        visibility.checked = !visible;
        visibility.disabled = false;
      }
    });
    visibilityLabel.appendChild(visibility);
    actions.appendChild(visibilityLabel);

    row.appendChild(healthDot);
    row.appendChild(label);
    row.appendChild(actions);
    return row;
  }

  function buildModelList(p) {
    const wrap = document.createElement("div");
    wrap.className = "api-model-list";

    const models = getProviderModels(p);
    if (models.length === 0) return null;

    const modelRows = [];
    const applySearchFilter = (value) => {
      const query = value.trim().toLowerCase();
      for (const row of modelRows) {
        const matches =
          !query ||
          row.model.id.toLowerCase().includes(query) ||
          (row.model.name || "").toLowerCase().includes(query);
        row.el.classList.toggle("api-model-row-filtered-out", !matches);
      }
    };

    let search = null;
    if (models.length > 20) {
      search = document.createElement("input");
      search.type = "search";
      search.className = "api-model-list-search";
      search.placeholder = t("settings.apiKeys.searchModels");
      search.setAttribute(
        "aria-label",
        t("settings.apiKeys.searchModelsFor", { provider: p.displayName || p.provider }),
      );
      search.value = modelSearchState.get(p.provider) ?? "";
      search.addEventListener("click", (event) => event.stopPropagation());
      search.addEventListener("input", () => {
        modelSearchState.set(p.provider, search.value);
        applySearchFilter(search.value);
      });
      wrap.appendChild(search);
    }

    const columnLabels = document.createElement("div");
    columnLabels.className = "api-model-list-heading";
    const statusColumn = document.createElement("span");
    const modelColumn = document.createElement("span");
    modelColumn.textContent = t("settings.apiKeys.model");

    const actions = document.createElement("div");
    actions.className = "api-model-list-heading-actions";
    const visibilityColumn = document.createElement("label");
    visibilityColumn.className = "api-model-select-all";
    const visibilityToggle = document.createElement("input");
    visibilityToggle.type = "checkbox";
    visibilityToggle.className = "api-model-select-all-toggle";
    visibilityToggle.addEventListener("change", () =>
      setProviderModelsVisibility(p.provider, visibilityToggle.checked),
    );
    visibilityColumn.appendChild(visibilityToggle);
    columnLabels.append(statusColumn, modelColumn, actions, visibilityColumn);
    wrap.appendChild(columnLabels);

    for (const model of models) {
      const el = buildModelRow(model);
      modelRows.push({ model, el });
      wrap.appendChild(el);
    }
    if (search) applySearchFilter(search.value);
    return wrap;
  }

  function buildApiKeyRow(p) {
    const row = document.createElement("div");
    row.className = "api-key-row";
    row.dataset.provider = p.provider;

    const header = document.createElement("div");
    header.className = "api-key-row-header";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "api-provider-toggle";
    toggle.setAttribute(
      "aria-label",
      t("settings.apiKeys.toggleModels", { provider: p.displayName || p.provider }),
    );
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "▼";

    const info = document.createElement("div");
    info.className = "api-key-row-info";
    const name = document.createElement("div");
    name.className = "api-key-row-name";
    name.textContent = p.displayName || p.provider;
    info.appendChild(name);

    const actions = document.createElement("div");
    actions.className = "api-key-row-actions";
    const setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.textContent = p.configured ? t("actions.update") : t("actions.setKey");
    setBtn.addEventListener("click", () => onOpenApiKeyEditor(row, p));

    const models = getProviderModels(p);
    const hasConfiguredModels = p.configured && models.length > 0;
    if (hasConfiguredModels) {
      const checkHealthBtn = document.createElement("button");
      checkHealthBtn.type = "button";
      checkHealthBtn.className = "api-model-check-visible";
      checkHealthBtn.textContent = t("settings.apiKeys.checkHealth");
      checkHealthBtn.addEventListener("click", () => onCheckModelHealth(p.provider));
      actions.appendChild(checkHealthBtn);
    }
    actions.appendChild(setBtn);
    if (p.configured && p.source === "stored") {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "danger";
      removeBtn.textContent = t("actions.remove");
      removeBtn.addEventListener("click", () => onRemoveApiKey(p));
      actions.appendChild(removeBtn);
    }

    const modelList = hasConfiguredModels ? buildModelList(p) : null;
    header.appendChild(toggle);
    header.appendChild(info);
    if (hasConfiguredModels) {
      const summary = document.createElement("div");
      summary.className = "api-key-row-summary";
      header.appendChild(summary);
    }
    header.appendChild(actions);
    row.appendChild(header);
    if (modelList) {
      const isExpanded = providerExpansionState.get(p.provider) ?? true;
      modelList.classList.toggle("collapsed", !isExpanded);
      toggle.setAttribute("aria-expanded", String(isExpanded));
      const toggleModelList = () => {
        modelList.classList.toggle("collapsed");
        const expanded = !modelList.classList.contains("collapsed");
        toggle.setAttribute("aria-expanded", String(expanded));
        providerExpansionState.set(p.provider, expanded);
      };
      header.addEventListener("click", (event) => {
        if (event.target.closest?.(".api-key-row-actions")) return;
        toggleModelList();
      });
      info.classList.add("api-provider-title-toggle");
      info.tabIndex = 0;
      info.setAttribute("role", "button");
      info.setAttribute(
        "aria-label",
        t("settings.apiKeys.toggleModels", { provider: p.displayName || p.provider }),
      );
      info.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleModelList();
        }
      });
      row.appendChild(modelList);
    } else {
      toggle.hidden = true;
    }
    applyProviderHeaderState(row, p);
    return row;
  }

  return {
    rememberProviderExpansionState,
    getProviderModelRows,
    buildModelList,
    buildApiKeyRow,
  };
}
