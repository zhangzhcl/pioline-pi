import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLocale } from "../i18n.js";
import { MessageRenderer } from "./message-renderer.js";

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

describe("MessageRenderer message toolbar timestamps", () => {
  let container;
  let renderer;

  beforeEach(async () => {
    document.body.replaceChildren();
    container = document.createElement("div");
    document.body.append(container);
    renderer = new MessageRenderer(container);
  });

  it("formats same-day times as HH:MM and cross-day as MM/DD HH:MM", async () => {
    const { formatMessageTime } = await import("./message-renderer.js");
    const now = new Date();
    const sameDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5).getTime();
    expect(formatMessageTime(sameDay)).toBe("09:05");

    const otherDay = new Date(2020, 0, 15, 14, 30).getTime();
    expect(formatMessageTime(otherDay)).toBe("01/15 14:30");
  });

  it("returns an empty label for missing, invalid, or out-of-range timestamps", async () => {
    const { formatMessageTime } = await import("./message-renderer.js");
    expect(formatMessageTime(null)).toBe("");
    expect(formatMessageTime(undefined)).toBe("");
    expect(formatMessageTime("not-a-number")).toBe("");
    expect(formatMessageTime(NaN)).toBe("");
    expect(formatMessageTime(1e20)).toBe("");
  });

  it("formats a response duration as seconds, or minutes+seconds past a minute", async () => {
    const { formatDurationLabel } = await import("./message-renderer.js");
    expect(formatDurationLabel(320)).toBe("0.3s");
    expect(formatDurationLabel(3200)).toBe("3.2s");
    expect(formatDurationLabel(65_400)).toBe("1m 05s");
  });

  it("returns an empty duration label for missing or invalid durations", async () => {
    const { formatDurationLabel } = await import("./message-renderer.js");
    expect(formatDurationLabel(null)).toBe("");
    expect(formatDurationLabel(undefined)).toBe("");
    expect(formatDurationLabel(-5)).toBe("");
    expect(formatDurationLabel(Number.NaN)).toBe("");
  });

  it("orders the user footer slots copy before time, with tree actions leading", () => {
    const ts = new Date(2020, 0, 15, 10, 30).getTime();
    renderer.renderUserMessage({ content: "hello", timestamp: ts });

    const footer = container.querySelector(".message.user .message-footer");
    expect(footer).not.toBeNull();
    const time = footer.querySelector(".message-time");
    expect(time?.textContent).toBe("01/15 10:30");
    expect(time?.title).toContain("2020-01-15 10:30");
    const classes = [...footer.children].map((el) => el.className);
    expect(classes).toEqual(["message-copy-btn", "message-time"]);
  });

  it("renders the full tree-action slot order ahead of copy and time", () => {
    const ts = new Date(2020, 0, 15, 10, 30).getTime();
    const treeRenderer = new MessageRenderer(container, { sessionTreeActions: true });
    treeRenderer.renderUserMessage({ content: "a".repeat(400), timestamp: ts, entryId: "u1" });

    const classes = [...container.querySelector(".message.user .message-footer").children].map(
      (el) => el.className,
    );
    expect(classes).toEqual([
      "message-user-collapse-toggle",
      "message-action message-fork-btn",
      "message-action message-edit-btn",
      "message-copy-btn",
      "message-time",
    ]);
  });

  it("omits the time span when a user message carries no timestamp", () => {
    renderer.renderUserMessage({ content: "hello" });
    const footer = container.querySelector(".message.user .message-footer");
    expect(footer?.querySelector(".message-time")).toBeNull();
    expect(footer?.querySelector(".message-copy-btn")).not.toBeNull();
  });

  it("renders copy, time, then cost in the assistant footer", () => {
    const ts = new Date(2020, 0, 15, 9, 5).getTime();
    renderer.renderAssistantMessage({
      content: [{ type: "text", text: "answer" }],
      usage: { cost: { total: 0.0123 } },
      timestamp: ts,
    });

    const footer = container.querySelector(".message.assistant .message-footer");
    expect(footer?.querySelector(".message-copy-btn")).not.toBeNull();
    const time = footer?.querySelector(".message-time");
    expect(time?.textContent).toBe("01/15 09:05");
    expect(footer?.querySelector(".message-usage")?.textContent).toBe("$0.0123");
    const children = [...footer.children].map((el) => el.className);
    expect(children.indexOf("message-copy-btn")).toBeLessThan(children.indexOf("message-time"));
    expect(children.indexOf("message-time")).toBeLessThan(children.indexOf("message-usage"));
  });

  it("attaches the completion time when streaming finalizes", () => {
    const el = renderer.renderAssistantMessage(
      { content: [{ type: "text", text: "done" }], timestamp: 1 },
      true,
    );
    expect(el.querySelector(".message-footer")).toBeNull();

    renderer.finalizeStreamingMessage(el, { cost: { total: 0.01 } });
    const footer = el.querySelector(".message-footer");
    expect(footer?.querySelector(".message-time")).not.toBeNull();
  });

  it("shows the client-timed response duration when streaming finalizes", () => {
    const el = renderer.renderAssistantMessage(
      { content: [{ type: "text", text: "done" }], timestamp: 1 },
      true,
    );
    renderer.finalizeStreamingMessage(el, null, "", 3200);
    const duration = el.querySelector(".message-footer .message-duration");
    expect(duration?.textContent).toBe("3.2s");
    expect(duration?.title).toBe("Response time");
  });

  it("omits the duration span when no duration was measured", () => {
    const el = renderer.renderAssistantMessage(
      { content: [{ type: "text", text: "done" }], timestamp: 1 },
      true,
    );
    renderer.finalizeStreamingMessage(el);
    expect(el.querySelector(".message-footer .message-duration")).toBeNull();
  });

  it("keeps the user footer permanently visible without a hover reveal", () => {
    const el = renderer.renderUserMessage({ content: "hello", timestamp: 1 });
    const footer = el.querySelector(".message-footer");
    el.querySelector(".message-content").dispatchEvent(new MouseEvent("mouseenter"));
    expect(footer.classList.contains("visible")).toBe(false);
  });
});

