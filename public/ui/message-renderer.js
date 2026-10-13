// ABOUTME: Renders user and assistant chat messages for the Pipline WebView.
// ABOUTME: Preserves renderer behavior while exposing user elements for navigation.
/**
 * Message Renderer - Renders chat messages with markdown support
 */

import { onLocaleChange, t } from "../i18n.js";
import { initImageLightbox } from "./image-lightbox.js";
import { renderMarkdown, renderStreamingMarkdown, renderUserMarkdown } from "./markdown.js";
import {
  BRAIN_ICON,
  buildWelcomeElement,
  CHEVRON_ICON,
  COPY_ICON,
  cleanChatTranscript,
  collectMessageImageItems,
  createMessageDurationSpan,
  createMessageTimeSpan,
  createUserActionButton,
  createUserCollapseToggleButton,
  escapeHtmlText,
  extractCopyableMessageText,
  extractTextFromMessageContent,
  formatDurationLabel,
  formatMessageTime,
  fullTimestampTitle,
  resolveImageDataUrl,
  resolveMessageEntryId,
  setupCodeBlockCopyButtons,
  setupThinkingBlockToggles,
  shouldCollapseUserMessage,
  splitStreamingMessageContent,
  USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD,
  USER_MESSAGE_COLLAPSE_NEWLINE_THRESHOLD,
  writeClipboardText,
} from "./message-renderer-helpers.js";
import {
  clearMessageSearchHighlights,
  escapeSearchRegExp,
  highlightContainerSearchQuery,
  highlightTextNodeWithPattern,
} from "./message-renderer-search.js";
import { sanitizeMarkup } from "./sanitize-markup.js";

const AUTO_SCROLL_BOTTOM_TOLERANCE = 1;

export {
  formatDurationLabel,
  formatMessageTime,
  shouldCollapseUserMessage,
  USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD,
  USER_MESSAGE_COLLAPSE_NEWLINE_THRESHOLD,
};

export class MessageRenderer {
  constructor(container, { sessionTreeActions = false } = {}) {
    this.container = container;
    this.sessionTreeActions = sessionTreeActions;
    this.isNearBottom = true;
    this.lastWelcomeOptions = null;
    this._destroyed = false;

    initImageLightbox(this.container);

    this._scrollHandler = () => {
      this.isNearBottom =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight <=
        AUTO_SCROLL_BOTTOM_TOLERANCE;
    };
    this.container.addEventListener("scroll", this._scrollHandler);

    this.unsubscribeLocaleChange = onLocaleChange(() => {
      if (!this.container) return;
      this.container.querySelectorAll(".message-copy-btn").forEach((btn) => {
        btn.setAttribute("aria-label", t("messages.copyMessage"));
        btn.title = t("messages.copyMessage");
      });
      this.container.querySelectorAll(".message-user-collapse-toggle").forEach((btn) => {
        const expanded = btn.getAttribute("aria-expanded") === "true";
        btn.textContent = t(expanded ? "messages.collapse" : "messages.expand");
      });
      this.container.querySelectorAll(".thinking-label-text").forEach((el) => {
        el.textContent = t("messages.thinking");
      });
      if (this.container.querySelector(".welcome")) {
        this.renderWelcome(this.lastWelcomeOptions || {});
      }
    });
  }

  clear() {
    if (!this.container) return;
    this.container.replaceChildren();
    this._hasWelcome = false;
    this.isNearBottom = true;
  }

  clearSearchHighlights() {
    clearMessageSearchHighlights(this.container);
  }

  highlightSearchQuery(query, { scrollToFirst = true } = {}) {
    return highlightContainerSearchQuery(this.container, query, {
      scrollToFirst,
      highlightNode: (node, pattern, onMatch) => this.highlightTextNode(node, pattern, onMatch),
    });
  }

  renderWelcome({ workspacePath } = {}) {
    this.lastWelcomeOptions = { workspacePath };
    const welcome = buildWelcomeElement({
      workspacePath,
      appendMarkup: (parent, markup) => this._appendMarkup(parent, markup),
    });
    this.container.replaceChildren(welcome);
    this._hasWelcome = true;
  }

