import { profileForNewSession, profileForSnapshotRebind } from "../composer/model-restoration.js";
import { renderQueuedMessages } from "../composer/queued-messages.js";
import { randomId } from "../utils/random-id.js";
import { appRoutePath, replaceTemporarySessionRoute } from "../utils/router.js";
import { setupProjectHeader } from "../workspace/project-header.js";
import { refreshSshRemoteIndicator } from "../workspace/ssh-remote-indicator.js";
import { createSessionViaHost } from "../workspace/workspace-actions.js";
import { summarizeMessageRoles, textFromMessageContent } from "./chat-history-renderer.js";
import { loadBootstrapTarget } from "./session-hydration.js";
import { createSessionSelectionHandler } from "./session-navigation.js";
import { setupSessionSearchDialog } from "./session-search-dialog.js";
import { SessionSidebar } from "./session-sidebar.js";
import { createSessionStore } from "./session-store.js";

/**
 * 封装会话侧边栏挂载、同窗口/跨项目会话切换、目标（Target）采用重绑、以及会话分叉（Fork）与编辑重放。
 */
export function setupSessionSwitchingController({
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
  filePreviewFollow,
  extensionUi,
  sessionUiState,
  chatHistory,
  sessionHydration,
  infoPanelController,
  costAndCompaction,
  workflowModeController,
  superAgentController,
  resetRuntimeStreamingState,
  getTarget,
  setTarget,
  getStore,
  setStore,
  markConfigGatewayUnready,
  getCurrentModel,
  getCurrentThinkingLevel,
  getPendingModelRestore,
  setPendingModelRestore,
  updateComposerModel,
  updateComposerThinking,
  setStatus,
  t,
  showError,
}) {
  let sidebar = null;
  let navigationGeneration = 0;
  let pendingBoundSessionFirstMessage = null;
  let pendingForkSwitchCheck = null;

  async function adoptTarget(nextTarget, { updateRoute = true, profileOverride = undefined } = {}) {
    const previousTarget = getTarget();
    const currentModel = getCurrentModel();
    const effectiveProfileOverride =
      profileOverride === undefined
        ? profileForSnapshotRebind(
            previousTarget,
            nextTarget,
            getPendingModelRestore(),
            { provider: currentModel.provider, id: currentModel.id },
            getCurrentThinkingLevel(),
          )
        : profileOverride;
    const sessionChanged = nextTarget.sessionId !== previousTarget.sessionId;
    const targetChanged =
      sessionChanged ||
      nextTarget.workspaceId !== previousTarget.workspaceId ||
      nextTarget.instanceId !== previousTarget.instanceId;
    if (!targetChanged) return;
    markConfigGatewayUnready();
    if (updateRoute && sessionChanged) {
      replaceTemporarySessionRoute(
        history,
        previousTarget.workspaceId,
        previousTarget.sessionId,
        nextTarget.sessionId,
      );
    }
    setTarget(nextTarget);
    workflowModeController.syncTargetOnSwitch(nextTarget);
    const nextStore = createSessionStore(nextTarget);
    setStore(nextStore);
    sessionHydration.resetInFlight();
    renderQueuedMessages(queuedMessages, nextStore.queue);
    todoMirrorPanel.clear();
    extensionWidgets.clear();
    customUiPanel.close({ notifyExtension: false });
    filePreviewFollow.clear();
    resetRuntimeStreamingState();
    chatHistory.resetLiveProcessGroup();
    adapter.subscribeTarget(nextTarget);
    sidebar?.setActive(nextTarget.sessionId);
    if (nextTarget.workspaceId !== previousTarget.workspaceId) {
      sidebar?.load().catch(showError);
      setupProjectHeader({
        data,
        workspaceId: nextTarget.workspaceId,
      }).catch((error) => {
        console.warn("[Native] Failed to load project header info:", error);
      });
      refreshSshRemoteIndicator({ call: window.__picotConfigCall }).catch((error) => {
        console.warn("[Native] Failed to probe the remote workspace binding:", error);
      });
    }
    infoPanelController.onTargetChanged({
      workspaceChanged: nextTarget.workspaceId !== previousTarget.workspaceId,
    });
    costAndCompaction.resetForNewTarget();
    const restoredProfile =
      effectiveProfileOverride === undefined
        ? await sessionUiState.loadProfile()
        : effectiveProfileOverride;
    if (getTarget() !== nextTarget) return;
    setPendingModelRestore(restoredProfile);
    if (restoredProfile) {
      updateComposerModel(
        { provider: restoredProfile.provider, id: restoredProfile.modelId },
        { persist: false },
      );
      updateComposerThinking(restoredProfile.thinkingLevel, { persist: false });
    }
    composerAutoResize.sync();
    await extensionUi.setForegroundSession(nextTarget.sessionId, { flush: false });
  }

  async function switchSession(sessionId) {
    const currentTarget = getTarget();
    if (!sessionId || sessionId === currentTarget.sessionId) return;
    const generation = ++navigationGeneration;
    const switchStartedAt = performance.now();
    console.info("[SESSION-LOAD] session switch started", { sessionId, generation });

    setStatus("loading");
    infoPanelController.taskAnalysis?.resetHistory();

    const workspaceId = currentTarget.workspaceId;
    const bootstrapPromise = loadBootstrapTarget({ name: "session", workspaceId, sessionId }).then(
      (nextTarget) => {
        console.info("[SESSION-LOAD] switch bootstrap completed", {
          sessionId,
          generation,
          elapsedMs: Math.round(performance.now() - switchStartedAt),
        });
        return nextTarget;
      },
    );
    const [nextTarget, diskLoad] = await Promise.all([
      bootstrapPromise,
      data
        .readSessionMessages(workspaceId, sessionId)
        .then((result) => {
          if (generation !== navigationGeneration) return { result, hadInFlightPrompt: false };
          const diskMessages = result?.messages ?? [];
          sessionHydration.setDiskHistoryFallback(
            diskMessages.length > 0 ? { sessionId, messages: diskMessages } : null,
          );
          console.info("[SESSION-LOAD] switch disk fallback updated", {
            sessionId,
            messageCount: diskMessages.length,
            roles: summarizeMessageRoles(diskMessages),
          });
          const renderStartedAt = performance.now();
          const hadInFlightPrompt = chatHistory.renderHistory(diskMessages);
          convNav.rebuild();
          console.info("[SESSION-LOAD] switch disk history rendered", {
            sessionId,
            generation,
            messageCount: diskMessages.length,
            elapsedMs: Math.round(performance.now() - renderStartedAt),
            totalElapsedMs: Math.round(performance.now() - switchStartedAt),
          });
          return { result, hadInFlightPrompt };
        })
        .catch((error) => {
          console.warn("[SESSION-LOAD] switch disk history failed", error);
          return { result: null, hadInFlightPrompt: false };
        }),
    ]);
    if (generation !== navigationGeneration) return;

    await adoptTarget(nextTarget, { updateRoute: false });
    const adoptedTarget = getTarget();
    history.pushState(
      null,
      "",
      appRoutePath({
        name: "session",
        workspaceId: adoptedTarget.workspaceId,
        sessionId: adoptedTarget.sessionId,
      }),
    );
    const adoptedSession =
      sidebar?.sessions?.find((session) => session.id === adoptedTarget.sessionId) ?? null;
    superAgentController.updateSuperAgentActiveState(adoptedSession);

    setStatus("connected");
    if (diskLoad.hadInFlightPrompt) {
      await extensionUi.flushForegroundQueue();
    }

    try {
      const snapshotStartedAt = performance.now();
      const snapshot = await runtime.snapshot(getTarget().sessionId);
      if (generation !== navigationGeneration) return;
      await sessionHydration.hydrateFromSnapshot(snapshot);
      console.info("[SESSION-LOAD] switch Pi snapshot hydrated", {
        sessionId: getTarget().sessionId,
        generation,
        elapsedMs: Math.round(performance.now() - snapshotStartedAt),
        totalElapsedMs: Math.round(performance.now() - switchStartedAt),
      });
    } catch (error) {
      if (generation !== navigationGeneration) return;
      console.warn("[switchSession] Pi snapshot failed, showing disk history:", error);
      setStatus("connected");
      await extensionUi.flushForegroundQueue();
    }
  }

  function subscribeToLiveSessions(sessions) {
    infoPanelController.syncSessionInfo();
    for (const session of sessions ?? []) {
      const liveTarget = session?.target;
      if (liveTarget?.workspaceId && liveTarget?.sessionId && liveTarget?.instanceId) {
        adapter.subscribeTarget(liveTarget);
      }
    }
    superAgentController.syncActiveFromSessions(sessions);
    superAgentController.handleSuperAgentStartupSessions(sessions).catch(showError);
  }

  function setupSessionSidebar() {
    const container = document.getElementById("session-list");
    if (!container) return;
    const selectSession = createSessionSelectionHandler({
      switchSession,
      openSessionInProject: (session) => superAgentController.openSessionInProject(session),
      onError: showError,
    });
    superAgentController.setSelectSessionHandler(selectSession);
    sidebar = new SessionSidebar(container, {
      data,
      runtime,
      control,
      config,
      getTarget,
      onSelect: (session) => {
        superAgentController.updateSuperAgentActiveState(session);
        selectSession(session);
      },
      onCreateSession: createSessionViaHost,
      onSessionsLoaded: subscribeToLiveSessions,
      onAgentInboxSessionChange: (session) => superAgentController.setAgentInboxNavSession(session),
    });

    setupSessionSearchDialog({
      triggerInput: document.getElementById("session-search-input"),
      triggerClear: document.getElementById("session-search-clear"),
      overlay: document.getElementById("session-search-overlay"),
      dialog: document.getElementById("session-search-dialog"),
      input: document.getElementById("session-search-dialog-input"),
      list: document.getElementById("session-search-results"),
      data,
      getWorkspaceId: () => getTarget().workspaceId,
      getSessions: () => sidebar.sessions,
      onSelect: (session, { query } = {}) => {
        chatHistory.setActiveSearchQuery(query || "");
        superAgentController.updateSuperAgentActiveState(session);
        selectSession(session);
        if (session?.id === getTarget().sessionId) chatHistory.applyActiveSearchHighlight();
      },
      onQueryChange: (query) => {
        chatHistory.setActiveSearchQuery(query || "");
        chatHistory.applyActiveSearchHighlight({ scrollToFirst: false });
      },
      onError: showError,
    });
  }

  function upsertActiveSessionFromUserMessage(message = null) {
    const target = getTarget();
    const firstMessage = message
      ? textFromMessageContent(message.content)
      : pendingBoundSessionFirstMessage;
    if (target?.sessionId?.startsWith("temporary-")) {
      pendingBoundSessionFirstMessage = firstMessage;
      return;
    }
    if (!target?.sessionId) return;
    sidebar?.upsertSession({
      id: target.sessionId,
      workspaceId: target.workspaceId,
      firstMessage,
      timestamp: new Date().toISOString(),
      modifiedAtMs: Date.now(),
      isCurrentWorkspace: true,
    });
    pendingBoundSessionFirstMessage = null;
  }

  async function checkAndAdoptForkedSession() {
    try {
      const target = getTarget();
      const statsResult = await runtime.request({ type: "get_session_stats" }, target);
      const statsData = statsResult?.response?.data;
      if (!statsData?.sessionId || statsData.sessionId === target.sessionId) return;
      const rebound = await runtime.rebindSession(target, statsData.sessionId);
      if (!rebound) return;
      await sidebar?.load({ quiet: true });
      await adoptTarget(rebound, { updateRoute: true });
      await sessionHydration.hydrateSnapshotOnce();
    } catch (error) {
      showError(error);
    }
  }

  messagesElement?.addEventListener("messagefork", async (event) => {
    let { entryId } = event.detail;
    if (getStore().lifecycle === "working") {
      showError(new Error(t("infoPanel.actionWhileStreaming")));
      return;
    }
    try {
      const target = getTarget();
      if (!entryId) {
        const messageEl = event.target?.closest?.(".message.user") ?? null;
        const index = messageEl
          ? [...messagesElement.querySelectorAll(".message.user")].indexOf(messageEl)
          : -1;
        if (index >= 0) {
          const forkMessages = await runtime.request({ type: "get_fork_messages" }, target);
          entryId = forkMessages?.response?.data?.messages?.[index]?.entryId ?? null;
        }
        if (!entryId) {
          showError(
            new Error(t("errors.treeNavigateFailed", { error: "Invalid entry ID for forking" })),
          );
          return;
        }
      }
      const result = await runtime.request({ type: "fork", entryId }, target, {
        idempotencyKey: randomId(),
      });
      const dataResult = result?.response?.data;
      if (dataResult?.cancelled) return;
      sessionHydration.clearDiskHistoryFallbackForSession(target.sessionId);
      await sessionHydration.hydrateSnapshotOnce();
      pendingForkSwitchCheck = { ...getTarget() };
      if (dataResult?.text != null) {
        input.value = dataResult.text;
        composerAutoResize.sync();
        input.focus();
      }
    } catch (error) {
      showError(error);
    }
  });

  messagesElement?.addEventListener("messageedit", async (event) => {
    const { entryId, text } = event.detail || {};
    if (!entryId) return;
    if (getStore().lifecycle === "working") {
      showError(new Error(t("infoPanel.actionWhileStreaming")));
      return;
    }
    try {
      await infoPanelController.navigateActiveTree(entryId);
      if (typeof text === "string" && text) {
        input.value = text;
        composerAutoResize.sync();
        input.focus();
      }
    } catch (error) {
      showError(
        new Error(t("errors.treeNavigateFailed", { error: String(error?.message ?? error) })),
      );
    }
  });

  document.getElementById("refresh-sessions-btn")?.addEventListener("click", (e) => {
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    btn.classList.remove("spinning");
    void btn.offsetWidth;
    btn.classList.add("spinning");
    superAgentController
      .ensureSuperAgentStartupSession({ reloadAfterEnsure: false })
      .catch(showError);
    sidebar?.load().catch(showError);
  });

  window.addEventListener("picot:session-created", (event) => {
    const detail = event.detail;
    if (!detail?.sessionId || !detail?.workspaceId) return;
    const nextTarget = {
      workspaceId: detail.workspaceId,
      sessionId: detail.sessionId,
      instanceId: detail.instanceId || `pending-${detail.sessionId.slice(0, 8)}`,
    };
    const currentTarget = getTarget();
    if (nextTarget.workspaceId !== currentTarget.workspaceId) {
      const targetUrl = new URL(
        `/app/workspaces/${encodeURIComponent(nextTarget.workspaceId)}/sessions/${encodeURIComponent(nextTarget.sessionId)}`,
        window.location.origin,
      );
      if (targetUrl.origin === window.location.origin) {
        window.location.assign(targetUrl.toString());
      }
      return;
    }
    messageRenderer.clear();
    toolRenderer.clear();
    const currentModel = getCurrentModel();
    const profileOverride = nextTarget.sessionId.startsWith("temporary-")
      ? profileForNewSession(
          { provider: currentModel.provider, id: currentModel.id },
          getCurrentThinkingLevel(),
        )
      : undefined;
    void adoptTarget(nextTarget, { profileOverride }).then(() => {
      input.value = "";
      composerAutoResize.sync();
      input.focus();
      sessionHydration.hydrateSnapshotOnce().catch(showError);
    });
  });

  return {
    getSidebar: () => sidebar,
    getNavigationGeneration: () => navigationGeneration,
    setupSessionSidebar,
    adoptTarget,
    switchSession,
    upsertActiveSessionFromUserMessage,
    clearPendingForkSwitchCheck() {
      pendingForkSwitchCheck = null;
    },
    consumeForkSwitchCheckIfMatching() {
      const target = getTarget();
      if (
        pendingForkSwitchCheck &&
        pendingForkSwitchCheck.workspaceId === target.workspaceId &&
        pendingForkSwitchCheck.sessionId === target.sessionId &&
        pendingForkSwitchCheck.instanceId === target.instanceId
      ) {
        pendingForkSwitchCheck = null;
        void checkAndAdoptForkedSession();
      }
    },
  };
}
