import type { ResolvedConversation, TelegramAccountConfig } from "../core/config-types.js";
import { chunkText } from "../render/chunking.js";
import { formatMarkdownForService, maxMessageLength } from "../render/format.js";
import { StreamingPreview } from "../render/streaming.js";
import { guessAttachmentKind, readLocalAttachment } from "./common.js";
import {
  callTelegram,
  isGetUpdatesConflict,
  messageToInput,
  syncTelegramCommandMenu,
  type TelegramMessage,
  type TelegramResponse,
  type TelegramUpdate,
} from "./telegram-api.js";
import type { LiveConnection, LiveConnectionHandlers, ResumeState } from "./types.js";

export { syncTelegramCommandMenu };

export async function connectTelegramLive(
  conversation: ResolvedConversation,
  handlers: LiveConnectionHandlers,
  resumeState?: ResumeState,
): Promise<LiveConnection> {
  const account = conversation.account as TelegramAccountConfig;
  try {
    await syncTelegramCommandMenu(account.botToken);
  } catch (error) {
    await handlers.onError(
      new Error(
        `Telegram command menu sync failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  let abort = false;
  let offset = resumeState?.cursor ? Number(resumeState.cursor) + 1 : 0;
  const pollController = new AbortController();
  const preview = new StreamingPreview(conversation.service, {
    create: async (text, parseMode, replyToMessageId) =>
      String(
        (
          await callTelegram<{ message_id: number }>(account.botToken, "sendMessage", {
            chat_id: Number(conversation.channel.id),
            text,
            parse_mode: parseMode,
            reply_to_message_id: replyToMessageId ? Number(replyToMessageId) : undefined,
          })
        ).message_id,
      ),
    edit: async (id, text, parseMode) => {
      try {
        await callTelegram(account.botToken, "editMessageText", {
          chat_id: Number(conversation.channel.id),
          message_id: Number(id),
          text,
          parse_mode: parseMode,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("message is not modified")) throw error;
      }
    },
    delete: async (id) => {
      await callTelegram(account.botToken, "deleteMessage", {
        chat_id: Number(conversation.channel.id),
        message_id: Number(id),
      });
    },
  });
  const mediaGroups = new Map<
    string,
    { updates: TelegramUpdate[]; timer?: ReturnType<typeof setTimeout> }
  >();
  const mergeMediaGroup = (updates: TelegramUpdate[]): TelegramMessage | undefined => {
    const messages = updates
      .map((update) => update.message || update.edited_message)
      .filter(Boolean) as TelegramMessage[];
    if (messages.length === 0) return undefined;
    const merged = { ...messages[0] } as TelegramMessage;
    for (const message of messages.slice(1)) {
      if (!merged.text && message.text) merged.text = message.text;
      if (!merged.caption && message.caption) merged.caption = message.caption;
      if (message.photo?.length) merged.photo = [...(merged.photo ?? []), ...message.photo];
      if (!merged.document && message.document) merged.document = message.document;
      if (!merged.video && message.video) merged.video = message.video;
      if (!merged.audio && message.audio) merged.audio = message.audio;
    }
    return merged;
  };
  const flushMediaGroup = async (key: string): Promise<void> => {
    const state = mediaGroups.get(key);
    mediaGroups.delete(key);
    if (!state) return;
    const merged = mergeMediaGroup(state.updates);
    if (!merged) return;
    const input = await messageToInput(conversation, account, merged);
    if (!input) return;
    const lastUpdateId = state.updates.at(-1)?.update_id;
    await handlers.onMessage(input, {
      cursor: lastUpdateId !== undefined ? String(lastUpdateId) : undefined,
      messageId: input.messageId,
    });
  };
  const processInitialUpdates = async (updates: TelegramUpdate[]): Promise<void> => {
    const grouped = new Map<string, TelegramUpdate[]>();
    for (const update of updates) {
      offset = update.update_id + 1;
      const message = update.message || update.edited_message;
      if (!message) continue;
      if (!message.media_group_id) {
        const input = await messageToInput(conversation, account, message);
        if (input)
          await handlers.onMessage(input, {
            cursor: String(update.update_id),
            messageId: input.messageId,
          });
        continue;
      }
      const key = `${message.chat.id}:${message.media_group_id}`;
      grouped.set(key, [...(grouped.get(key) ?? []), update]);
    }
    for (const updates of grouped.values()) {
      const merged = mergeMediaGroup(updates);
      if (!merged) continue;
      const input = await messageToInput(conversation, account, merged);
      if (!input) continue;
      await handlers.onMessage(input, {
        cursor: String(updates.at(-1)?.update_id ?? 0),
        messageId: input.messageId,
      });
    }
  };
  const initialUpdates = await callTelegram<TelegramUpdate[]>(account.botToken, "getUpdates", {
    offset: offset > 0 ? offset : undefined,
    timeout: 0,
    allowed_updates: ["message", "edited_message"],
  });
  await processInitialUpdates(initialUpdates);
  await handlers.onCaughtUp();
  const evictIfReplaced = async (reason: string): Promise<boolean> => {
    if (!handlers.isStillOwner || (await handlers.isStillOwner())) return false;
    abort = true;
    pollController.abort();
    if (handlers.onEvicted) {
      const notify = handlers.onEvicted.bind(handlers);
      queueMicrotask(() => void notify(reason));
    }
    return true;
  };
  const loop = (async () => {
    while (!abort) {
      if (await evictIfReplaced("channel taken over by another instance")) break;
      try {
        const updates = await callTelegram<TelegramUpdate[]>(
          account.botToken,
          "getUpdates",
          {
            offset: offset > 0 ? offset : undefined,
            timeout: 30,
            allowed_updates: ["message", "edited_message"],
          },
          { signal: pollController.signal },
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message || update.edited_message;
          if (!message) continue;
          if (message.media_group_id) {
            const key = `${message.chat.id}:${message.media_group_id}`;
            const existing = mediaGroups.get(key) ?? { updates: [] };
            existing.updates.push(update);
            if (existing.timer) clearTimeout(existing.timer);
            existing.timer = setTimeout(() => void flushMediaGroup(key), 1200);
            mediaGroups.set(key, existing);
            continue;
          }
          const input = await messageToInput(conversation, account, message);
          if (input)
            await handlers.onMessage(input, {
              cursor: String(update.update_id),
              messageId: input.messageId,
            });
        }
      } catch (error) {
        if (abort) break;
        if (error instanceof DOMException && error.name === "AbortError") break;
        if (isGetUpdatesConflict(error)) {
          if (await evictIfReplaced("another poller took over this bot token")) break;
        }
        await handlers.onError(error instanceof Error ? error : new Error(String(error)));
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  })();
  return {
    conversation,
    disconnect: async () => {
      abort = true;
      pollController.abort();
      for (const state of mediaGroups.values()) if (state.timer) clearTimeout(state.timer);
      await loop.catch(() => undefined);
    },
    sendImmediate: async (text, replyToMessageId) =>
      String(
        (
          await callTelegram<{ message_id: number }>(account.botToken, "sendMessage", {
            chat_id: Number(conversation.channel.id),
            text,
            reply_to_message_id: replyToMessageId ? Number(replyToMessageId) : undefined,
          })
        ).message_id,
      ),
    send: async (text, attachmentPaths = [], signal, replyToMessageId) => {
      const rendered = formatMarkdownForService("telegram", text);
      const replyParam = replyToMessageId ? { reply_to_message_id: Number(replyToMessageId) } : {};
      if (attachmentPaths.length === 0) {
        const chunks = chunkText(rendered.text, maxMessageLength("telegram"));
        let firstId: string | undefined;
        for (let i = 0; i < chunks.length; i++) {
          const id = String(
            (
              await callTelegram<{ message_id: number }>(
                account.botToken,
                "sendMessage",
                {
                  chat_id: Number(conversation.channel.id),
                  text: chunks[i],
                  parse_mode: rendered.parseMode,
                  ...(i === 0 ? replyParam : {}),
                },
                { signal },
              )
            ).message_id,
          );
          firstId ??= id;
        }
        return firstId || "";
      }
      const [firstPath, ...rest] = attachmentPaths;
      const first = await readLocalAttachment(firstPath);
      const firstKind = guessAttachmentKind(first.name, first.mimeType);
      const firstMethod = firstKind === "image" ? "sendPhoto" : "sendDocument";
      const firstField = firstKind === "image" ? "photo" : "document";
      const firstForm = new FormData();
      firstForm.set("chat_id", String(Number(conversation.channel.id)));
      if (replyToMessageId) firstForm.set("reply_to_message_id", String(Number(replyToMessageId)));
      if (text) firstForm.set("caption", text);
      if (text && firstKind === "image") firstForm.set("parse_mode", "HTML");
      firstForm.set(
        firstField,
        new Blob([Buffer.from(first.data)], { type: first.mimeType }),
        first.name,
      );
      const firstResponse = await fetch(
        `https://api.telegram.org/bot${account.botToken}/${firstMethod}`,
        {
          method: "POST",
          body: firstForm,
          signal,
        },
      );
      const firstData = (await firstResponse.json()) as TelegramResponse<{ message_id: number }>;
      if (!firstResponse.ok || !firstData.ok || firstData.result === undefined)
        throw new Error(firstData.description || `${firstMethod} failed`);
      for (const path of rest) {
        const file = await readLocalAttachment(path);
        const kind = guessAttachmentKind(file.name, file.mimeType);
        const method = kind === "image" ? "sendPhoto" : "sendDocument";
        const field = kind === "image" ? "photo" : "document";
        const form = new FormData();
        form.set("chat_id", String(Number(conversation.channel.id)));
        form.set(field, new Blob([Buffer.from(file.data)], { type: file.mimeType }), file.name);
        const response = await fetch(`https://api.telegram.org/bot${account.botToken}/${method}`, {
          method: "POST",
          body: form,
          signal,
        });
        const data = (await response.json()) as TelegramResponse<{ message_id: number }>;
        if (!response.ok || !data.ok || data.result === undefined)
          throw new Error(data.description || `${method} failed`);
      }
      return String(firstData.result.message_id);
    },
    startTyping: async () => {
      await callTelegram(account.botToken, "sendChatAction", {
        chat_id: Number(conversation.channel.id),
        action: "typing",
      });
    },
    stopTyping: async () => {},
    syncPreview: async (markdown, done = false) => preview.update(markdown, done),
    clearPreview: async () => preview.clear(),
    setReplyTo: (messageId) => preview.setReplyTo(messageId),
  };
}
