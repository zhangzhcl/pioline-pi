// ABOUTME: Telegram Bot API client, command menu sync, and inbound message/attachment conversion.

import type { ResolvedConversation, TelegramAccountConfig } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";
import { fetchBinary, storeDownloadedAttachment } from "./common.js";

export interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}
export interface TelegramUser {
  id: number;
  username?: string;
  is_bot?: boolean;
  first_name?: string;
}
export interface TelegramChat {
  id: number;
  type: string;
}
export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
}
export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}
export interface TelegramVideo {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}
export interface TelegramAudio {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}
export interface TelegramMessage {
  message_id: number;
  media_group_id?: string;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  audio?: TelegramAudio;
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}
export interface TelegramGetFileResult {
  file_path: string;
}

export async function callTelegram<T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  const data = (await response.json()) as TelegramResponse<T>;
  if (!response.ok || !data.ok || data.result === undefined) {
    const error = new Error(
      data.description || `Telegram API ${method} failed`,
    ) as TelegramApiError;
    error.telegramErrorCode = data.error_code ?? response.status;
    throw error;
  }
  return data.result;
}

interface TelegramApiError extends Error {
  telegramErrorCode?: number;
}

/**
 * Telegram allows exactly one `getUpdates` consumer per bot token and answers
 * a second one by terminating the first with 409. So a conflict is not a
 * network blip: it means another poller exists, and the only safe reaction is
 * to check who owns the channel now.
 */
export function isGetUpdatesConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as TelegramApiError).telegramErrorCode === 409) return true;
  return /\bconflict\b|terminated by other getupdates/i.test(error.message);
}

const TELEGRAM_COMMANDS = [
  { command: "new", description: "Start a new pi session" },
  { command: "stop", description: "Abort the current turn" },
  { command: "status", description: "Show current session status" },
  { command: "tasks", description: "List recent Agent Index tasks" },
  { command: "agents", description: "List Agent Index target agents" },
  { command: "task", description: "Show a task: /task <id>" },
  { command: "compact", description: "Compact the current session" },
  { command: "models", description: "List available models" },
  { command: "health", description: "Show Pipline operations health" },
  { command: "errors", description: "Show recent operations errors" },
  { command: "help", description: "Show all Pipline commands" },
] as const;

export async function syncTelegramCommandMenu(botToken: string): Promise<void> {
  await callTelegram<boolean>(botToken, "setMyCommands", { commands: TELEGRAM_COMMANDS });
}

export async function downloadTelegramFile(
  conversation: ResolvedConversation,
  botToken: string,
  messageId: string,
  index: number,
  fileId: string,
  fileName: string,
  mimeType?: string,
) {
  const info = await callTelegram<TelegramGetFileResult>(botToken, "getFile", { file_id: fileId });
  const data = await fetchBinary(`https://api.telegram.org/file/bot${botToken}/${info.file_path}`);
  return [
    await storeDownloadedAttachment(
      conversation,
      messageId,
      index,
      fileName,
      data,
      mimeType,
      info.file_path,
    ),
  ];
}

export async function messageToInput(
  conversation: ResolvedConversation,
  account: TelegramAccountConfig,
  message: TelegramMessage,
) {
  if (String(message.chat.id) !== conversation.channel.id) return undefined;
  if (account.botUserId && String(message.from?.id ?? "") === account.botUserId) return undefined;
  const text = (message.text || message.caption || "").trim();
  const attachments: NonNullable<InboundMessageInput["attachments"]> = [];
  const remoteMessageId = String(message.message_id);
  if (message.photo?.length) {
    const largest = [...message.photo]
      .sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0))
      .pop();
    if (largest)
      attachments.push(
        ...(await downloadTelegramFile(
          conversation,
          account.botToken,
          remoteMessageId,
          1,
          largest.file_id,
          `photo-${remoteMessageId}.jpg`,
          "image/jpeg",
        )),
      );
  }
  if (message.document)
    attachments.push(
      ...(await downloadTelegramFile(
        conversation,
        account.botToken,
        remoteMessageId,
        2,
        message.document.file_id,
        message.document.file_name || `document-${remoteMessageId}`,
        message.document.mime_type,
      )),
    );
  if (message.video)
    attachments.push(
      ...(await downloadTelegramFile(
        conversation,
        account.botToken,
        remoteMessageId,
        3,
        message.video.file_id,
        message.video.file_name || `video-${remoteMessageId}.mp4`,
        message.video.mime_type,
      )),
    );
  if (message.audio)
    attachments.push(
      ...(await downloadTelegramFile(
        conversation,
        account.botToken,
        remoteMessageId,
        4,
        message.audio.file_id,
        message.audio.file_name || `audio-${remoteMessageId}.mp3`,
        message.audio.mime_type,
      )),
    );
  return {
    messageId: remoteMessageId,
    userId: String(message.from?.id ?? message.chat.id),
    userName: message.from?.username || message.from?.first_name,
    text,
    isBot: message.from?.is_bot ?? false,
    attachments,
  };
}
