// ABOUTME: Remote message control command dispatcher and /chat-* slash commands for chat-inbox.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHAT_CONFIG_PATH, listConfiguredConversations, loadChatConfig } from "./config.js";
import type { LiveConnection } from "./live/types.js";
import {
  buildOperationsSnapshot,
  buildRemoteHelp,
  buildRemoteStatus,
  SESSION_STATE_CUSTOM_TYPE,
} from "./prompt-context.js";
import {
  formatRemoteModels,
  formatRemoteOperationsCommand,
  type RemoteCommandResponse,
} from "./remote-operations.js";
import type { ConversationRuntime } from "./runtime.js";
import { runChatConfigUI } from "./tui/chat-config.js";
import { selectItem } from "./tui/dialogs.js";
import type { InboundEvent } from "./types.js";

export interface RemoteCommandDeps {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  getRuntime: () => ConversationRuntime | undefined;
  getLiveConnection: () => LiveConnection | undefined;
  isChatTurnInFlight: () => boolean;
  setPendingControlAction: (action: () => Promise<void>) => void;
}

async function sendRemoteResponse(
  liveConnection: LiveConnection | undefined,
  response: RemoteCommandResponse,
): Promise<void> {
  for (const chunk of response.chunks) await liveConnection?.sendImmediate(chunk);
}

export async function handleRemoteInboundCommand(
  input: InboundEvent,
  deps: RemoteCommandDeps,
): Promise<boolean> {
  const runtime = deps.getRuntime();
  if (!runtime) return true;
  const liveConnection = deps.getLiveConnection();
  const { pi, ctx } = deps;
  const remoteCommand = runtime.isArmed() ? runtime.parseRemoteCommand(input) : undefined;
  const control =
    (remoteCommand?.name === "start" ? "help" : remoteCommand?.name) ??
    (runtime.isArmed() ? runtime.parseControlCommand(input) : undefined);

  if (control === "stop") {
    if (deps.isChatTurnInFlight() || !ctx.isIdle()) {
      ctx.abort();
      await liveConnection?.sendImmediate("Aborted current turn.");
    } else {
      await liveConnection?.sendImmediate("No active turn.");
    }
    return true;
  }
  if (control === "compact") {
    const runCompact = async () => {
      ctx.compact({
        onComplete: () => void deps.getLiveConnection()?.sendImmediate("Compaction completed."),
        onError: (error) =>
          void deps.getLiveConnection()?.sendImmediate(`Compaction failed: ${error.message}`),
      });
      await deps.getLiveConnection()?.sendImmediate("Compaction started.");
    };
    if (deps.isChatTurnInFlight() || !ctx.isIdle()) {
      deps.setPendingControlAction(runCompact);
      ctx.abort();
      await liveConnection?.sendImmediate("Aborting current turn, then compacting.");
      return true;
    }
    await runCompact();
    return true;
  }
  if (control === "status") {
    await liveConnection?.sendImmediate(buildRemoteStatus(pi, ctx, runtime));
    return true;
  }
  if (control === "help") {
    await liveConnection?.sendImmediate(buildRemoteHelp());
    return true;
  }
  if (
    control === "agents" ||
    control === "tasks" ||
    control === "task" ||
    control === "health" ||
    control === "errors"
  ) {
    const snapshot = await buildOperationsSnapshot();
    await sendRemoteResponse(
      liveConnection,
      formatRemoteOperationsCommand({ name: control, args: remoteCommand?.args ?? "" }, snapshot),
    );
    return true;
  }
  if (control === "models") {
    try {
      const models = await ctx.modelRegistry.getAvailable();
      await sendRemoteResponse(liveConnection, formatRemoteModels(models, ctx.model));
    } catch (error) {
      await liveConnection?.sendImmediate(
        `Unable to list models: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return true;
  }
  if (control === "new") {
    const queueNewSession = async () => {
      pi.sendUserMessage("/chat-new", { deliverAs: "followUp" });
      await deps.getLiveConnection()?.sendImmediate("Starting a new pi session.");
    };
    if (deps.isChatTurnInFlight() || !ctx.isIdle()) {
      deps.setPendingControlAction(queueNewSession);
      ctx.abort();
      await liveConnection?.sendImmediate("Aborting current turn, then starting a new pi session.");
      return true;
    }
    await queueNewSession();
    return true;
  }
  if (remoteCommand) {
    await liveConnection?.sendImmediate(
      `Unknown command: /${remoteCommand.name}\n\n${buildRemoteHelp()}`,
    );
    return true;
  }
  return false;
}

export interface ChatSlashCommandsDeps {
  loadConfigOnce: () => Promise<void>;
  getRuntime: () => ConversationRuntime | undefined;
  connectConversation: (
    ctx: ExtensionContext,
    conversationId: string,
    interactive?: boolean,
  ) => Promise<boolean>;
  disconnectRuntime: (ctx: ExtensionContext, clearPersistedState?: boolean) => Promise<void>;
}

export function registerChatSlashCommands(pi: ExtensionAPI, deps: ChatSlashCommandsDeps): void {
  pi.registerCommand("chat-config", {
    description: "Configure pi-chat Telegram DM accounts",
    handler: async (_args, ctx) => {
      await deps.loadConfigOnce();
      await runChatConfigUI(ctx);
    },
  });

  pi.registerCommand("chat-list", {
    description: "List configured channels",
    handler: async (_args, ctx) => {
      await deps.loadConfigOnce();
      const config = await loadChatConfig();
      const configured = listConfiguredConversations(config);
      if (configured.length === 0) {
        ctx.ui.notify(`No configured channels. Run /chat-config. (${CHAT_CONFIG_PATH})`, "warning");
        return;
      }
      ctx.ui.notify(configured.map((item) => item.conversationName).join("\n"), "info");
    },
  });

  pi.registerCommand("chat-connect", {
    description: "Connect this pi session to account/channel",
    handler: async (args, ctx) => {
      await deps.loadConfigOnce();
      const config = await loadChatConfig();
      let spec = args.trim();
      if (!spec) {
        const configured = listConfiguredConversations(config);
        if (configured.length === 0) {
          ctx.ui.notify(
            `No configured channels. Run /chat-config. (${CHAT_CONFIG_PATH})`,
            "warning",
          );
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /chat-connect <account/channel>", "warning");
          return;
        }
        const items = configured.map((item) => ({
          value: item.conversationId,
          label: item.conversationName,
          description: item.conversationId,
        }));
        spec = (await selectItem(ctx, "Connect pi-chat channel", items)) || "";
        if (!spec) return;
      }
      await deps.connectConversation(ctx, spec, true);
    },
  });

  pi.registerCommand("chat-new", {
    description: "Start a new pi session and keep the current pi-chat connection",
    handler: async (_args, ctx) => {
      const conversationId = deps.getRuntime()?.conversation.conversationId;
      const result = await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (sm) => {
          if (conversationId) sm.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, { conversationId });
        },
      });
      if (!result.cancelled) return;
    },
  });

  pi.registerCommand("chat-disconnect", {
    description: "Disconnect the current pi-chat channel",
    handler: async (_args, ctx) => {
      await deps.disconnectRuntime(ctx);
    },
  });

  pi.registerCommand("chat-status", {
    description: "Show pi-chat connection status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(buildRemoteStatus(pi, ctx, deps.getRuntime()), "info");
    },
  });
}
