import { getLastModel, setLastModel } from "./last-model-store.js";
import { isSelectedModel, splitModelsByScope } from "./model-selection.js";

/**
 * 格式化模型显示名称，去除厂商前缀与构建日期后缀
 */
export function formatModelName(model) {
  const raw = typeof model === "string" ? model : model?.name || model?.id || "";
  return raw.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/**
 * 格式化思考预算等级标签
 */
export function formatThinkingLevelLabel(level, t) {
  const normalizedLevel = level || "off";
  const key = `settings.thinkingLevels.${normalizedLevel}`;
  const label = t ? t(key) : normalizedLevel;
  return label === key ? normalizedLevel : label;
}

/**
 * 从可用模型列表中查找指定模型的上下文窗口上限
 */
export function findModelContextWindow(models, provider, modelId) {
  if (!provider || !modelId || !Array.isArray(models)) return 0;
  const model = models.find(
    (candidate) => candidate.provider === provider && candidate.id === modelId,
  );
  return Number(model?.contextWindow) || 0;
}

function getModelSearchText(model) {
  return [model.name, model.id, model.provider].filter(Boolean).join(" ").toLowerCase();
}

/**
 * 初始化并管理输入框区域的模型下拉切换器与思考预算按钮
 */
export function setupComposerModelPicker({
  modelDropdown,
  modelDropdownBtn,
  modelDropdownLabel,
  modelDropdownMenu,
  thinkingBtn,
  runtime,
  config,
  getTarget,
  t,
  showError,
  randomId = () => Math.random().toString(36).slice(2),
  onOpenSettings,
  onModelSelected,
  onThinkingLevelSelected,
  getCurrentModel = () => ({ provider: null, modelId: null }),
  windowTarget = window,
  documentTarget = document,
} = {}) {
  let availableModels = [];
  let availableModelsLoaded = false;
  let scopedModelIds = [];
  let scopedModelsLoaded = false;

  const modelDropdownToolbar = modelDropdown?.closest?.(".composer-toolbar");

  function updateModelDisplay(model) {
    if (modelDropdownLabel) {
      modelDropdownLabel.textContent = formatModelName(model) || "model";
    }
  }

  function updateThinkingDisplay(level) {
    if (!thinkingBtn) return;
    const normalizedLevel = level ?? "off";
    const levelLabel = formatThinkingLevelLabel(normalizedLevel, t);
    thinkingBtn.textContent = t ? t("settings.thinkingCompact", { level: levelLabel }) : levelLabel;
    thinkingBtn.className = `thinking-tag${normalizedLevel === "off" ? " off" : ""}`;
    if (t) {
      thinkingBtn.title = t("settings.thinkingTitle");
      thinkingBtn.setAttribute(
        "aria-label",
        t("settings.thinkingAriaLabel", { level: levelLabel }),
      );
    }
  }

  function closeModelDropdown() {
    modelDropdownMenu?.classList?.add("hidden");
    modelDropdown?.classList?.remove("open");
    modelDropdownToolbar?.classList?.remove("model-menu-open");
    modelDropdownBtn?.setAttribute?.("aria-expanded", "false");
  }

  function openModelDropdown() {
    if (!modelDropdownMenu) return;
    renderModelDropdownMenu();
    modelDropdownMenu.classList.remove("hidden");
    modelDropdown?.classList?.add("open");
    modelDropdownToolbar?.classList?.add("model-menu-open");
    modelDropdownBtn?.setAttribute?.("aria-expanded", "true");
    windowTarget.requestAnimationFrame?.(() => {
      modelDropdownMenu.querySelector?.(".model-dropdown-search")?.focus?.();
    });
  }

  function renderEmptyModelDropdown(container) {
    const empty = documentTarget.createElement("div");
    empty.className = "model-dropdown-empty";

    const title = documentTarget.createElement("div");
    title.className = "model-dropdown-empty-title";
    title.textContent = t ? t("models.emptyTitle") : "No models available";

    const message = documentTarget.createElement("div");
    message.textContent = t ? t("models.emptyHelp") : "Please configure models in settings.";

    const settingsButton = documentTarget.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "btn-primary model-dropdown-empty-action";
    settingsButton.textContent = t
      ? t("migrated.native.app.textcontent.openSettings")
      : "Open Settings";
    settingsButton.addEventListener("click", () => {
      closeModelDropdown();
      onOpenSettings?.("models");
    });

    empty.append(title, message, settingsButton);
    container.appendChild(empty);
  }

  function buildModelDropdownItem(model, isScoped) {
    const item = documentTarget.createElement("div");
    const current = getCurrentModel();
    const selected = isSelectedModel(model, {
      provider: current.provider,
      modelId: current.modelId,
    });
    item.className = `model-dropdown-item${selected ? " active" : ""}`;

    const main = documentTarget.createElement("button");
    main.type = "button";
    main.className = "model-dropdown-item-main";

    const nameWrap = documentTarget.createElement("span");
    nameWrap.className = "model-dropdown-item-name";
    nameWrap.textContent = formatModelName(model);

    if (model.provider && model.provider !== "anthropic") {
      const provider = documentTarget.createElement("span");
      provider.className = "model-dropdown-item-provider";
      provider.textContent = model.provider;
      nameWrap.appendChild(provider);
    }

    const context = documentTarget.createElement("span");
    context.className = "model-dropdown-item-ctx";
    context.textContent = model.contextWindow
      ? `${(Number(model.contextWindow) / 1000).toFixed(0)}k`
      : "";

    main.append(nameWrap, context);
    main.addEventListener("click", async () => {
      closeModelDropdown();
      const target = getTarget?.();
      try {
        await runtime?.request?.(
          { type: "set_model", provider: model.provider, modelId: model.id },
          target,
          { idempotencyKey: randomId() },
        );
        setLastModel(model);
        onModelSelected?.(model);

        const stateResult = await runtime?.request?.({ type: "get_state" }, target);
        const level = stateResult?.response?.data?.thinkingLevel;
        if (level) {
          onThinkingLevelSelected?.(level);
        }
      } catch (error) {
        showError?.(error);
      }
    });

    const star = documentTarget.createElement("button");
    star.type = "button";
    star.className = `model-dropdown-star${isScoped ? " active" : ""}`;
    star.textContent = isScoped ? "\u2605" : "\u2606";
    star.setAttribute(
      "aria-label",
      t ? t(isScoped ? "models.removeScoped" : "models.addScoped") : "Toggle scoped model",
    );
    star.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        const response = await config?.call?.("set_scoped_model", {
          provider: model.provider,
          modelId: model.id,
          enabled: !isScoped,
        });
        if (response?.ok && Array.isArray(response.data?.modelIds)) {
          scopedModelIds = response.data.modelIds;
          const container = modelDropdownMenu?.querySelector?.(".model-dropdown-items");
          if (container && !modelDropdownMenu.classList.contains("hidden")) {
            renderModelDropdownItems(
              container,
              modelDropdownMenu.querySelector?.(".model-dropdown-search")?.value ?? "",
            );
          }
        }
      } catch {
        // 配置接口不可用时保持当前菜单状态不变
      }
    });

    item.append(main, star);
    return item;
  }

  function appendModelSection(container, label, models, isScoped) {
    if (models.length === 0) return;
    const heading = documentTarget.createElement("div");
    heading.className = "model-dropdown-section";
    heading.textContent = label;
    container.appendChild(heading);
    for (const model of models) {
      container.appendChild(buildModelDropdownItem(model, isScoped));
    }
  }

  function renderModelDropdownItems(container, filter = "") {
    container.replaceChildren();
    if (availableModels.length === 0) {
      renderEmptyModelDropdown(container);
      return;
    }

    const query = filter.trim().toLowerCase();
    const matchingModels = query
      ? availableModels.filter((model) => getModelSearchText(model).includes(query))
      : availableModels;

    if (matchingModels.length === 0) {
      const empty = documentTarget.createElement("div");
      empty.className = "model-dropdown-empty";
      empty.textContent = t
        ? t("migrated.native.app.textcontent.noModelsMatchYourSearch")
        : "No models match your search";
      container.appendChild(empty);
      return;
    }

    const { scoped, remaining } = splitModelsByScope(matchingModels, scopedModelIds);
    appendModelSection(container, t ? t("models.scoped") : "Starred models", scoped, true);
    appendModelSection(
      container,
      t ? t("models.allEnabled") : "All enabled models",
      remaining,
      false,
    );
  }

  async function loadScopedModelIds({ force = false } = {}) {
    if (scopedModelsLoaded && !force) return;
    try {
      const response = await config?.call?.("list_scoped_models");
      if (response?.ok && Array.isArray(response.data?.modelIds)) {
        scopedModelIds = response.data.modelIds;
        scopedModelsLoaded = true;
      }
    } catch {
      // 配置接口不可用时降级为未分组列表
    }
  }

  function renderModelDropdownMenu() {
    if (!modelDropdownMenu) return;
    modelDropdownMenu.replaceChildren();

    const search = documentTarget.createElement("input");
    search.className = "model-dropdown-search";
    search.placeholder = t ? t("models.searchPlaceholder") : "Search models...";
    search.type = "text";
    modelDropdownMenu.appendChild(search);

    const itemsContainer = documentTarget.createElement("div");
    itemsContainer.className = "model-dropdown-items";
    modelDropdownMenu.appendChild(itemsContainer);

    renderModelDropdownItems(itemsContainer);

    if (!scopedModelsLoaded) {
      void loadScopedModelIds().then(() => {
        if (!modelDropdownMenu.classList.contains("hidden")) {
          renderModelDropdownItems(itemsContainer, search.value);
        }
      });
    }

    search.addEventListener("input", () => renderModelDropdownItems(itemsContainer, search.value));
    search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeModelDropdown();
        event.stopPropagation();
      }
      if (event.key === "Enter") {
        itemsContainer.querySelector?.(".model-dropdown-item")?.click?.();
      }
    });
  }

  async function applyConfiguredModelVisibility(models) {
    try {
      const result = await config?.call?.("list_model_visibility");
      if (!result?.ok) throw new Error(result?.error || "Failed to load model visibility");
      const visibility = result.data?.visibility ?? {};
      return models.filter((model) => visibility[`${model.provider}/${model.id}`] !== false);
    } catch (error) {
      console.warn("[Native] Failed to load configured model visibility:", error);
      return [];
    }
  }

  async function loadAvailableModels({ force = false } = {}) {
    if (availableModelsLoaded && !force) return availableModels;
    try {
      const target = getTarget?.();
      const result = await runtime?.request?.({ type: "get_available_models" }, target);
      const runtimeModels = result?.response?.data?.models ?? [];
      availableModels = await applyConfiguredModelVisibility(runtimeModels);
      availableModelsLoaded = true;
      renderModelDropdownMenu();
      return availableModels;
    } catch (error) {
      console.warn("[Native] Failed to load available models:", error);
      return [];
    }
  }

  async function maybeInheritLastModel({ messages, piModel }) {
    if (Array.isArray(messages) && messages.length > 0) return;
    const last = getLastModel();
    if (!last) return;
    if (piModel?.provider === last.provider && piModel?.id === last.modelId) return;
    try {
      const target = getTarget?.();
      const result = await runtime?.request?.(
        { type: "set_model", provider: last.provider, modelId: last.modelId },
        target,
        { idempotencyKey: randomId() },
      );
      const applied = result?.response?.data;
      if (applied === false) return;
      onModelSelected?.({ provider: last.provider, id: last.modelId });
      const stateResult = await runtime?.request?.({ type: "get_state" }, target);
      const level = stateResult?.response?.data?.thinkingLevel;
      if (level) {
        onThinkingLevelSelected?.(level);
      }
    } catch (error) {
      console.warn("[Native] Failed to inherit last model:", error);
    }
  }

  function handleDropdownBtnClick(event) {
    event.stopPropagation();
    const isOpen = !modelDropdownMenu?.classList?.contains("hidden");
    if (isOpen) {
      closeModelDropdown();
    } else {
      if (!availableModelsLoaded) {
        void loadAvailableModels();
      }
      openModelDropdown();
    }
  }

  function handleDocumentClick(event) {
    if (!event.target.closest?.("#model-dropdown")) {
      closeModelDropdown();
    }
  }

  async function handleThinkingBtnClick() {
    try {
      const target = getTarget?.();
      const result = await runtime?.request?.({ type: "cycle_thinking_level" }, target);
      const level = result?.response?.data?.level;
      if (level) {
        onThinkingLevelSelected?.(level);
      }
    } catch (error) {
      showError?.(error);
    }
  }

  async function reloadModels() {
    scopedModelsLoaded = false;
    await Promise.all([loadScopedModelIds({ force: true }), loadAvailableModels({ force: true })]);
  }

  modelDropdownBtn?.addEventListener?.("click", handleDropdownBtnClick);
  documentTarget.addEventListener?.("click", handleDocumentClick);
  thinkingBtn?.addEventListener?.("click", handleThinkingBtnClick);

  return {
    openModelDropdown,
    closeModelDropdown,
    updateModelDisplay,
    updateThinkingDisplay,
    loadAvailableModels,
    loadScopedModelIds,
    reloadModels,
    maybeInheritLastModel,
    applyConfiguredModelVisibility,
    findContextWindow: (provider, modelId) =>
      findModelContextWindow(availableModels, provider, modelId),
    getAvailableModels: () => availableModels,
    destroy() {
      modelDropdownBtn?.removeEventListener?.("click", handleDropdownBtnClick);
      documentTarget.removeEventListener?.("click", handleDocumentClick);
      thinkingBtn?.removeEventListener?.("click", handleThinkingBtnClick);
    },
  };
}
