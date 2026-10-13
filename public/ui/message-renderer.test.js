import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { MessageRenderer, shouldCollapseUserMessage } from "./message-renderer.js";

const enMessages = {
  messages: {
    copyMessage: "Copy message",
    forkSession: "Fork session",
    editMessage: "Edit message",
    thinking: "Thinking",
    attachedImage: "Attached image",
    copy: "Copy",
    copied: "Copied!",
    expand: "Expand",
    collapse: "Collapse",
    responseTime: "Response time",
  },
  app: {
    welcome: "Welcome to Pipline",
    welcomeHint: "Type a message...",
    currentWorkspace: "Current workspace:",
  },
  shortcuts: { focusInput: "Focus input", abort: "Abort" },
  migrated: {
    index: {
      ariaLabel: {
        keyboardShortcuts: "Keyboard shortcuts",
      },
    },
  },
};
const zhMessages = {
  messages: {
    copyMessage: "复制消息",
    forkSession: "分支会话",
    editMessage: "编辑消息",
    thinking: "思考中",
    attachedImage: "附件图片",
    copy: "复制",
    copied: "已复制！",
    expand: "展开",
    collapse: "收起",
  },
  app: {
    welcome: "欢迎使用 Pipline",
    welcomeHint: "输入消息...",
    currentWorkspace: "当前工作区：",
  },
  shortcuts: { focusInput: "聚焦输入", abort: "中止" },
  migrated: {
    index: {
      ariaLabel: {
        keyboardShortcuts: "键盘快捷键",
      },
    },
  },
};

beforeEach(async () => {
  vi.unstubAllGlobals();
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/locales/en.json")) {
        return { ok: true, status: 200, json: async () => enMessages };
      }
      if (u.includes("/locales/zh.json")) {
        return { ok: true, status: 200, json: async () => zhMessages };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  await initI18n();
});