  _clearWelcomeIfPresent() {
    if (!this._hasWelcome && !this.container?.firstElementChild?.classList?.contains("welcome")) {
      return;
    }
    this._hasWelcome = false;
    const welcome = this.container?.querySelector(".welcome");
    if (welcome) welcome.remove();
  }

  renderUserMessage(message, isHistory = false, { entryId = null } = {}) {
    this._clearWelcomeIfPresent();

    const div = document.createElement("div");
    div.className = `message user${isHistory ? " history" : ""}`;

    const imageItems = collectMessageImageItems(message);
    const content = document.createElement("div");
    content.className = "message-content";
    if (imageItems.length > 0) {
      const images = document.createElement("div");
      images.className = "message-images";
      for (const image of imageItems) {
        const imageElement = document.createElement("img");
        imageElement.className = "message-image";
        imageElement.src = resolveImageDataUrl(image);
        imageElement.alt = t("messages.attachedImage");
        images.appendChild(imageElement);
      }
      content.appendChild(images);
    }

    const rawContent = extractTextFromMessageContent(message.content);
    const displayContent = cleanChatTranscript(rawContent) ?? rawContent;
    this._appendMarkup(content, renderUserMarkdown(displayContent));
    div.appendChild(content);

    const collapseToggle = createUserCollapseToggleButton(content, displayContent);
    const footer = document.createElement("div");
    footer.className = "message-footer";
    if (collapseToggle) footer.appendChild(collapseToggle);
    if (this.sessionTreeActions) {
      const actionText = typeof message.content === "string" ? message.content : "";
      footer.appendChild(createUserActionButton("fork", actionText));
      footer.appendChild(createUserActionButton("edit", actionText));
    }
    footer.appendChild(this._createCopyButton());
    const timeSpan = createMessageTimeSpan(message.timestamp);
    if (timeSpan) footer.appendChild(timeSpan);
    const forkEntryId = resolveMessageEntryId(message, entryId);
    if (forkEntryId) {
      div.dataset.entryId = forkEntryId;
    }
    div.appendChild(footer);

    this.container.appendChild(div);
    setupCodeBlockCopyButtons(div);
    this._setupCopyBtn(div);
    if (!isHistory) this.scrollToBottom();
    return div;
  }

  renderAssistantMessage(message, isStreaming = false, isHistory = false, targetContainer = null) {
    this._clearWelcomeIfPresent();

    const div = document.createElement("div");
    div.className = `message assistant${isHistory ? " history" : ""}`;
    div.dataset.messageId = message.id || "streaming";
    const isProcessMessage = targetContainer !== null;
    const assistantEntryId = resolveMessageEntryId(message);
    if (assistantEntryId && !isProcessMessage) {
      div.dataset.entryId = assistantEntryId;
    }

    let contentHtml = "";
    let usageHtml = "";
    let rawStreamingText = "";
    let hasThinking = false;

    if (typeof message.content === "string") {
      rawStreamingText = message.content;
      contentHtml = isStreaming
        ? renderStreamingMarkdown(message.content)
        : renderMarkdown(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block) continue;
        if (block.type === "text") {
          rawStreamingText += block.text;
          contentHtml += isStreaming
            ? renderStreamingMarkdown(block.text)
            : renderMarkdown(block.text);
        } else if (block.type === "thinking") {
          hasThinking = true;
          contentHtml += this.renderThinkingBlock(block.thinking, message.usage?.cost?.total);
        }
      }
    }

    if (isStreaming) {
      div._streamingRawText = rawStreamingText;
    }

    const hasText = rawStreamingText.trim().length > 0;
    if (!isProcessMessage && message.usage?.cost && !hasThinking) {
      const cost = message.usage.cost.total;
      if (cost > 0) {
        usageHtml = `<span class="message-usage">$${cost.toFixed(4)}</span>`;
      }
    }
    const timeLabel = formatMessageTime(message.timestamp);
    const timeHtml = timeLabel
      ? `<span class="message-time" title="${this.escapeHtml(fullTimestampTitle(message.timestamp))}">${timeLabel}</span>`
      : "";

    const streamingClass = isStreaming ? " streaming" : "";

    if (!isStreaming && isHistory && !contentHtml) return null;

