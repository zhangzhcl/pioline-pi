// ABOUTME: Pure formatting, transcript cleanup, DOM action controls, and copy
// handlers shared by the chat MessageRenderer.

import { t } from "../i18n.js";
import { createIcon } from "../icons.js";

export const COPY_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
export const CHEVRON_ICON =
  '<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true"><path d="M2 1l4 3-4 3z"/></svg>';
export const BRAIN_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px" aria-hidden="true"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg>';

export const USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD = 400;
export const USER_MESSAGE_COLLAPSE_NEWLINE_THRESHOLD = 8;

const HTML_ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtmlText(text) {
  return String(text ?? "").replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

export function cleanChatTranscript(text) {
  if (!text || typeof text !== "string") return null;
  const lineRe = /^- (?:\[[\dT:.Z+-]+\] )?\[uid:[^\]]+\] ([^:]+): (.*)$/;
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return null;
  const parsed = lines.map((line) => {
    const match = line.match(lineRe);
    return match ? { name: match[1].trim(), text: match[2] } : null;
  });
  if (parsed.some((line) => line === null)) return null;
  const names = [...new Set(parsed.map((line) => line.name))];
  if (names.length === 1) {
    return parsed.map((line) => line.text).join("\n");
  }
  return parsed.map((line) => `**${line.name}**: ${line.text}`).join("\n\n");
}

export function resolveMessageEntryId(message, override = null) {
  const id = override ?? message?.entryId ?? message?.entry_id ?? null;
  return typeof id === "string" && id ? id : null;
}

export function shouldCollapseUserMessage(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (text.length >= USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD) return true;
  let newlines = 0;
  let idx = text.indexOf("\n");
  while (idx !== -1) {
    newlines += 1;
    if (newlines >= USER_MESSAGE_COLLAPSE_NEWLINE_THRESHOLD) return true;
    idx = text.indexOf("\n", idx + 1);
  }
  return false;
}

