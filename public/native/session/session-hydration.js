import { reconcileSnapshotTarget } from "../../session/bootstrap-target.js";
import { getLastModel } from "../composer/last-model-store.js";
import { restoreSessionModel } from "../composer/model-restoration.js";
import { renderQueuedMessages } from "../composer/queued-messages.js";
import { resolveBootstrapTarget } from "../transport/bootstrap-target.js";
import { signalConfigGatewayReady } from "../transport/config-gateway-readiness.js";
import { randomId } from "../utils/random-id.js";
import { replaceTemporarySessionRoute } from "../utils/router.js";
import { findLatestAssistantUsage } from "../workspace/context-usage.js";
import { setupHeaderOpenApp } from "../workspace/header-open-app.js";
import { setupProjectHeader } from "../workspace/project-header.js";
import { computeTotalCostFromMessages } from "../workspace/session-cost-compaction.js";
import { refreshSshRemoteIndicator } from "../workspace/ssh-remote-indicator.js";
import { spawnSessionViaHost } from "../workspace/workspace-actions.js";
import { summarizeMessageRoles } from "./chat-history-renderer.js";
import { shouldApplyInitialDiskHistory } from "./initial-session-history.js";
import { reduceSessionState } from "./session-store.js";

export function provisionalTargetFromRoute(currentRoute) {
  return {
    workspaceId: currentRoute.workspaceId,
    sessionId: currentRoute.sessionId,
    instanceId: "pending-bootstrap",
  };
}

/**
 * 判断错误是否属于短暂的 WebSocket 断连重连窗口，而非永久性错误。
 */
export function isTransientConnectionError(error) {
  const msg = error?.message ?? "";
  return (
    msg.includes("Pipline Host runtime is disconnected") ||
    msg.includes("Runtime disconnected before the request completed") ||
    msg.includes("Host disconnected before the")
  );
}

