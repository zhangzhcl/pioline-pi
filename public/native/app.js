import { initI18n, onLocaleChange, t } from "../i18n.js";
import { applyTheme, getCurrentTheme } from "../themes.js";
import { ConvNav } from "../ui/conv-nav.js";
import { setupMessagesInsets } from "../ui/layout-insets.js";
import { MessageRenderer } from "../ui/message-renderer.js";
import { ToolCardRenderer } from "../ui/tool-card.js";
import { setupComposerAutoResize } from "./composer/composer-autoresize.js";
import { createComposerModelStateController } from "./composer/composer-model-state.js";
import { setupComposerSendController } from "./composer/composer-send-controller.js";
import { setupNativeExtensionUi } from "./extensions/native-extension-ui.js";
import { setupSuperAgentController } from "./features/super-agent-controller.js";
import { createNotificationCenter } from "./notifications/notification-center.js";
import {
  createNativeTaskNotificationSender,
  createTaskCompletionNotifications,
} from "./notifications/task-completion-notifications.js";
import { createChatHistoryRenderer } from "./session/chat-history-renderer.js";
import { setupInfoPanelController } from "./session/info-panel-controller.js";
import { setupRuntimeEventDispatcher } from "./session/runtime-event-dispatcher.js";
import {
  createSessionHydrationController,
  provisionalTargetFromRoute,
} from "./session/session-hydration.js";
import { createSessionStore } from "./session/session-store.js";
import { setupSessionSwitchingController } from "./session/session-switching.js";
import { createNativeSessionUiStateStore } from "./session/session-ui-profile-client.js";
import { createTurnTraceRecorder } from "./session/turn-trace.js";
import { setupConfigGatewayConnectionListener } from "./transport/config-gateway-readiness.js";
import { createNativeTransportStack } from "./transport/native-transport-stack.js";
import { parseAppRoute } from "./utils/router.js";
import { formatWorkflowChatContext } from "./workflow/workflow-chat-context.js";
import { setupWorkflowModeController } from "./workflow/workflow-mode-controller.js";
import { setupWorkflowWindowBridge } from "./workflow/workflow-window-bridge.js";
import { setupContextUsage } from "./workspace/context-usage.js";
import { setupSessionCostAndCompaction } from "./workspace/session-cost-compaction.js";
import { createSessionStatus } from "./workspace/session-status.js";
import {
  queryNativeAppDom,
  setupWorkspaceChromeActions,
  setupWorkspacePanelsController,
} from "./workspace/workspace-panels-controller.js";

