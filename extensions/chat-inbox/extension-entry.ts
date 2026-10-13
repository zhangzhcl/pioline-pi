import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleRemoteInboundCommand, registerChatSlashCommands } from "./chat-commands.js";
import { registerChatInboxTools, registerWorkspaceDelegatedTools } from "./chat-tools.js";
import {
  ensureChatHome,
  listConfiguredConversations,
  loadChatConfig,
  resolveConversation,
} from "./config.js";
import { connectLive } from "./live/index.js";
import type { LiveConnection } from "./live/types.js";
import {
  type AssistantSummary,
  buildChatContextMessage,
  buildChatSystemPromptSuffix,
  buildMemoryPromptSuffix,
  buildSkillsPromptSuffix,
  buildSystemMdSuffix,
  CHAT_CONVERSATION_FLAG,
  extractAssistantSummary,
  getPersistedConversationId,
  type PersistedChatState,
  SESSION_STATE_CUSTOM_TYPE,
  waitForAbort,
} from "./prompt-context.js";
import { ConversationRuntime } from "./runtime.js";
import { selectStartupConversationId } from "./startup.js";
import { runWithLoader, showNotice } from "./tui/dialogs.js";

export default function (pi: ExtensionAPI) {
  pi.registerFlag(CHAT_CONVERSATION_FLAG, {
    description: "Auto-connect pi-chat to a configured account/channel",
    type: "string",
  });

  let runtime: ConversationRuntime | undefined;
  let liveConnection: LiveConnection | undefined;
  let ownerId = `pi-chat-${process.pid}-${randomUUID()}`;
  let chatTurnInFlight = false;
  let configLoadedAtLeastOnce = false;
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  let queuedOutboundAttachments: string[] = [];
  let pendingChatDispatch = false;
  let pendingControlAction: (() => Promise<void>) | undefined;
  let activeTriggerMessageId: string | undefined;
  let evictionNotice: string | undefined;
  let pendingLocalPrompt: string | undefined;
  let lastAgentSummary: AssistantSummary | undefined;

  function persistChatState(conversationId?: string): void {
    pi.appendEntry<PersistedChatState>(SESSION_STATE_CUSTOM_TYPE, {
      conversationId,
    });
  }

  async function loadConfigOnce() {
    if (configLoadedAtLeastOnce) return;
    await ensureChatHome();
    configLoadedAtLeastOnce = true;
  }

  async function connectConversation(
    ctx: ExtensionContext,
    conversationId: string,
    interactive = true,
  ): Promise<boolean> {
    const config = await loadChatConfig();
    const conversation = resolveConversation(config, conversationId);
    if (!conversation) {
      if (interactive)
        await showNotice(
          ctx,
          "Connect error",
          `Unknown configured channel: ${conversationId}`,
          "error",
        );
      return false;
    }
    await disconnectRuntime(ctx, false);
    evictionNotice = undefined;
    const result =
      (await runWithLoader(ctx, `Connecting ${conversation.conversationName}...`, async () => {
        runtime = await ConversationRuntime.connect(conversation, ownerId, {
          preempt: interactive,
          onLockLost: (holder) => {
            void handleEviction(ctx, `taken over by ${holder}`);
          },
        });
        liveConnection = await connectLive(
          conversation,
          {
            onMessage: async (input, checkpoint) => {
              if (!runtime) return;
              const handled = await handleRemoteInboundCommand(input, {
                pi,
                ctx,
                getRuntime: () => runtime,
                getLiveConnection: () => liveConnection,
                isChatTurnInFlight: () => chatTurnInFlight,
                setPendingControlAction: (action) => {
                  pendingControlAction = action;
                },
              });
              if (handled) return;
              await runtime.ingestInbound(input, checkpoint);
              await tryDispatch(ctx);
            },
            onCaughtUp: async () => {
              runtime?.armAfterCurrentTail();
            },
            onError: async (error) => {
              if (runtime) await runtime.appendError(error.message);
              updateStatus(ctx, error.message);
            },
            isStillOwner: async () => (runtime ? await runtime.stillOwnsChannel() : false),
            onEvicted: async (reason) => {
              await handleEviction(ctx, reason);
            },
            onDisconnect: async () => {
              if (!runtime || runtime.hasLostLock()) return;
              const cid = runtime.conversation.conversationId;
              updateStatus(ctx, "disconnected, reconnecting...");
              if (liveConnection) {
                await liveConnection.disconnect().catch(() => undefined);
                liveConnection = undefined;
              }
              await connectConversation(ctx, cid, false);
            },
          },
          runtime.getLastCheckpoint(),
        );
      })) ?? {};
    if (result.error) {
      if (liveConnection) {
        await liveConnection.disconnect().catch(() => undefined);
        liveConnection = undefined;
      }
      if (runtime) await runtime.disconnect().catch(() => undefined);
      runtime = undefined;
      updateStatus(ctx, result.error);
      if (interactive) await showNotice(ctx, "Connect error", result.error, "error");
      return false;
    }
    persistChatState(conversation.conversationId);
    if (interactive) ctx.ui.notify(`Connected ${conversation.conversationName}`, "info");
    await showChatContextMessage();
    updateStatus(ctx);
    await tryDispatch(ctx);
    return true;
  }

  registerChatInboxTools(pi, {
    isChatTurnInFlight: () => chatTurnInFlight,
    getRuntime: () => runtime,
    queueOutboundAttachment: (path) => {
      queuedOutboundAttachments.push(path);
    },
  });

  async function showChatContextMessage(): Promise<void> {
    const content = await buildChatContextMessage(runtime);
    if (!content) return;
    pi.sendMessage({
      customType: "chat-context",
      content,
      display: true,
    });
  }

  function updateStatus(ctx: ExtensionContext, error?: string): void {
    const theme = ctx.ui.theme;
    const label = theme.fg("accent", "chat");
    if (error) {
      ctx.ui.setStatus("chat", `${label} ${theme.fg("error", error)}`);
      return;
    }
    if (!runtime) {
      const state = evictionNotice ?? "disconnected";
      ctx.ui.setStatus(
        "chat",
        `${label} ${evictionNotice ? theme.fg("error", state) : theme.fg("muted", state)}`,
      );
      return;
    }
    const status = runtime.getStatus();
    const details = [status.conversationName];
    if (status.hasActiveJob) details.push("active");
    if (status.queueLength > 0) details.push(`q:${status.queueLength}`);
    ctx.ui.setStatus("chat", `${label} ${theme.fg("success", details.join(" | "))}`);
  }

  function startTypingLoop(): void {
    if (!liveConnection || typingInterval) return;
    void liveConnection.startTyping();
    typingInterval = setInterval(() => {
      void liveConnection?.startTyping();
    }, 4000);
  }

  function stopTypingLoop(): void {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = undefined;
    }
    void liveConnection?.stopTyping();
  }

  async function tryDispatch(ctx: ExtensionContext): Promise<void> {
    if (!runtime || chatTurnInFlight || !ctx.isIdle()) return;
    const next = runtime.beginNextJob();
    if (!next) {
      updateStatus(ctx);
      return;
    }
    try {
      chatTurnInFlight = true;
      lastAgentSummary = undefined;
      activeTriggerMessageId = next.triggerMessageId;
      queuedOutboundAttachments = [];
      pendingChatDispatch = true;
      liveConnection?.setReplyTo(activeTriggerMessageId);
      startTypingLoop();
      pi.sendUserMessage(next.prompt);
      updateStatus(ctx);
    } catch (error) {
      pendingChatDispatch = false;
      chatTurnInFlight = false;
      stopTypingLoop();
      const message = error instanceof Error ? error.message : String(error);
      await runtime.failActiveJob(`dispatch failed: ${message}`);
      updateStatus(ctx, message);
    }
  }

  async function disconnectRuntime(
    ctx: ExtensionContext,
    clearPersistedState = true,
  ): Promise<void> {
    stopTypingLoop();
    if (clearPersistedState) evictionNotice = undefined;
    const connection = liveConnection;
    liveConnection = undefined;
    if (connection) await connection.disconnect().catch(() => undefined);
    if (!runtime) {
      updateStatus(ctx);
      return;
    }
    const current = runtime;
    runtime = undefined;
    chatTurnInFlight = false;
    await current.disconnect();
    if (clearPersistedState) persistChatState(undefined);
    updateStatus(ctx);
  }

  async function handleEviction(ctx: ExtensionContext, reason: string): Promise<void> {
    if (evictionNotice) return;
    evictionNotice = reason;
    if (chatTurnInFlight) ctx.abort();
    await liveConnection?.clearPreview().catch(() => undefined);
    await disconnectRuntime(ctx, false);
    updateStatus(ctx);
    ctx.ui.notify(`pi-chat disconnected: ${reason}`, "warning");
  }

  pi.on("tool_call", async (event) => {
    if (!chatTurnInFlight) return;
    if (["read", "write", "edit", "bash", "chat_attach", "chat_history"].includes(event.toolName))
      return;
    return {
      block: true,
      reason:
        "pi-chat remote turns only allow read, write, edit, bash, chat_history, and chat_attach",
    };
  });

  registerChatSlashCommands(pi, {
    loadConfigOnce,
    getRuntime: () => runtime,
    connectConversation,
    disconnectRuntime,
  });

  pi.on("session_start", async (_event, ctx) => {
    await loadConfigOnce();
    ownerId = `pi-chat-${process.pid}-${randomUUID()}`;
    registerWorkspaceDelegatedTools(pi, ctx);
    pi.setActiveTools(["read", "write", "edit", "bash", "chat_history", "chat_attach"]);
    updateStatus(ctx);
    const persistedConversationId = getPersistedConversationId(ctx);
    const config = await loadChatConfig();
    const configuredConversationIds = listConfiguredConversations(config).map(
      (conversation) => conversation.conversationId,
    );
    const conversationId = selectStartupConversationId(
      pi.getFlag(CHAT_CONVERSATION_FLAG),
      persistedConversationId,
      configuredConversationIds,
    );
    if (conversationId) await connectConversation(ctx, conversationId, false);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const reason = (event as { reason?: string }).reason;
    await disconnectRuntime(ctx, reason === "quit");
  });

  pi.on("agent_start", async (_event, _ctx) => {});

  pi.on("context", async (event) => {
    if (liveConnection && !chatTurnInFlight && pendingLocalPrompt === undefined) {
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const msg = event.messages[i] as unknown as Record<string, unknown>;
        if (msg.role !== "user") continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        const text = (content as Array<Record<string, unknown>>)
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("")
          .trim();
        if (text) pendingLocalPrompt = text;
        break;
      }
    }
    return {
      messages: event.messages.filter((message) => {
        const value = message as unknown as Record<string, unknown>;
        return !(value && value.customType === "chat-context");
      }),
    };
  });

  pi.on("before_agent_start", async (event) => {
    if (!pendingChatDispatch) return undefined;
    pendingChatDispatch = false;
    const channelName =
      runtime?.conversation.channel.name ?? runtime?.conversation.channelKey ?? "chat";
    const mode = "dm";
    const service = runtime?.conversation.service ?? "chat";
    const [memorySuffix, skillsSuffix, systemMdSuffix] = await Promise.all([
      buildMemoryPromptSuffix(runtime),
      buildSkillsPromptSuffix(runtime),
      buildSystemMdSuffix(runtime),
    ]);
    return {
      systemPrompt:
        event.systemPrompt +
        buildChatSystemPromptSuffix(service, mode, channelName) +
        memorySuffix +
        skillsSuffix +
        systemMdSuffix,
    };
  });

  pi.on("agent_end", async (event) => {
    lastAgentSummary = extractAssistantSummary(event.messages as unknown[]);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const summary = lastAgentSummary ?? {};
    lastAgentSummary = undefined;
    if (!runtime || !chatTurnInFlight) {
      stopTypingLoop();
      updateStatus(ctx);
      if (pendingLocalPrompt !== undefined && liveConnection) {
        const localPrompt = pendingLocalPrompt;
        pendingLocalPrompt = undefined;
        if (summary.text) {
          const combined = `${localPrompt}\n\n${summary.text}`;
          try {
            await liveConnection.send(combined, [], ctx.signal, undefined);
          } catch {
            // ignore send failure
          }
        }
      } else {
        pendingLocalPrompt = undefined;
      }
      return;
    }
    pendingLocalPrompt = undefined;
    if (summary.stopReason === "aborted") {
      stopTypingLoop();
      chatTurnInFlight = false;
      await runtime.failActiveJob("aborted");
      const action = pendingControlAction;
      pendingControlAction = undefined;
      if (action) {
        await action();
        updateStatus(ctx);
        return;
      }
      updateStatus(ctx);
      await tryDispatch(ctx);
      return;
    }
    if (summary.stopReason === "error" || summary.stopReason === "length") {
      stopTypingLoop();
      chatTurnInFlight = false;
      const errorMessage = summary.errorMessage || `agent ${summary.stopReason}`;
      await runtime.failActiveJob(errorMessage);
      if (liveConnection) {
        try {
          await liveConnection.sendImmediate(`pi-chat error: ${errorMessage}`);
        } catch {
          // ignore secondary send failure
        }
      }
      ctx.ui.notify(errorMessage, "error");
      updateStatus(ctx, errorMessage);
      await tryDispatch(ctx);
      return;
    }
    stopTypingLoop();
    let remoteMessageId: string | undefined;
    const attachmentPaths = [...queuedOutboundAttachments];
    queuedOutboundAttachments = [];
    const finalText =
      summary.text || (attachmentPaths.length > 0 ? "Attached requested file(s)." : "");
    if (liveConnection && finalText) {
      try {
        remoteMessageId = await Promise.race([
          liveConnection.send(finalText, attachmentPaths, ctx.signal, activeTriggerMessageId),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error("send timed out")), 120000),
          ),
          waitForAbort(ctx.signal),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        chatTurnInFlight = false;
        if (error instanceof Error && error.name === "AbortError") {
          await runtime.failActiveJob("aborted");
          updateStatus(ctx);
          await tryDispatch(ctx);
          return;
        }
        await runtime.failActiveJob(`send failed: ${message}`);
        updateStatus(ctx, message);
        await tryDispatch(ctx);
        return;
      }
    }
    chatTurnInFlight = false;
    await runtime.completeActiveJob(finalText, remoteMessageId, attachmentPaths);
    updateStatus(ctx);
    await tryDispatch(ctx);
  });
}