export async function requestBootstrapTarget(currentRoute) {
  const query = new URLSearchParams({
    workspaceId: currentRoute.workspaceId,
    sessionId: currentRoute.sessionId,
  });
  const response = await fetch(`/v2/bootstrap?${query}`);
  if (!response.ok) {
    const error = new Error("This Pipline runtime is stopped or unavailable");
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function loadBootstrapTarget(currentRoute) {
  return resolveBootstrapTarget({
    route: currentRoute,
    requestTarget: requestBootstrapTarget,
    spawnTemporarySession: spawnSessionViaHost,
  });
}

/**
 * 管理会话快照拉取（含去重与瞬时断连重试）、初始磁盘历史快速回填以及消息源择优渲染。
 */
export function createSessionHydrationController({
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
  getTarget,
  getStore,
  setStore,
  getNavigationGeneration,
  getAdoptTarget,
  getTaskAnalysis,
  consumePendingModelRestore,
  updateComposerModel,
  updateComposerThinking,
  maybeInheritLastModel,
  getCurrentModelContextWindow,
  setStatus,
  markConfigGatewayReady,
}) {
  let snapshotInFlight = false;
  let diskHistoryFallback = null;
  let initialHistoryContext = null;

  function chooseHydrationMessages(snapshotMessages, reason) {
    const currentTarget = getTarget();
    const messages = Array.isArray(snapshotMessages) ? snapshotMessages : [];
    const fallbackMatches = diskHistoryFallback?.sessionId === currentTarget.sessionId;
    const fallbackCount = fallbackMatches ? diskHistoryFallback.messages.length : 0;
    const source =
      fallbackMatches && messages.length < fallbackCount ? "disk-fallback" : "snapshot";
    console.info("[SESSION-LOAD] hydrate message source", {
      reason,
      currentSessionId: currentTarget.sessionId,
      snapshotCount: messages.length,
      snapshotRoles: summarizeMessageRoles(messages),
      fallbackSessionId: diskHistoryFallback?.sessionId ?? null,
      fallbackCount,
      fallbackMatches,
      source,
    });
    return source === "disk-fallback" ? diskHistoryFallback.messages : messages;
  }

  async function applyInitialDiskHistory(sessionId, generation, diskMessages) {
    const context = initialHistoryContext;
    const currentTarget = getTarget();
    const store = getStore();
    if (
      !context ||
      context.sessionId !== sessionId ||
      context.generation !== generation ||
      currentTarget.sessionId !== sessionId ||
      getNavigationGeneration() !== generation ||
      (!context.snapshot && context.diskRendered) ||
      !shouldApplyInitialDiskHistory({
        diskMessages,
        expectedSessionId: sessionId,
        currentSessionId: currentTarget.sessionId,
        snapshot: context.snapshot,
        snapshotStarted: context.snapshotStarted,
        currentSequence: store.sequence,
        currentLifecycle: store.lifecycle,
      })
    ) {
      return false;
    }

    const renderStartedAt = performance.now();
    const hadInFlightPrompt = chatHistory.renderHistory(diskMessages);
    todoMirrorPanel.hydrateFromMessages(diskMessages);
    convNav.rebuild();
    contextUsage.setUsage(findLatestAssistantUsage(diskMessages), getCurrentModelContextWindow());
    costAndCompaction.setSessionCost(computeTotalCostFromMessages(diskMessages));
    console.info("[SESSION-LOAD] initial disk history rendered", {
      sessionId,
      messageCount: diskMessages.length,
      elapsedMs: Math.round(performance.now() - renderStartedAt),
      totalElapsedMs: Math.round(performance.now() - context.startedAt),
      afterSnapshot: Boolean(context.snapshot),
    });
    if (context.snapshot) {
      context.snapshot.messageCount = diskMessages.length;
    } else {
      context.diskRendered = true;
      setStatus("connected");
    }
    if (hadInFlightPrompt) await extensionUi.flushForegroundQueue();
    return true;
  }

  async function applyPendingInitialDiskHistory() {
    const context = initialHistoryContext;
    const fallback = diskHistoryFallback;
    if (
      !context?.snapshotStarted ||
      fallback?.sessionId !== context.sessionId ||
      fallback.messages.length === 0
    ) {
      return;
    }
    context.snapshotStarted = false;
    try {
      await applyInitialDiskHistory(context.sessionId, context.generation, fallback.messages);
    } catch (error) {
      console.warn("[SESSION-LOAD] failed to render disk history after Pi snapshot error", error);
    }
  }

  function startInitialDiskHistoryLoad({ initialLoadStartedAt }) {
    const target = getTarget();
    if (!target.sessionId.startsWith("temporary-")) {
      const sessionId = target.sessionId;
      const generation = getNavigationGeneration();
      initialHistoryContext = {
        sessionId,
        generation,
        startedAt: initialLoadStartedAt,
        snapshot: null,
        snapshotStarted: false,
      };
      void data
        .readSessionMessages(target.workspaceId, target.sessionId)
        .then(async (diskResult) => {
          if (
            getTarget().sessionId !== sessionId ||
            getNavigationGeneration() !== generation ||
            initialHistoryContext?.sessionId !== sessionId ||
            initialHistoryContext.generation !== generation
          ) {
            return;
          }
          const diskMessages = diskResult?.messages ?? [];
          diskHistoryFallback =
            diskMessages.length > 0 ? { sessionId, messages: diskMessages } : null;
          console.info("[SESSION-LOAD] initial disk fallback updated", {
            sessionId,
            messageCount: diskMessages.length,
            roles: summarizeMessageRoles(diskMessages),
            afterSnapshot: Boolean(initialHistoryContext.snapshot),
          });
          await applyInitialDiskHistory(sessionId, generation, diskMessages);
        })
        .catch((error) => {
          console.warn("[SESSION-LOAD] initial disk history failed", error);
        });
    } else {
      diskHistoryFallback = null;
      initialHistoryContext = null;
      console.info("[SESSION-LOAD] initial disk fallback skipped for temporary session", {
        sessionId: target.sessionId,
      });
    }
  }

  async function hydrateFromSnapshot(snapshot) {
    const initialTarget = getTarget();
    console.info("[SESSION-LOAD] hydrate snapshot received", {
      currentSessionId: initialTarget.sessionId,
      snapshotTarget: snapshot?.target ?? null,
      snapshotCount: Array.isArray(snapshot?.state?.messages)
        ? snapshot.state.messages.length
        : null,
    });
    const startupContext =
      initialHistoryContext?.sessionId === initialTarget.sessionId &&
      initialHistoryContext.generation === getNavigationGeneration()
        ? initialHistoryContext
        : null;
    if (startupContext) startupContext.snapshotStarted = true;
    await getAdoptTarget()(reconcileSnapshotTarget(initialTarget, snapshot.target));
    const nextStore = reduceSessionState(getStore(), snapshot);
    setStore(nextStore);
    const messages = chooseHydrationMessages(snapshot.state.messages, "snapshot");
    chatHistory.renderHistory(messages);
    todoMirrorPanel.hydrateFromMessages(messages);
    renderQueuedMessages(queuedMessages, nextStore.queue);
    convNav.rebuild();
    const pi = snapshot.state.pi ?? {};
    setStatus(pi.isStreaming ? "working" : "connected");
    contextUsage.setWorking(Boolean(pi.isStreaming));
    getTaskAnalysis()?.setStreaming(Boolean(pi.isStreaming));
    if (pi.isStreaming) chatHistory.showLiveProcessIndicator();
    contextUsage.setCompacting(snapshot.state.compaction?.status === "running");
    const restoredProfile = consumePendingModelRestore();
    const selection = await restoreSessionModel({
      runtime,
      target: getTarget(),
      profile: restoredProfile,
      state: pi,
      idempotencyKey: randomId,
    });
    updateComposerModel(selection.model, { persist: false });
    updateComposerThinking(selection.thinkingLevel, { persist: false });
    if (!restoredProfile && messages.length === 0) {
      const storedModel = getLastModel();
      if (storedModel) {
        updateComposerModel(
          { provider: storedModel.provider, id: storedModel.modelId },
          { persist: false },
        );
        void maybeInheritLastModel({ messages, piModel: pi.model ?? null });
      }
    }
    contextUsage.setUsage(findLatestAssistantUsage(messages), getCurrentModelContextWindow());
    costAndCompaction.setSessionCost(computeTotalCostFromMessages(messages));
    costAndCompaction.hydrateHeaderSessionStats();
    await extensionUi.flushForegroundQueue();
    const settledTarget = getTarget();
    chatHistory.logMessagesDom("hydrate snapshot rendered", {
      sessionId: settledTarget.sessionId,
      renderedCount: messages.length,
    });
    if (
      startupContext &&
      initialHistoryContext === startupContext &&
      settledTarget.sessionId === startupContext.sessionId &&
      getNavigationGeneration() === startupContext.generation
    ) {
      startupContext.snapshot = {
        messageCount: messages.length,
        sequence: snapshot.sequence ?? getStore().sequence,
      };
      startupContext.snapshotStarted = false;
      if (
        diskHistoryFallback?.sessionId === startupContext.sessionId &&
        diskHistoryFallback.messages.length > messages.length
      ) {
        await applyInitialDiskHistory(
          startupContext.sessionId,
          startupContext.generation,
          diskHistoryFallback.messages,
        );
      }
    }
    requestAnimationFrame(() => {
      chatHistory.logMessagesDom("hydrate snapshot rendered after frame", {
        sessionId: getTarget().sessionId,
        renderedCount: messages.length,
      });
    });
  }

  async function hydrateSnapshot() {
    const expectedSessionId = getTarget().sessionId;
    const snapshot = await runtime.snapshot(expectedSessionId);
    if (getTarget().sessionId !== expectedSessionId) return;
    await hydrateFromSnapshot(snapshot);
    markConfigGatewayReady();
    signalConfigGatewayReady();
  }

  async function hydrateSnapshotOnce() {
    if (snapshotInFlight) return;
    snapshotInFlight = true;
    try {
      await hydrateSnapshot();
    } catch (error) {
      await applyPendingInitialDiskHistory();
      if (isTransientConnectionError(error)) {
        console.warn(
          "[Session] Transient connection error during snapshot; retrying after reconnect:",
          error.message,
        );
        await adapter.ready();
        await hydrateSnapshot();
      } else {
        throw error;
      }
    } finally {
      snapshotInFlight = false;
    }
  }

  async function runInitialSessionStartup({
    route,
    control,
    input,
    sessionSwitching,
    composerSend,
    loadAvailableModels,
    showError,
  }) {
    let startupStage = "adopting Pi runtime";
    try {
      const initialLoadStartedAt = performance.now();
      console.info("[SESSION-LOAD] initial load started", { sessionId: route.sessionId });
      const bootstrappedTarget = await loadBootstrapTarget(route);
      console.info("[SESSION-LOAD] initial target adopted", {
        sessionId: bootstrappedTarget.sessionId,
        temporary: bootstrappedTarget.sessionId.startsWith("temporary-"),
        elapsedMs: Math.round(performance.now() - initialLoadStartedAt),
      });
      startupStage = "connecting to the native host";
      setStatus("loading");
      await sessionSwitching.adoptTarget(bootstrappedTarget, { updateRoute: false });
      sessionSwitching.getSidebar()?.load({ quiet: true }).catch(showError);
      const currentTarget = getTarget();
      if (route.sessionId.startsWith("temporary-") && currentTarget.sessionId !== route.sessionId) {
        replaceTemporarySessionRoute(
          history,
          route.workspaceId,
          route.sessionId,
          currentTarget.sessionId,
        );
      }
      const hostReadyStartedAt = performance.now();
      console.info("[SESSION-LOAD] waiting for Host connection", {
        sessionId: currentTarget.sessionId,
      });
      await Promise.race([
        adapter.ready(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("连接 Pipline 本地服务超时，请重启应用后重试。")),
            15000,
          ),
        ),
      ]);
      console.info("[SESSION-LOAD] initial Host connection ready", {
        elapsedMs: Math.round(performance.now() - hostReadyStartedAt),
        totalElapsedMs: Math.round(performance.now() - initialLoadStartedAt),
      });
      if (getTarget().sessionId.startsWith("temporary-")) setStatus("connected");

      startInitialDiskHistoryLoad({ initialLoadStartedAt });
      input.focus();

      startupStage = "loading the Pi conversation";
      const snapshotStartedAt = performance.now();
      const snapshotTimeout = setTimeout(() => {
        showError(new Error("Pi 对话加载超时。请检查内置 Pi 运行时是否正常启动。"));
      }, 20000);
      await hydrateSnapshotOnce();
      clearTimeout(snapshotTimeout);
      const hydratedTarget = getTarget();
      console.info("[SESSION-LOAD] initial Pi snapshot hydrated", {
        sessionId: hydratedTarget.sessionId,
        elapsedMs: Math.round(performance.now() - snapshotStartedAt),
        totalElapsedMs: Math.round(performance.now() - initialLoadStartedAt),
      });
      refreshSshRemoteIndicator({ call: window.__picotConfigCall }).catch((error) => {
        console.warn("[Native] Failed to probe the remote workspace binding:", error);
      });
      await Promise.all([
        composerSend
          .loadCommands()
          .then(() => composerSend.slashMenu.update())
          .catch((error) => {
            console.warn("[Native] Failed to load slash commands:", error);
          }),
        setupProjectHeader({
          data,
          workspaceId: hydratedTarget.workspaceId,
        }).catch((error) => {
          console.warn("[Native] Failed to load project header info:", error);
        }),
        Promise.resolve(
          setupHeaderOpenApp({
            data,
            control,
            workspaceId: hydratedTarget.workspaceId,
            onError: showError,
          }),
        ).catch((error) => {
          console.warn("[Native] Failed to set up app launcher:", error);
        }),
        loadAvailableModels().catch((error) => {
          console.warn("[Native] Failed to load available models:", error);
        }),
      ]);
    } catch (error) {
      showError(new Error(`启动阶段「${startupStage}」失败：${error?.message ?? String(error)}`));
    }
  }

  return {
    hydrateFromSnapshot,
    hydrateSnapshot,
    hydrateSnapshotOnce,
    startInitialDiskHistoryLoad,
    runInitialSessionStartup,
    setDiskHistoryFallback(fallback) {
      diskHistoryFallback = fallback;
    },
    clearDiskHistoryFallbackForSession(sessionId) {
      if (diskHistoryFallback?.sessionId === sessionId) {
        diskHistoryFallback = null;
      }
    },
    resetInFlight() {
      snapshotInFlight = false;
    },
  };
}
