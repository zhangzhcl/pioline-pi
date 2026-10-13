import {
  captureExpandedProcessGroups,
  createProcessDetailsGroup,
  summarizeProcessGroup,
} from "../../ui/process-group.js";
import { extractAssistantError } from "./assistant-error.js";

export function summarizeMessageRoles(messages) {
  const counts = {};
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role || "unknown";
    counts[role] = (counts[role] || 0) + 1;
  }
  return counts;
}

export function assistantTextOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

/**
 * 将单条助手消息的内容块拆分为中间执行过程（思考、工具调用及前置说明文本）与最终回复文本块。
 */
export function splitFinalAssistantBlocks(content) {
  if (!Array.isArray(content)) return { processBlocks: [], answerBlocks: [] };
  let lastNonTextIdx = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i]?.type !== "text") lastNonTextIdx = i;
  }
  return {
    processBlocks: content.slice(0, lastNonTextIdx + 1),
    answerBlocks: content.slice(lastNonTextIdx + 1),
  };
}

export function textFromResult(result) {
  return (result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function textFromMessageContent(content) {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => block?.type === "text")
            .map((block) => block.text ?? "")
            .join("\n")
        : "";
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 120) : null;
}

/**
 * 管理会话历史全量渲染、流式过程指示器、已完成轮次的思考/工具折叠组，以及聊天区域全文搜索高亮。
 */
