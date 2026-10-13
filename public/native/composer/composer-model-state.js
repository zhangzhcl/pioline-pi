import { randomId } from "../utils/random-id.js";
import { formatModelName, setupComposerModelPicker } from "./composer-model-picker.js";
import { getLastModel } from "./last-model-store.js";

/**
 * 管理输入框模型下拉选择、思考等级切换、上下文窗口尺寸联动与会话级 UI Profile 持久化。
 */
export function createComposerModelStateController({
  modelDropdown,
  modelDropdownBtn,
  modelDropdownLabel,
  modelDropdownMenu,
  thinkingBtn,
  runtime,
  config,
  contextUsage,
  sessionUiState,
  getTarget,
  onOpenSettings,
  onThinkingLevelSelected,
  t,
  showError,
}) {
  let currentThinkingLevel = "off";
  let currentModelProvider = null;
  let currentModelId = null;
  let pendingModelRestore = null;
  let currentModelContextWindow = 0;

  const storedInitialModel = getLastModel();
  if (storedInitialModel && modelDropdownLabel) {
    modelDropdownLabel.textContent = formatModelName({ id: storedInitialModel.modelId }) || "model";
  }

  const composerModelPicker = setupComposerModelPicker({
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
    randomId,
    onOpenSettings,
    onModelSelected: (model) => updateComposerModel(model),
    onThinkingLevelSelected,
    getCurrentModel: () => ({
      provider: currentModelProvider,
      modelId: currentModelId,
    }),
    getCurrentThinkingLevel: () => currentThinkingLevel,
  });

  function updateComposerModel(model, { persist = true } = {}) {
    currentModelProvider = model?.provider ?? null;
    currentModelId = model?.id ?? null;
    if (persist) {
      sessionUiState
        .saveProfile({
          provider: currentModelProvider || "",
          modelId: currentModelId || "",
          thinkingLevel: currentThinkingLevel,
        })
        .catch(() => {});
    }
    currentModelContextWindow =
      Number(model?.contextWindow) ||
      composerModelPicker.findContextWindow(currentModelProvider, currentModelId);
    contextUsage.setContextWindowSize(currentModelContextWindow);
    composerModelPicker.updateModelDisplay(model);
  }

  function updateComposerThinking(level, { persist = true } = {}) {
    currentThinkingLevel = level ?? "off";
    if (persist) {
      sessionUiState
        .saveProfile({
          provider: currentModelProvider || "",
          modelId: currentModelId || "",
          thinkingLevel: currentThinkingLevel,
        })
        .catch(() => {});
    }
    composerModelPicker.updateThinkingDisplay(currentThinkingLevel);
  }

  async function loadAvailableModels({ force = false } = {}) {
    const models = await composerModelPicker.loadAvailableModels({ force });
    if (!currentModelContextWindow) {
      currentModelContextWindow = composerModelPicker.findContextWindow(
        currentModelProvider,
        currentModelId,
      );
      contextUsage.setContextWindowSize(currentModelContextWindow);
    }
    return models;
  }

  return {
    composerModelPicker,
    updateComposerModel,
    updateComposerThinking,
    loadAvailableModels,
    maybeInheritLastModel: (args) => composerModelPicker.maybeInheritLastModel(args),
    getCurrentModel: () => ({ provider: currentModelProvider, id: currentModelId }),
    getCurrentThinkingLevel: () => currentThinkingLevel,
    getCurrentModelContextWindow: () => currentModelContextWindow,
    getPendingModelRestore: () => pendingModelRestore,
    setPendingModelRestore(profile) {
      pendingModelRestore = profile;
    },
    consumePendingModelRestore() {
      const profile = pendingModelRestore;
      pendingModelRestore = null;
      return profile;
    },
  };
}