async function initializeApp() {
  const sessionStatus = createSessionStatus({ t });
  const { applyHostStatus, renderStatus, setStatus } = sessionStatus;
  const route = parseAppRoute(window.location.pathname);
  if (route.name !== "session") throw new Error("Pipline requires a session route");

  applyTheme(getCurrentTheme());
  await initI18n();
  document.body.dataset.runtime = "native";

  const dom = queryNativeAppDom(document);
  const {
    messagesElement,
    headerElement,
    scrollBottomBadge,
    input,
    sendButton,
    abortButton,
    queuedMessages,
  } = dom;

  let target = provisionalTargetFromRoute(route);
  let store = createSessionStore(target);
  let infoPanelController = null;
  let sessionSwitching = null;
  let composerSend = null;
  let settingsPanel = null;

  const convNav = new ConvNav({
    messagesEl: messagesElement,
    headerEl: headerElement,
    badgeEl: scrollBottomBadge,
    onJumpToEntry: (entryId) => {
      if (!infoPanelController?.infoPanel) return;
      infoPanelController.infoPanel.selectEntry(entryId);
      infoPanelController.infoPanel.scrollToSelectedEntry();
    },
  });
  const notifications = createNotificationCenter();
  const sendNativeTaskNotification = createNativeTaskNotificationSender({
    invoke: globalThis.__TAURI__?.core?.invoke,
  });
  const taskCompletionNotifications = createTaskCompletionNotifications({
    resolveTask: (notificationTarget) =>
      sessionSwitching
        ?.getSidebar()
        ?.sessions?.find(
          (session) =>
            session.id === notificationTarget?.sessionId &&
            session.workspaceId === notificationTarget?.workspaceId,
        ) ?? null,
    title: (task, error) =>
      task?.name ||
      task?.firstMessage ||
      (error ? t("settings.taskFailedTitle") : t("settings.taskCompleteTitle")),
    body: (_task, error) => error || t("settings.taskCompleteMessage"),
    showNotification: sendNativeTaskNotification,
  });
  const turnTrace = createTurnTraceRecorder();

  setupMessagesInsets({
    main: document.querySelector(".main"),
    messages: messagesElement,
    header: headerElement,
    inputArea: document.querySelector(".input-area"),
    workspaceContent: document.querySelector(".workspace-content"),
  });
  const messageRenderer = new MessageRenderer(messagesElement, { sessionTreeActions: true });
  const toolRenderer = new ToolCardRenderer(messagesElement);
  const composerAutoResize = setupComposerAutoResize({ input });

  function showError(error) {
    setStatus("disconnected");
    messageRenderer.renderError(error?.message || String(error));
  }

  let preferencesRef = null;
  setupWorkflowWindowBridge({
    input,
    sendButton,
    composerAutoResize,
    formatWorkflowChatContext,
    t,
    getTarget: () => target,
    getPreferences: () => preferencesRef,
    showError,
  });

  const {
    remoteAuth,
    adapter,
    terminalIntegration,
    runtime,
    data,
    control,
    preferences,
    config,
    oauthGateway,
    isConfigGatewayReady,
    markConfigGatewayReady,
    markConfigGatewayUnready,
  } = await createNativeTransportStack({ getTarget: () => target });
  preferencesRef = preferences;

  const sessionUiState = createNativeSessionUiStateStore({
    waitUntilReady: () => adapter.ready(),
    getSessionId: () => target.sessionId,
    getRuntime: () => runtime,
  });
  const contextUsage = setupContextUsage();

  let updateComposerThinking = () => {};
  const modelState = createComposerModelStateController({
    ...dom,
    runtime,
    config,
    contextUsage,
    sessionUiState,
    getTarget: () => target,
    onOpenSettings: (tab) => settingsPanel?.openSettings(tab),
    onThinkingLevelSelected: (level) => updateComposerThinking(level),
    t,
    showError,
  });
  const { updateComposerModel, loadAvailableModels, maybeInheritLastModel } = modelState;
  updateComposerThinking = modelState.updateComposerThinking;

  const workflowModeController = setupWorkflowModeController({
    input,
    sendButton,
    control,
    preferences,
    runtime,
    getTarget: () => target,
    getPiBusy: () => store.lifecycle === "working",
    getModel: () => {
      const current = modelState.getCurrentModel();
      return current.provider && current.id ? current : null;
    },
    t,
    showError,
  });

  const workspacePanels = setupWorkspacePanelsController({
    data,
    control,
    runtime,
    messagesElement,
    input,
    composerAutoResize,
    getTarget: () => target,
    getAtFileMention: () => composerSend?.atFileMention ?? null,
    showError,
  });
  const costAndCompaction = setupSessionCostAndCompaction({
    runtime,
    contextUsage,
    getTarget: () => target,
    getStore: () => store,
    clearStoreCompaction: () => {
      if (store.compaction?.status === "running") store = { ...store, compaction: null };
    },
    getSessions: () => sessionSwitching?.getSidebar()?.sessions ?? [],
    t,
    showError,
  });
  const {
    todoMirrorPanel,
    customUiPanel,
    subagentCatalog,
    subagentRuns,
    commandCompatibility,
    extensionWidgets,
    remoteWorkspaceDialog,
    extensionUi,
  } = await setupNativeExtensionUi({
    adapter,
    runtime,
    control,
    config,
    sessionStatus,
    dom,
    messageRenderer,
    composerAutoResize,
    applyHostStatus,
    getTarget: () => target,
    t,
    showError,
  });

  const chatHistory = createChatHistoryRenderer({
    messagesElement,
    messageRenderer,
    toolRenderer,
    extensionUi,
    subagentRuns,
    getTarget: () => target,
    t,
    showError,
  });

  let sessionHydration = null;
  infoPanelController = setupInfoPanelController({
    data,
    runtime,
    control,
    config,
    turnTrace,
    getTarget: () => target,
    getSessions: () => sessionSwitching?.getSidebar()?.sessions ?? [],
    getCurrentModel: () => modelState.getCurrentModel(),
    isStreaming: () => store.lifecycle === "working",
    hydrateSnapshotOnce: () => sessionHydration.hydrateSnapshotOnce(),
    t,
  });
  const superAgentController = setupSuperAgentController({
    adapter,
    runtime,
    input,
    composerAutoResize,
    getTarget: () => target,
    getSidebar: () => sessionSwitching?.getSidebar() ?? null,
    switchSession: (sessionId) => sessionSwitching.switchSession(sessionId),
    showError,
  });
  sessionHydration = createSessionHydrationController({
    adapter,
    runtime,
    data,
    extensionUi,
    todoMirrorPanel,
    queuedMessages,
    convNav,
    contextUsage,
    chatHistory,
    costAndCompaction,
    getTarget: () => target,
    getStore: () => store,
    setStore: (nextStore) => {
      store = nextStore;
    },
    getNavigationGeneration: () => sessionSwitching?.getNavigationGeneration() ?? 0,
    getAdoptTarget: () => (nextTarget, options) =>
      sessionSwitching.adoptTarget(nextTarget, options),
    getTaskAnalysis: () => infoPanelController.taskAnalysis,
    consumePendingModelRestore: () => modelState.consumePendingModelRestore(),
    updateComposerModel,
    updateComposerThinking,
    maybeInheritLastModel,
    getCurrentModelContextWindow: () => modelState.getCurrentModelContextWindow(),
    setStatus,
    markConfigGatewayReady,
  });

  let runtimeDispatcher = null;
  sessionSwitching = setupSessionSwitchingController({
    adapter,
    runtime,
    data,
    control,
    config,
    messagesElement,
    queuedMessages,
    input,
    composerAutoResize,
    convNav,
    messageRenderer,
    toolRenderer,
    todoMirrorPanel,
    extensionWidgets,
    customUiPanel,
    filePreviewFollow: workspacePanels.filePreviewFollow,
    extensionUi,
    sessionUiState,
    chatHistory,
    sessionHydration,
    infoPanelController,
    costAndCompaction,
    workflowModeController,
    superAgentController,
    resetRuntimeStreamingState: () => runtimeDispatcher?.resetStreamingState(),
    getTarget: () => target,
    setTarget: (nextTarget) => {
      target = nextTarget;
    },
    getStore: () => store,
    setStore: (nextStore) => {
      store = nextStore;
    },
    markConfigGatewayUnready,
    getCurrentModel: () => modelState.getCurrentModel(),
    getCurrentThinkingLevel: () => modelState.getCurrentThinkingLevel(),
    getPendingModelRestore: () => modelState.getPendingModelRestore(),
    setPendingModelRestore: (profile) => modelState.setPendingModelRestore(profile),
    updateComposerModel,
    updateComposerThinking,
    setStatus,
    t,
    showError,
  });
  runtimeDispatcher = setupRuntimeEventDispatcher({
    runtime,
    config,
    oauthGateway,
    subagentRuns,
    taskCompletionNotifications,
    turnTrace,
    queuedMessages,
    abortButton,
    messageRenderer,
    toolRenderer,
    todoMirrorPanel,
    extensionUi,
    convNav,
    contextUsage,
    chatHistory,
    workspacePanels,
    infoPanelController,
    costAndCompaction,
    superAgentController,
    sessionHydration,
    sessionSwitching,
    getTarget: () => target,
    getStore: () => store,
    setStore: (nextStore) => {
      store = nextStore;
    },
    getCurrentModelContextWindow: () => modelState.getCurrentModelContextWindow(),
    setStatus,
    t,
    showError,
  });

  setupConfigGatewayConnectionListener({
    adapter,
    isReady: isConfigGatewayReady,
    onDisconnected: () => {
      setStatus("disconnected");
      costAndCompaction.compactCoordinator.reset();
      if (store.compaction?.status === "running") store = { ...store, compaction: null };
    },
  });
  adapter.connect();

  sessionSwitching.setupSessionSidebar();
  sessionSwitching.getSidebar()?.load().catch(showError);
  workspacePanels.setupSidebarToggle();
  composerSend = setupComposerSendController({
    ...dom,
    composerAutoResize,
    runtime,
    config,
    toolRenderer,
    messageRenderer,
    commandCompatibility,
    subagentCatalog,
    subagentRuns,
    ensureWorkflowModeForPrompt: (value) =>
      workflowModeController.ensureWorkflowModeForPrompt(value),
    remoteWorkspaceDialog,
    getTarget: () => target,
    getStore: () => store,
    clearPendingForkSwitchCheck: () => sessionSwitching.clearPendingForkSwitchCheck(),
    t,
    showError,
  });
  workspacePanels.setupFileBrowser();

  ({ settingsPanel } = setupWorkspaceChromeActions({
    data,
    control,
    preferences,
    terminalIntegration,
    config,
    oauthGateway,
    runtime,
    notifications,
    remoteAuth,
    remoteWorkspaceDialog,
    sessionSwitching,
    runtimeDispatcher,
    input,
    getTarget: () => target,
    getStore: () => store,
    onModelConfigurationChanged: () => {
      void modelState.composerModelPicker?.reloadModels();
    },
    onThinkingLevelChanged: (level, changedTarget) => {
      if (changedTarget?.sessionId === target.sessionId) updateComposerThinking(level);
    },
    showError,
  }));
  convNav.mount();

  await sessionHydration.runInitialSessionStartup({
    route,
    control,
    input,
    sessionSwitching,
    composerSend,
    loadAvailableModels,
    showError,
  });

  onLocaleChange(() => {
    updateComposerThinking(modelState.getCurrentThinkingLevel());
    renderStatus();
    infoPanelController.taskAnalysis?.rerender();
  });

  window.__picotNative = {
    runtime,
    data,
    adapter,
    get target() {
      return target;
    },
  };
}

export const appReady = initializeApp();