describe("MessageRenderer streaming markdown preview", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  it("renders markdown live during streaming updates", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "hello **bold te");

    const content = el.querySelector(".message-content");
    expect(content.innerHTML).toContain("<strong>bold te</strong>");
  });

  it("finalizes from the raw text, not the rendered DOM", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "a **bold** word and `code`");
    renderer.finalizeStreamingMessage(el);

    const content = el.querySelector(".message-content");
    expect(content.innerHTML).toContain("<strong>bold</strong>");
    expect(content.innerHTML).toContain("<code>code</code>");
  });

  it("preserves streamed text when message_end carries only tool_use blocks", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "I will call a tool now.");
    renderer.updateStreamingMessage(el, [{ type: "tool_use", id: "x", name: "bash", input: {} }]);
    renderer.finalizeStreamingMessage(el);

    const content = el.querySelector(".message-content");
    expect(content.textContent.trim()).toBe("I will call a tool now.");
    expect(el.querySelector(".message-copy-btn")).not.toBeNull();
  });

  it("does not add a copy footer to empty finalized streaming messages", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);

    renderer.finalizeStreamingMessage(el);

    expect(el.querySelector(".message-footer")).toBeNull();
    expect(el.querySelector(".message-copy-btn")).toBeNull();
  });

  it("keeps a partial code block previewing as a code block", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "```js\nconst a = 1;");

    const content = el.querySelector(".message-content");
    expect(content.querySelector(".code-block-wrapper")).not.toBeNull();
    expect(content.textContent).toContain("const a = 1;");
  });

  it("preserves the thinking block while streaming text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingThinking(el, "pondering...");
    renderer.updateStreamingMessage(el, "some *italic");

    expect(el.querySelector(".streaming-thinking")).not.toBeNull();
    expect(el.querySelector(".streaming-text").innerHTML).toContain("<em>italic</em>");
  });

  it("does not render raw HTML from streamed text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "`<script>alert(1)</script>`");

    const content = el.querySelector(".message-content");
    expect(content.querySelector("script")).toBeNull();
  });

  it("copies assistant text without thinking label or content", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const el = renderer.renderAssistantMessage(
      {
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "Visible answer" },
        ],
      },
      false,
      true,
    );

    el.querySelector(".message-copy-btn").click();

    expect(writeText).toHaveBeenCalledWith("Visible answer");
  });

  it("does not collapse short user messages", () => {
    expect(shouldCollapseUserMessage("short message")).toBe(false);
    const el = renderer.renderUserMessage({ content: "short message" }, true);

    expect(el.querySelector(".message-user-collapse-toggle")).toBeNull();
    expect(
      el.querySelector(".message-content").classList.contains("user-message-collapsible"),
    ).toBe(false);
  });

  it("collapses long user messages in live and history rendering", () => {
    const content = "a".repeat(400);

    expect(shouldCollapseUserMessage(content)).toBe(true);
    const live = renderer.renderUserMessage({ content });
    const history = renderer.renderUserMessage({ content }, true);

    for (const el of [live, history]) {
      const messageContent = el.querySelector(".message-content");
      const toggle = el.querySelector(".message-user-collapse-toggle");
      expect(messageContent.classList.contains("user-message-collapsible")).toBe(true);
      expect(messageContent.classList.contains("expanded")).toBe(false);
      expect(toggle.textContent).toBe("Expand");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.closest(".message-footer")).toBe(el.querySelector(".message-footer"));
      expect(el.querySelector(".message-footer").firstElementChild).toBe(toggle);
    }
  });

  it("collapses messages with eight or more line breaks", () => {
    const content = Array.from({ length: 9 }, (_, index) => `line ${index}`).join("\n");
    expect(shouldCollapseUserMessage(content)).toBe(true);
    expect(
      renderer.renderUserMessage({ content }).querySelector(".message-user-collapse-toggle"),
    ).not.toBeNull();
  });

  it("expands and collapses long user messages accessibly", () => {
    const el = renderer.renderUserMessage({ content: "a".repeat(400) });
    const content = el.querySelector(".message-content");
    const toggle = el.querySelector(".message-user-collapse-toggle");

    toggle.click();
    expect(content.classList.contains("expanded")).toBe(true);
    expect(toggle.textContent).toBe("Collapse");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    toggle.click();
    expect(content.classList.contains("expanded")).toBe(false);
    expect(toggle.textContent).toBe("Expand");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("removes unsafe HTML attributes and URL schemes from user markdown", () => {
    const el = renderer.renderUserMessage({
      content:
        '<img src="javascript:alert(1)" onerror="alert(2)"><a href="javascript:alert(3)">link</a>',
    });

    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img").getAttribute("src")).toBeNull();
    expect(el.querySelector("img").getAttribute("onerror")).toBeNull();
    expect(el.querySelector("a").getAttribute("href")).toBeNull();
  });

  it("renders fork and edit actions only when sessionTreeActions is enabled", () => {
    const events = [];
    container.addEventListener("messagefork", (event) => events.push(event.detail));

    renderer.renderUserMessage({ content: "Try this path", entryId: "entry-user-1" }, true);
    expect(container.querySelector(".message-fork-btn")).toBeNull();
    expect(container.querySelector(".message-edit-btn")).toBeNull();

    const treeRenderer = new MessageRenderer(container, { sessionTreeActions: true });
    treeRenderer.renderUserMessage({ content: "Try this path", entryId: "entry-user-1" }, true);
    container.querySelector(".message-fork-btn").click();

    expect(events).toEqual([{ entryId: "entry-user-1", text: "Try this path" }]);
  });

  it("dispatches messageedit with the entry id and prompt text", () => {
    const events = [];
    container.addEventListener("messageedit", (event) => events.push(event.detail));

    const treeRenderer = new MessageRenderer(container, { sessionTreeActions: true });
    treeRenderer.renderUserMessage({ content: "Revise me", entryId: "entry-user-2" }, true);
    container.querySelector(".message-edit-btn").click();

    expect(events).toEqual([{ entryId: "entry-user-2", text: "Revise me" }]);
  });

  it("anchors visible assistant messages with data-entry-id", () => {
    const el = renderer.renderAssistantMessage(
      { content: "final answer", entryId: "asst-1" },
      false,
      true,
    );
    expect(el.dataset.entryId).toBe("asst-1");
  });

  it("does not anchor process-group assistant fragments", () => {
    const group = document.createElement("div");
    const el = renderer.renderAssistantMessage(
      { content: "thinking out loud", entryId: "asst-1" },
      false,
      true,
      group,
    );
    expect(el.dataset.entryId).toBeUndefined();
  });

  it("highlights keyword matches across rendered messages", () => {
    renderer.renderUserMessage({ content: "Alpha beta gamma" }, true);
    renderer.renderAssistantMessage({ content: "Beta appears twice: beta." }, false, true);

    const count = renderer.highlightSearchQuery("beta");
    const marks = container.querySelectorAll("mark");

    expect(count).toBe(3);
    expect(marks).toHaveLength(3);
    expect(marks[0].textContent.toLowerCase()).toBe("beta");
  });

  it("scrolls the first highlighted match into view", () => {
    renderer.renderAssistantMessage({ content: "jump to keyword" }, false, true);

    let scrolled = false;
    Element.prototype.scrollIntoView = () => {
      scrolled = true;
    };

    const count = renderer.highlightSearchQuery("keyword");

    expect(count).toBe(1);
    expect(scrolled).toBe(true);
  });

  it("can force-scroll after rendering session history", async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
      callback();
      return 0;
    };
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1200 });

    try {
      renderer.forceScrollToBottom();

      expect(container.scrollTop).toBe(1200);
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });

  it("stops auto-scrolling when the user scrolls up within the old near-bottom threshold", () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
      callback();
      return 0;
    };
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 650 },
    });
    container.scrollTop = 0;

    try {
      container.dispatchEvent(new Event("scroll"));
      renderer.scrollToBottom();

      expect(container.scrollTop).toBe(0);
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });
});
