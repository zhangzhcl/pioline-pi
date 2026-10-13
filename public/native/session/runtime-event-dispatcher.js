import { renderQueuedMessages } from "../composer/queued-messages.js";
import { consumeConfigResponseFrame } from "../transport/config-gateway.js";
import { routeRuntimeFrame } from "../transport/runtime-frame-routing.js";
import { extractRuntimeEventError } from "./assistant-error.js";
import { createAssistantMessageStream } from "./assistant-message-stream.js";
import { textFromResult } from "./chat-history-renderer.js";
import { reduceSessionState } from "./session-store.js";

/**
 * 负责订阅宿主运行时帧（前台会话事件、后台会话状态与工作流宿主广播）并驱动流式消息渲染、工具卡片生命周期与中断操作。
 */
export function setupRuntimeEventDispatcher({
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
  getTarget,
  getStore,
  setStore,
  getCurrentModelContextWindow,
  setStatus,
  t,
  showError,
}) {
  const assistantMessageStream = createAssistantMessageStream();
  let streamingElement = null;
  let streamingStartedAt = null;
  let lastShownProviderError = null;

  function resetStreamingState() {
    assistantMessageStream.reset();
    streamingElement = null;
    streamingStartedAt = null;
  }

  function abortCurrentRun() {
    runtime.request({ type: "abort" }, getTarget()).catch(showError);
    extensionUi.cancelForeground();
  }

  abortButton?.addEventListener("click", abortCurrentRun);

  function showProviderErrorIfNeeded(event) {
    const error = extractRuntimeEventError(event, { fallback: t("messages.providerError") });
    if (!error || error === lastShownProviderError) return;
    lastShownProviderError = error;
    messageRenderer.renderError(error);
  }

  function settleForegroundAgent(event) {
    const target = getTarget();
    setStatus("connected");
    infoPanelController.taskAnalysis?.setStreaming(false);
    contextUsage.setWorking(false);
    sessionSwitching.getSidebar()?.setStreaming(target.sessionId, false);
    chatHistory.hideLiveProcessIndicator();
    chatHistory.collapseCompletedTurn({ markDone: true });
    workspacePanels.mountTurnFileChips();
    showProviderErrorIfNeeded(event);
  }

  async function handleBackgroundRuntimeEvent(frame) {
    const sessionId = frame.target?.sessionId;
    const sidebar = sessionSwitching.getSidebar();
    switch (frame.event?.type) {
      case "agent_start":
        sidebar?.setStreaming(sessionId, true);
        sidebar?.markUnread(sessionId);
        break;
      case "agent_settled":
        sidebar?.setStreaming(sessionId, false);
        sidebar?.markUnread(sessionId);
        break;
      case "agent_end":
        sidebar?.markUnread(sessionId);
        break;
      case "message_end":
        if (frame.event.message?.role === "assistant") {
          sidebar?.markUnread(sessionId);
        }
        break;
      case "session_bound":
        await superAgentController.bindDispatchedChildSession(
          frame.target?.instanceId,
          frame.event?.sessionId,
        );
        break;
      case "session_info_changed":
        sidebar?.setSessionName(sessionId, frame.event.name);
        break;
    }
  }

  async function handleRuntimeEvent(event) {
    const target = getTarget();
    const sidebar = sessionSwitching.getSidebar();
    switch (event.type) {
      case "agent_start":
        lastShownProviderError = null;
        assistantMessageStream.reset();
        infoPanelController.taskAnalysis?.setStreaming(true);
        setStatus("working");
        contextUsage.setWorking(true);
        sidebar?.setStreaming(target.sessionId, true);
        workspacePanels.resetTurnWrittenPaths();
        break;
      case "agent_settled":
        settleForegroundAgent(event);
        sessionSwitching.consumeForkSwitchCheckIfMatching();
        break;
      case "agent_end":
        if (!event.willRetry) showProviderErrorIfNeeded(event);
        break;
      case "session_info_changed":
        sidebar?.setSessionName(target.sessionId, event.name);
        break;
      case "compaction_start":
        costAndCompaction.compactCoordinator.started();
        break;
      case "compaction_end": {
        const succeeded =
          !event.errorMessage && !event.error && !event.aborted && event.result !== null;
        costAndCompaction.compactCoordinator.ended({
          success: succeeded,
          error: event.errorMessage || event.error,
        });
        if (!succeeded) {
          const error = event.errorMessage || event.error;
          if (error) showError(new Error(error));
        } else {
          await sessionHydration.hydrateSnapshotOnce();
          costAndCompaction.hydrateHeaderSessionStats();
        }
        break;
      }
      case "message_start":
        if (event.message?.role === "user") {
          messageRenderer.renderUserMessage(event.message);
          sessionSwitching.upsertActiveSessionFromUserMessage(event.message);
        } else if (event.message?.role === "assistant") {
          const message = assistantMessageStream.start(event.message);
          chatHistory.showLiveProcessIndicator();
          streamingStartedAt = Date.now();
          streamingElement = messageRenderer.renderAssistantMessage(message, true);
        }
        break;
      case "message_update": {
        const message = assistantMessageStream.update(event);
        if (!streamingElement) {
          chatHistory.showLiveProcessIndicator();
          streamingStartedAt = Date.now();
          streamingElement = messageRenderer.renderAssistantMessage(message, true);
        } else {
          messageRenderer.updateStreamingMessage(streamingElement, message.content);
        }
        if (event.assistantMessageEvent?.type === "toolcall_end") {
          const toolCall = event.assistantMessageEvent.toolCall;
          if (toolCall?.id && toolCall.name) {
            toolRenderer.createToolCard({
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              args: toolCall.arguments ?? {},
              status: "pending",
            });
          }
        }
        break;
      }
      case "message_end":
        if (event.message?.role === "assistant") {
          const message = assistantMessageStream.finish(event.message);
          if (streamingElement) {
            const durationMs = streamingStartedAt != null ? Date.now() - streamingStartedAt : null;
            messageRenderer.updateStreamingMessage(streamingElement, message.content);
            messageRenderer.finalizeStreamingMessage(
              streamingElement,
              message.usage ?? null,
              "",
              durationMs,
            );
            contextUsage.setUsage(message.usage ?? null, getCurrentModelContextWindow());
            costAndCompaction.addSessionCost(message.usage?.cost?.total ?? 0);
            costAndCompaction.headerStatusBar?.applyLiveUsage?.(message.usage ?? null);
            streamingElement = null;
            streamingStartedAt = null;
            convNav.notifyNewMessage();
          }
          showProviderErrorIfNeeded(event);
          infoPanelController.refreshIfOpen();
        } else if (event.message?.role === "user") {
          infoPanelController.refreshIfOpen();
        }
        break;
      case "tool_execution_start":
        toolRenderer.createToolCard({ ...event, status: "pending" });
        workspacePanels.filePreviewFollow.onToolStart(event);
        break;
      case "tool_execution_update":
        toolRenderer.updateToolCard({
          ...event,
          status: "streaming",
          output: textFromResult(event.partialResult),
        });
        break;
      case "tool_execution_end":
        toolRenderer.finalizeToolCard(event.toolCallId, event.result, event.isError);
        if (event.toolName === "todo" && !event.isError) {
          todoMirrorPanel.applyToolResult(event.result);
        }
        void workspacePanels.filePreviewFollow.onToolEnd(event).catch(showError);
        break;
      case "extension_ui_request":
        await extensionUi.handle(target, event);
        break;
      case "extension_error":
        showError(new Error(event.error || "Extension failed"));
        break;
      case "session_bound":
        await sessionSwitching.adoptTarget({ ...target, sessionId: event.sessionId });
        sessionSwitching.upsertActiveSessionFromUserMessage();
        await sessionHydration.hydrateSnapshotOnce();
        sessionSwitching.getSidebar()?.load({ quiet: true }).catch(showError);
        break;
    }
  }

  runtime.subscribe((frame) => {
    if (
      frame.type === "workflow_changed" ||
      frame.type === "workflow_node_templates_changed" ||
      frame.type === "workflow_run_changed" ||
      frame.type === "workflow_resync_required"
    ) {
      window.dispatchEvent(new CustomEvent("pipline:workflow-host-event", { detail: frame }));
      return;
    }
    if (frame.type !== "runtime_event") return;
    if (subagentRuns.applyEvent(frame)) return;
    taskCompletionNotifications.handleRuntimeFrame(frame);
    turnTrace.handleRuntimeFrame(frame);
    const previous = getStore();
    const routed = routeRuntimeFrame({
      frame,
      target: getTarget(),
      store: previous,
      consumeConfigResponse: (candidate) => {
        if (oauthGateway.consumeFrame(candidate)) return true;
        return consumeConfigResponseFrame(config, candidate);
      },
      reduceForeground: reduceSessionState,
    });
    if (routed.kind === "background" || routed.kind === "consumed-background") {
      if (routed.kind === "background") handleBackgroundRuntimeEvent(frame).catch(showError);
      return;
    }
    const nextStore = routed.store;
    setStore(nextStore);
    if (!previous.snapshotRequired && nextStore.snapshotRequired) {
      sessionHydration.hydrateSnapshotOnce().catch(showError);
      return;
    }
    if (previous.queue !== nextStore.queue) renderQueuedMessages(queuedMessages, nextStore.queue);
    if (routed.kind === "consumed-foreground") return;
    handleRuntimeEvent(frame.event).catch(showError);
  });

  return {
    resetStreamingState,
    abortCurrentRun,
    handleRuntimeEvent,
    handleBackgroundRuntimeEvent,
  };
}