export function createChatHistoryRenderer({
  messagesElement,
  messageRenderer,
  toolRenderer,
  extensionUi,
  subagentRuns,
  getTarget,
  t,
  showError,
}) {
  let liveProcessGroup = null;
  let activeSearchQuery = "";

  function summarizeElementBox(element) {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      tag: element.tagName?.toLowerCase() ?? null,
      id: element.id || null,
      className: String(element.className || ""),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      position: style.position,
      zIndex: style.zIndex,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left),
    };
  }

  function summarizeMessagesDom() {
    if (!messagesElement) return null;
    const style = getComputedStyle(messagesElement);
    const rect = messagesElement.getBoundingClientRect();
    const firstChildren = Array.from(messagesElement.children)
      .slice(0, 5)
      .map((child) => ({
        className: String(child.className || ""),
        textLength: child.textContent?.trim().length ?? 0,
        textPreview: (child.textContent || "").trim().slice(0, 80),
        box: summarizeElementBox(child),
      }));
    const centerX = Math.round(rect.left + rect.width / 2);
    const centerY = Math.round(rect.top + Math.min(rect.height / 2, 160));
    const elementAtCenter = document.elementFromPoint?.(centerX, centerY) ?? null;
    return {
      bodyClass: document.body.className || null,
      bodyRuntime: document.body.dataset.runtime || null,
      url: window.location.href,
      messages: summarizeElementBox(messagesElement),
      main: summarizeElementBox(document.querySelector(".main")),
      workspaceContent: summarizeElementBox(document.querySelector(".workspace-content")),
      inputArea: summarizeElementBox(document.querySelector(".input-area")),
      superAgentRuntime: summarizeElementBox(document.querySelector("super-agent-runtime")),
      childCount: messagesElement.children.length,
      firstChildClass: messagesElement.firstElementChild?.className ?? null,
      userCount: messagesElement.querySelectorAll(".message.user, .user").length,
      assistantCount: messagesElement.querySelectorAll(".message.assistant, .assistant").length,
      toolCardCount: messagesElement.querySelectorAll(".tool-card").length,
      processGroupCount: messagesElement.querySelectorAll(".process-details").length,
      hasWelcome: Boolean(messagesElement.querySelector(".welcome")),
      scrollTop: Math.round(messagesElement.scrollTop),
      scrollHeight: messagesElement.scrollHeight,
      clientHeight: messagesElement.clientHeight,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      overflowY: style.overflowY,
      elementAtCenter: summarizeElementBox(elementAtCenter),
      firstChildren,
    };
  }

  function logMessagesDom(label, extra = {}) {
    console.info(`[SESSION-LOAD] ${label}`, extra);
    if (globalThis.__PIPLINE_DEBUG_DOM === true) {
      console.info(`[SESSION-LOAD] ${label} dom-json`, JSON.stringify(summarizeMessagesDom()));
    }
  }

  function lastAssistantErrorInRange(messages, start, end) {
    for (let i = end - 1; i >= start; i -= 1) {
      if (messages[i]?.role === "assistant") {
        return extractAssistantError(messages[i], { fallback: t("messages.providerError") });
      }
    }
    return null;
  }

  function renderToolCallBlocks(blocks, toolResults, targetContainer) {
    let count = 0;
    for (const block of blocks) {
      if (block?.type !== "toolCall") continue;
      count += 1;
      toolRenderer.createHistoryCard(
        { toolCallId: block.id, toolName: block.name, args: block.arguments ?? {} },
        targetContainer,
      );
      const result = toolResults.get(block.id);
      if (result) toolRenderer.addHistoryResult(block.id, result, result.isError);
    }
    return count;
  }

  function applyActiveSearchHighlight({ scrollToFirst = true } = {}) {
    const query = activeSearchQuery.trim();
    if (!query) {
      messageRenderer.clearSearchHighlights();
      return 0;
    }
    return messageRenderer.highlightSearchQuery(query, { scrollToFirst });
  }

  function renderHistory(messages) {
    const target = getTarget();
    console.info("[SESSION-LOAD] renderHistory start", {
      sessionId: target.sessionId,
      messageCount: messages.length,
      roles: summarizeMessageRoles(messages),
      existingChildCount: messagesElement?.children?.length ?? null,
    });
    const hadInFlightPrompt = extensionUi.requeueForegroundPrompt();
    const expandedProcessGroups = captureExpandedProcessGroups(messagesElement);
    messageRenderer.clear();
    toolRenderer.clear();
    liveProcessGroup = null;
    if (messages.length === 0) {
      messageRenderer.renderWelcome();
      applyActiveSearchHighlight({ scrollToFirst: false });
      subagentRuns.restore(target.sessionId).catch(showError);
      logMessagesDom("renderHistory empty", {
        sessionId: target.sessionId,
      });
      return hadInFlightPrompt;
    }

    const toolResults = new Map();
    for (const message of messages) {
      if (message.role === "toolResult") {
        toolResults.set(message.toolCallId, message);
      }
    }

    const turns = [];
    let turnStart = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "user" && i !== turnStart) {
        turns.push([turnStart, i]);
        turnStart = i;
      }
    }
    turns.push([turnStart, messages.length]);

    let processGroupIndex = 0;
    for (const [start, end] of turns) {
      const anchor = messages[start];
      let bodyStart = start;
      if (anchor.role === "user") {
        messageRenderer.renderUserMessage(anchor, true);
        bodyStart = start + 1;
      }

      let finalAssistantIdx = -1;
      for (let i = end - 1; i >= bodyStart; i--) {
        if (messages[i].role === "assistant" && assistantTextOf(messages[i].content)) {
          finalAssistantIdx = i;
          break;
        }
      }

      let group = null;
      let stepCount = 0;
      let toolCallCount = 0;
      const ensureGroup = () => {
        if (!group) {
          group = createProcessDetailsGroup({
            expanded: expandedProcessGroups.has(processGroupIndex),
          });
          processGroupIndex += 1;
          messagesElement.appendChild(group.wrapper);
        }
        return group;
      };

      for (let i = bodyStart; i < end; i++) {
        const message = messages[i];
        if (message.role !== "assistant") continue;

        if (i === finalAssistantIdx) {
          const { processBlocks, answerBlocks } = splitFinalAssistantBlocks(message.content);
          const isUnterminatedTurn = answerBlocks.length === 0 && i === messages.length - 1;
          if (isUnterminatedTurn) {
            const leadingText = processBlocks.filter((b) => b.type === "text");
            if (leadingText.length > 0) {
              messageRenderer.renderAssistantMessage(
                {
                  content: leadingText,
                  usage: message.usage,
                  timestamp: message.timestamp,
                  entryId: message.entryId,
                },
                false,
                true,
              );
            }
            const remainingProcessBlocks = processBlocks.filter((b) => b.type !== "text");
            if (remainingProcessBlocks.some((b) => b.type === "thinking")) {
              const el = messageRenderer.renderAssistantMessage(
                { content: remainingProcessBlocks, usage: message.usage },
                false,
                true,
                ensureGroup().body,
              );
              if (el) stepCount += 1;
            }
            if (remainingProcessBlocks.some((b) => b.type === "toolCall")) {
              toolCallCount += renderToolCallBlocks(
                remainingProcessBlocks,
                toolResults,
                ensureGroup().body,
              );
            }
          } else {
            if (processBlocks.some((b) => b.type === "text" || b.type === "thinking")) {
              const el = messageRenderer.renderAssistantMessage(
                { content: processBlocks, usage: message.usage },
                false,
                true,
                ensureGroup().body,
              );
              if (el) stepCount += 1;
            }
            if (processBlocks.some((b) => b.type === "toolCall")) {
              toolCallCount += renderToolCallBlocks(processBlocks, toolResults, ensureGroup().body);
            }
          }
          if (answerBlocks.length > 0) {
            messageRenderer.renderAssistantMessage(
              {
                content: answerBlocks,
                usage: message.usage,
                timestamp: message.timestamp,
                entryId: message.entryId,
              },
              false,
              true,
            );
          }
        } else {
          const el = messageRenderer.renderAssistantMessage(
            message,
            false,
            true,
            ensureGroup().body,
          );
          if (el) stepCount += 1;
          toolCallCount += renderToolCallBlocks(message.content ?? [], toolResults, group.body);
        }
      }

      const turnError = lastAssistantErrorInRange(messages, bodyStart, end);
      if (turnError) messageRenderer.renderError(turnError);

      if (group) {
        if (group.body.children.length > 0) {
          group.setLabel(summarizeProcessGroup(stepCount, toolCallCount));
        } else {
          group.wrapper.remove();
        }
      }
    }

    subagentRuns.restore(target.sessionId).catch(showError);

    const highlighted = applyActiveSearchHighlight();
    if (highlighted === 0) messageRenderer.forceScrollToBottom();
    logMessagesDom("renderHistory complete", {
      sessionId: target.sessionId,
      inputCount: messages.length,
      turnCount: turns.length,
      highlighted,
    });
    return hadInFlightPrompt;
  }

  function collapseCompletedTurn({ markDone = false } = {}) {
    const children = Array.from(messagesElement.children);
    let lastUserIdx = -1;
    for (let i = children.length - 1; i >= 0; i--) {
      if (children[i].classList.contains("user")) {
        lastUserIdx = i;
        break;
      }
    }
    const afterUser = children.slice(lastUserIdx + 1);
    if (afterUser.length === 0) return;

    const group = createProcessDetailsGroup();
    let stepCount = 0;
    let toolCallCount = 0;
    let inserted = false;
    const insertGroupBefore = (el) => {
      if (inserted) return;
      el.before(group.wrapper);
      inserted = true;
    };

    for (const el of afterUser) {
      if (el.classList.contains("tool-card")) {
        insertGroupBefore(el);
        group.body.appendChild(el);
        stepCount += 1;
        toolCallCount += 1;
        continue;
      }
      if (el.classList.contains("assistant")) {
        const thinkingEl = el.querySelector(".thinking-block");
        if (!thinkingEl) continue;
        insertGroupBefore(el);
        thinkingEl.remove();
        group.body.appendChild(thinkingEl);
        stepCount += 1;
        const contentEl = el.querySelector(".message-content");
        const hasRemainingContent = Boolean(contentEl?.textContent.trim());
        if (!hasRemainingContent) el.remove();
      }
    }

    if (group.body.children.length === 0) return;
    group.setLabel(summarizeProcessGroup(stepCount, toolCallCount));
    if (markDone) group.markDone();
  }

  function showLiveProcessIndicator() {
    if (liveProcessGroup) return;
    liveProcessGroup = createProcessDetailsGroup();
    liveProcessGroup.setLabel(t("messages.thinking"));
    liveProcessGroup.setStreaming(true);
    messagesElement.appendChild(liveProcessGroup.wrapper);
    messageRenderer.forceScrollToBottom();
  }

  function hideLiveProcessIndicator() {
    liveProcessGroup?.wrapper.remove();
    liveProcessGroup = null;
  }

  return {
    logMessagesDom,
    renderHistory,
    collapseCompletedTurn,
    showLiveProcessIndicator,
    hideLiveProcessIndicator,
    resetLiveProcessGroup() {
      liveProcessGroup = null;
    },
    setActiveSearchQuery(query) {
      activeSearchQuery = query || "";
    },
    applyActiveSearchHighlight,
  };
}