    const showFooter = !isStreaming && !isProcessMessage && (hasText || usageHtml);
    const footerHtml = showFooter
      ? `<div class="message-footer">${hasText ? `<button class="message-copy-btn" aria-label="${this.escapeHtml(t("messages.copyMessage"))}" title="${this.escapeHtml(t("messages.copyMessage"))}">${COPY_ICON}</button>` : ""}${timeHtml}${usageHtml}</div>`
      : "";

    this._replaceMarkup(
      div,
      `<div class="message-content${streamingClass}">${contentHtml}</div>${footerHtml}`,
    );

    setupThinkingBlockToggles(div);
    setupCodeBlockCopyButtons(div);
    if (!isStreaming && hasText && !isProcessMessage) this._setupCopyBtn(div);
    (targetContainer || this.container).appendChild(div);
    if (!isHistory) this.scrollToBottom();

    return div;
  }

  renderThinkingBlock(thinking, cost) {
    const costHtml = this._thinkingCostHtml(cost);
    return `<div class="thinking-block"><div class="thinking-toggle" data-thinking-toggle="true" role="button" tabindex="0"><span class="chevron">${CHEVRON_ICON}</span><span class="thinking-label">${BRAIN_ICON} <span class="thinking-label-text">${this.escapeHtml(t("messages.thinking"))}</span></span>${costHtml}</div><div class="thinking-content">${this.escapeHtml(thinking)}</div></div>`;
  }

  _thinkingCostHtml(cost) {
    if (!(cost > 0)) return "";
    return `<span class="thinking-usage" title="Total cost for this response">$${cost.toFixed(4)}</span>`;
  }

  updateStreamingThinking(messageElement, thinking) {
    let thinkingDiv = messageElement.querySelector(".streaming-thinking");
    if (!thinkingDiv) {
      const contentDiv = messageElement.querySelector(".message-content");
      if (!contentDiv) return;
      thinkingDiv = document.createElement("div");
      thinkingDiv.className = "thinking-block streaming-thinking";
      this._appendMarkup(
        thinkingDiv,
        `<div class="thinking-toggle expanded" data-thinking-toggle="true" role="button" tabindex="0"><span class="chevron">${CHEVRON_ICON}</span><span class="thinking-label">${BRAIN_ICON} <span class="thinking-label-text">${this.escapeHtml(t("messages.thinking"))}</span></span></div><div class="thinking-content expanded"></div>`,
      );
      contentDiv.prepend(thinkingDiv);
      setupThinkingBlockToggles(thinkingDiv);
    }
    const contentEl = thinkingDiv.querySelector(".thinking-content");
    if (contentEl && contentEl.textContent !== thinking) {
      contentEl.textContent = thinking;
      this.scrollToBottom();
    }
  }

  updateStreamingMessage(messageElement, content) {
    const contentDiv = messageElement.querySelector(".message-content");
    if (!contentDiv) return;

    const { text, thinking } = this.splitStreamingContent(content);
    if (thinking) this.updateStreamingThinking(messageElement, thinking);
    if (text) messageElement._streamingRawText = text;

    const thinkingBlock = contentDiv.querySelector(".streaming-thinking");
    if (thinkingBlock) {
      let textNode = contentDiv.querySelector(".streaming-text");
      if (!textNode) {
        textNode = document.createElement("div");
        textNode.className = "streaming-text";
        contentDiv.appendChild(textNode);
      }
      if (text && messageElement._streamingRenderedText !== text) {
        messageElement._streamingRenderedText = text;
        this._replaceMarkup(textNode, renderStreamingMarkdown(text));
        setupCodeBlockCopyButtons(textNode);
      }
    } else if (text && messageElement._streamingRenderedText !== text) {
      messageElement._streamingRenderedText = text;
      this._replaceMarkup(contentDiv, renderStreamingMarkdown(text));
      setupCodeBlockCopyButtons(contentDiv);
    }
    this.scrollToBottom();
  }

  splitStreamingContent(content) {
    return splitStreamingMessageContent(content);
  }

  finalizeStreamingMessage(messageElement, usage = null, thinking = "", durationMs = null) {
    const contentDiv = messageElement.querySelector(".message-content");
    let finalThinking = "";
    if (contentDiv) {
      contentDiv.classList.remove("streaming");
      const streamingText = contentDiv.querySelector(".streaming-text");
      const domText = streamingText ? streamingText.textContent : contentDiv.textContent;
      const rawText =
        typeof messageElement._streamingRawText === "string"
          ? messageElement._streamingRawText
          : domText;
      messageElement._streamingRawText = null;
      messageElement._streamingRenderedText = null;

      finalThinking =
        thinking ||
        contentDiv.querySelector(".streaming-thinking .thinking-content")?.textContent ||
        "";

      let html = "";
      if (finalThinking) {
        html += this.renderThinkingBlock(finalThinking, usage?.cost?.total);
      }
      html += renderMarkdown(rawText);
      this._replaceMarkup(contentDiv, html);
      setupThinkingBlockToggles(contentDiv);
      setupCodeBlockCopyButtons(contentDiv);
    }

    if (!messageElement.querySelector(".message-footer")) {
      const copyableText = this.getCopyableText(messageElement);
      const hasUsage = Boolean(usage?.cost && usage.cost.total > 0 && !finalThinking);
      if (!copyableText && !hasUsage) {
        messageElement.remove();
        return;
      }

      const footer = document.createElement("div");
      footer.className = "message-footer";
      if (copyableText) footer.appendChild(this._createCopyButton());
      const timeSpan = createMessageTimeSpan(Date.now());
      if (timeSpan) footer.appendChild(timeSpan);
      const durationSpan = createMessageDurationSpan(durationMs);
      if (durationSpan) footer.appendChild(durationSpan);
      if (hasUsage) {
        const span = document.createElement("span");
        span.className = "message-usage";
        span.textContent = `$${usage.cost.total.toFixed(4)}`;
        footer.appendChild(span);
      }
      messageElement.appendChild(footer);
      this._setupCopyBtn(messageElement);
    }
  }

  renderSystemMessage(text) {
    const div = document.createElement("div");
    div.className = "system-message";
    div.textContent = text;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  renderError(errorMessage) {
    const div = document.createElement("div");
    div.className = "error-message";
    div.textContent = errorMessage;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  _setupCopyBtn(messageEl) {
    const btn = messageEl.querySelector(".message-copy-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const text = this.getCopyableText(messageEl);
      if (!text) return;
      writeClipboardText(text).then(() => {
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1500);
      });
    });
  }

  getCopyableText(messageEl) {
    return extractCopyableMessageText(messageEl);
  }

  _createCopyButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-copy-btn";
    button.setAttribute("aria-label", t("messages.copyMessage"));
    button.title = t("messages.copyMessage");
    this._appendMarkup(button, COPY_ICON);
    return button;
  }

  _appendMarkup(parent, markup) {
    this._domParser ??= new DOMParser();
    const parsed = this._domParser.parseFromString(String(markup || ""), "text/html");
    sanitizeMarkup(parsed.body);
    parent.append(...parsed.body.childNodes);
  }

  _replaceMarkup(parent, markup) {
    parent.replaceChildren();
    this._appendMarkup(parent, markup);
  }

  highlightTextNode(node, pattern, onMatch) {
    return highlightTextNodeWithPattern(node, pattern, onMatch);
  }

  escapeRegExp(text) {
    return escapeSearchRegExp(text);
  }

  escapeHtml(text) {
    return escapeHtmlText(text);
  }

  scrollToBottom() {
    if (this.isNearBottom && this.container) {
      this.forceScrollToBottom();
    }
  }

  forceScrollToBottom() {
    if (this._scrollRafPending) return;
    this._scrollRafPending = true;
    requestAnimationFrame(() => {
      this._scrollRafPending = false;
      if (this.container) this.container.scrollTop = this.container.scrollHeight;
    });
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this.container && this._scrollHandler) {
      this.container.removeEventListener("scroll", this._scrollHandler);
    }
    if (typeof this.unsubscribeLocaleChange === "function") {
      this.unsubscribeLocaleChange();
      this.unsubscribeLocaleChange = null;
    }
    this._scrollHandler = null;
    this.container = null;
  }
}