export function formatMessageTime(timestampMs) {
  if (timestampMs == null) return "";
  const ms = Number(timestampMs);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const pad = (n) => String(n).padStart(2, "0");
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameDay) return hhmm;
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${hhmm}`;
}

export function formatDurationLabel(durationMs) {
  if (durationMs == null) return "";
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function fullTimestampTitle(timestampMs) {
  const ms = Number(timestampMs);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function splitStreamingMessageContent(content) {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  let text = "";
  let thinking = "";
  for (const block of content) {
    if (block?.type === "text") text += block.text ?? "";
    else if (block?.type === "thinking") thinking += block.thinking ?? "";
  }
  return { text, thinking };
}

export function collectMessageImageItems(message) {
  const imageItems = [];
  if (message.images?.length > 0) imageItems.push(...message.images);
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block?.type === "image" && block.data) imageItems.push(block);
    }
  }
  if (message.attachments?.length > 0) {
    for (const attachment of message.attachments) {
      if (attachment.type === "image" && attachment.content) {
        imageItems.push({ data: attachment.content, mimeType: attachment.mimeType });
      }
    }
  }
  return imageItems;
}

export function extractTextFromMessageContent(content) {
  if (!Array.isArray(content)) return content;
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function resolveImageDataUrl(image) {
  const data = typeof image?.data === "string" ? image.data : "";
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(data)) return data;
  const mime = /^image\/(?:png|jpe?g|gif|webp)$/i.test(image?.mimeType || "")
    ? image.mimeType
    : "image/png";
  return `data:${mime};base64,${data}`;
}

export function createUserActionButton(kind, actionText) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `message-action message-${kind}-btn`;
  button.setAttribute(
    "aria-label",
    t(kind === "fork" ? "messages.forkSession" : "messages.editMessage"),
  );
  button.title = t(kind === "fork" ? "messages.forkSession" : "messages.editMessage");
  const icon = createIcon(kind === "fork" ? "git-branch" : "pencil", { size: 12 });
  if (icon) button.appendChild(icon);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const entryId = button.closest("[data-entry-id]")?.dataset.entryId || null;
    button.dispatchEvent(
      new CustomEvent(kind === "fork" ? "messagefork" : "messageedit", {
        bubbles: true,
        detail: { entryId, text: actionText },
      }),
    );
  });
  return button;
}

export function createMessageTimeSpan(timestampMs) {
  const label = formatMessageTime(timestampMs);
  if (!label) return null;
  const span = document.createElement("span");
  span.className = "message-time";
  span.textContent = label;
  const title = fullTimestampTitle(timestampMs);
  if (title) span.title = title;
  return span;
}

export function createMessageDurationSpan(durationMs) {
  const label = formatDurationLabel(durationMs);
  if (!label) return null;
  const span = document.createElement("span");
  span.className = "message-duration";
  span.textContent = label;
  span.title = t("messages.responseTime");
  return span;
}

export function createUserCollapseToggleButton(contentEl, rawContent) {
  if (!shouldCollapseUserMessage(rawContent)) return null;
  contentEl.classList.add("user-message-collapsible");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-user-collapse-toggle";
  button.textContent = t("messages.expand");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => {
    const expanded = contentEl.classList.toggle("expanded");
    button.setAttribute("aria-expanded", String(expanded));
    button.textContent = t(expanded ? "messages.collapse" : "messages.expand");
  });
  return button;
}

export function buildWelcomeElement({ workspacePath, appendMarkup }) {
  const welcome = document.createElement("div");
  welcome.className = "welcome";

  const icon = document.createElement("div");
  icon.className = "welcome-icon";
  const logo = document.createElement("img");
  logo.src = "icons/logo-dark.svg";
  logo.alt = "Pipline logo";
  logo.className = "tau-icon-welcome";
  icon.appendChild(logo);
  welcome.appendChild(icon);

  const titleEl = document.createElement("p");
  titleEl.textContent = t("app.welcome");
  welcome.appendChild(titleEl);

  const hintEl = document.createElement("p");
  hintEl.className = "hint";
  hintEl.textContent = t("app.welcomeHint");
  welcome.appendChild(hintEl);

  if (workspacePath) {
    const workspace = document.createElement("p");
    workspace.className = "hint welcome-workspace";
    workspace.appendChild(document.createTextNode(`${t("app.currentWorkspace")} `));
    const code = document.createElement("code");
    code.textContent = workspacePath;
    workspace.appendChild(code);
    welcome.appendChild(workspace);
  }

  const shortcuts = document.createElement("div");
  shortcuts.className = "shortcuts-hint";
  shortcuts.setAttribute("aria-label", t("migrated.index.ariaLabel.keyboardShortcuts"));
  const focusShortcut = document.createElement("span");
  appendMarkup(focusShortcut, `<kbd>/</kbd> ${escapeHtmlText(t("shortcuts.focusInput"))}`);
  const abortShortcut = document.createElement("span");
  appendMarkup(abortShortcut, `<kbd>Esc</kbd> ${escapeHtmlText(t("shortcuts.abort"))}`);
  shortcuts.append(focusShortcut, abortShortcut);
  welcome.appendChild(shortcuts);
  return welcome;
}

export function writeClipboardText(value) {
  if (navigator.clipboard) return navigator.clipboard.writeText(value);
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.cssText = "position:fixed;left:-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
  return Promise.resolve();
}

export function extractCopyableMessageText(messageEl) {
  const content = messageEl?.querySelector(".message-content");
  if (!content) return "";
  if (!content.querySelector(".thinking-block, .streaming-thinking")) {
    return (content.textContent || "").trim();
  }
  const clone = content.cloneNode(true);
  clone.querySelectorAll(".thinking-block, .streaming-thinking").forEach((el) => {
    el.remove();
  });
  return (clone.textContent || "").trim();
}

export function setupCodeBlockCopyButtons(root) {
  root.querySelectorAll(".copy-btn").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.addEventListener("click", () => {
      const code = button.closest(".code-block-wrapper")?.querySelector("code");
      if (!code) return;
      writeClipboardText(code.textContent || "").then(() => {
        button.textContent = t("messages.copied");
        button.classList.add("copied");
        setTimeout(() => {
          button.textContent = t("messages.copy");
          button.classList.remove("copied");
        }, 2000);
      });
    });
    button.dataset.bound = "true";
  });
}

export function setupThinkingBlockToggles(root) {
  root.querySelectorAll(".thinking-label-text").forEach((label) => {
    label.textContent = t("messages.thinking");
  });
  root.querySelectorAll("[data-thinking-toggle]").forEach((toggle) => {
    if (toggle.dataset.bound === "true") return;
    const toggleThinking = () => {
      const block = toggle.closest(".thinking-block");
      const content = block?.querySelector(".thinking-content");
      content?.classList.toggle("expanded");
      toggle.classList.toggle("expanded");
    };
    toggle.addEventListener("click", toggleThinking);
    toggle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleThinking();
      }
    });
    toggle.dataset.bound = "true";
  });
}