describe("MessageRenderer locale change", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  it("updates copy button aria-label and title on locale change without re-rendering content", async () => {
    const el = renderer.renderAssistantMessage({ content: "hello **world**" }, false);
    const copyBtn = el.querySelector(".message-copy-btn");
    expect(copyBtn.getAttribute("aria-label")).toBe("Copy message");

    const contentHtmlBefore = el.querySelector(".message-content").innerHTML;

    await setLocale("zh");

    expect(copyBtn.getAttribute("aria-label")).toBe("复制消息");
    expect(copyBtn.title).toBe("复制消息");
    expect(el.querySelector(".message-content").innerHTML).toBe(contentHtmlBefore);
  });

  it("toggles thinking content within its own message element", () => {
    const el = renderer.renderAssistantMessage({
      content: [{ type: "thinking", thinking: "pondering" }],
    });
    const toggle = el.querySelector("[data-thinking-toggle]");
    const content = el.querySelector(".thinking-content");
    expect(toggle.getAttribute("id")).toBeNull();
    toggle.click();
    expect(content.classList.contains("expanded")).toBe(true);
    toggle.click();
    expect(content.classList.contains("expanded")).toBe(false);
  });

  it("updates thinking label text on locale change", async () => {
    const el = renderer.renderAssistantMessage(
      {
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "pondering" },
        ],
      },
      false,
    );
    const labelEl = el.querySelector(".thinking-label-text");
    expect(labelEl.textContent).toBe("Thinking");

    await setLocale("zh");

    expect(labelEl.textContent).toBe("思考中");
  });

  it("updates user collapse toggle labels on locale change without re-rendering content", async () => {
    const el = renderer.renderUserMessage({ content: "a".repeat(400) });
    const toggle = el.querySelector(".message-user-collapse-toggle");
    expect(toggle.textContent).toBe("Expand");

    toggle.click();
    expect(toggle.textContent).toBe("Collapse");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const contentHtmlBefore = el.querySelector(".message-content").innerHTML;

    await setLocale("zh");

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("收起");
    expect(el.querySelector(".message-content").innerHTML).toBe(contentHtmlBefore);
  });

  it("re-renders welcome on locale change when .welcome exists", async () => {
    renderer.renderWelcome({ workspacePath: "/home/user/project" });
    expect(container.querySelector(".welcome")).not.toBeNull();
    expect(container.textContent).toContain("Welcome to Pipline");

    await setLocale("zh");

    expect(container.querySelector(".welcome")).not.toBeNull();
    expect(container.textContent).toContain("欢迎使用 Pipline");
  });

  it("does not re-render streaming content on locale change and preserves _streamingRawText", async () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "partial **bold** text");
    expect(el._streamingRawText).toBe("partial **bold** text");

    const contentHtmlBefore = el.querySelector(".message-content").innerHTML;

    await setLocale("zh");

    expect(el._streamingRawText).toBe("partial **bold** text");
    expect(el.querySelector(".message-content").innerHTML).toBe(contentHtmlBefore);
  });
});

describe("MessageRenderer teardown", () => {
  it("clear() keeps the renderer live so a locale change still re-renders", async () => {
    const container = document.createElement("div");
    const renderer = new MessageRenderer(container);
    renderer.renderWelcome({});
    renderer.clear();
    renderer.renderWelcome({});
    await setLocale("zh");
    expect(container.querySelector(".welcome p").textContent).toBe("欢迎使用 Pipline");
  });

  it("destroy() stops locale re-renders, removes the scroll listener, and is idempotent", async () => {
    const container = document.createElement("div");
    const removeSpy = vi.spyOn(container, "removeEventListener");
    const renderer = new MessageRenderer(container);
    renderer.renderWelcome({});
    const welcomeP = container.querySelector(".welcome p");
    expect(welcomeP.textContent).toBe("Welcome to Pipline");

    renderer.destroy();
    expect(() => renderer.destroy()).not.toThrow();
    expect(removeSpy).toHaveBeenCalled();
    await setLocale("zh");
    expect(welcomeP.textContent).toBe("Welcome to Pipline");
  });
});
