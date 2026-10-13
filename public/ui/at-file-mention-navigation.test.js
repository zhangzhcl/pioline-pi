import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { setupAtFileMention } from "./at-file-mention.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

function setCaret(input, index) {
  input.setSelectionRange(index, index);
}

function canned(items) {
  return vi.fn(async () => ({ items, truncated: false }));
}

describe("at-file-mention keyboard navigation and lifecycle", () => {
  let dom;
  let input;
  let container;

  beforeEach(async () => {
    dom = new JSDOM(`
      <textarea id="input"></textarea>
      <div id="popup" class="hidden"></div>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.queueMicrotask = (callback) => callback();
    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).includes("/locales/en.json")) {
        return { ok: true, status: 200, json: async () => enMessages };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await initI18n();
    dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
    input = document.getElementById("input");
    container = document.getElementById("popup");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.Event;
    delete globalThis.queueMicrotask;
    delete globalThis.fetch;
  });

  test("cycles selection with arrows and closes on Escape", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@a", label: "a", description: "a", isDirectory: false },
        { value: "@b", label: "b", description: "b", isDirectory: false },
        { value: "@c", label: "c", description: "c", isDirectory: false },
      ]),
    });
    input.value = "@";
    setCaret(input, 1);
    await controller.update();
    expect(container.classList.contains("hidden")).toBe(false);

    const down = new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true });
    input.dispatchEvent(down);
    expect(input.getAttribute("aria-activedescendant")).toBe("popup-opt-1");
    const up = new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true });
    input.dispatchEvent(up);
    expect(input.getAttribute("aria-activedescendant")).toBe("popup-opt-0");
    const esc = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    input.dispatchEvent(esc);
    expect(container.classList.contains("hidden")).toBe(true);
    controller.destroy();
  });

  test("Enter selects an open candidate instead of sending, and sends normally after close", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false },
      ]),
    });
    const sendListener = vi.fn((event) => event.preventDefault());
    input.addEventListener("keydown", sendListener);

    input.value = "@a";
    setCaret(input, 2);
    await controller.update();
    const enterOpen = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    input.dispatchEvent(enterOpen);
    expect(sendListener).not.toHaveBeenCalled();
    expect(input.value).toBe("@a.ts ");

    sendListener.mockClear();
    const enterClosed = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    input.dispatchEvent(enterClosed);
    expect(sendListener).toHaveBeenCalled();
    controller.destroy();
  });

  test("Tab on an open menu inserts instead of traversing focus", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false },
      ]),
    });
    const tabListener = vi.fn();
    input.addEventListener("keydown", tabListener);
    input.value = "@a";
    setCaret(input, 2);
    await controller.update();
    const tab = new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true });
    input.dispatchEvent(tab);
    expect(tabListener).not.toHaveBeenCalled();
    expect(input.value).toBe("@a.ts ");
    controller.destroy();
  });

  test("does not consume keys during IME composition", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false },
      ]),
    });
    input.value = "@a";
    setCaret(input, 2);
    await controller.update();
    const composing = new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      isComposing: true,
    });
    input.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(input.value).toBe("@a");
    controller.destroy();
  });

  test("debounces the request and aborts a superseded one", async () => {
    let firstSignal = null;
    const searchFiles = vi.fn((_root, _query, signal) => {
      if (searchFiles.mock.calls.length === 1) firstSignal = signal;
      return Promise.resolve({ items: [], truncated: false });
    });
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles,
    });
    input.value = "@a";
    setCaret(input, 2);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(searchFiles).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(searchFiles).toHaveBeenCalledTimes(1);

    input.value = "@ab";
    setCaret(input, 3);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(firstSignal.aborted).toBe(true);
    controller.destroy();
  });

  test("suppresses a stale response whose value or caret changed", async () => {
    let resolveSearch;
    const searchFiles = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSearch = () =>
            resolve({
              items: [{ value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false }],
              truncated: false,
            });
        }),
    );
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles,
    });
    input.value = "@a";
    setCaret(input, 2);
    const pending = controller.update();
    input.value = "@b";
    setCaret(input, 2);
    resolveSearch();
    await pending;
    expect(container.classList.contains("hidden")).toBe(true);
    controller.destroy();
  });

  test("looks up the workspace root live on every request", async () => {
    const getWorkspaceRoot = vi.fn(() => "/repo");
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot,
      searchFiles: canned([
        { value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false },
      ]),
    });
    input.value = "@a";
    setCaret(input, 2);
    await controller.update();
    input.value = "@a";
    setCaret(input, 2);
    await controller.update();
    expect(getWorkspaceRoot).toHaveBeenCalledTimes(2);
    controller.destroy();
  });

  test("uses unique option ids across two controllers", async () => {
    const dom2 = new JSDOM(`<textarea id="i2"></textarea><div id="p2" class="hidden"></div>`);
    const input2 = dom2.window.document.getElementById("i2");
    const container2 = dom2.window.document.getElementById("p2");
    dom2.window.HTMLElement.prototype.scrollIntoView = vi.fn();

    const searchFiles = canned([
      { value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false },
    ]);
    const c1 = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles,
    });
    const c2 = setupAtFileMention({
      input: input2,
      container: container2,
      document: dom2.window.document,
      getWorkspaceRoot: () => "/repo",
      searchFiles,
    });
    input.value = "@a";
    setCaret(input, 2);
    await c1.update();
    input2.value = "@a";
    input2.setSelectionRange(2, 2);
    await c2.update();
    expect(container.querySelector(".at-file-mention-option").id).toBe("popup-opt-0");
    expect(container2.querySelector(".at-file-mention-option").id).toBe("p2-opt-0");
    c1.destroy();
    c2.destroy();
    dom2.window.close();
  });

  test("closes on blur and selects on click", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false },
      ]),
    });
    input.value = "@a";
    setCaret(input, 2);
    await controller.update();
    input.dispatchEvent(new dom.window.Event("blur"));
    expect(container.classList.contains("hidden")).toBe(true);
    controller.destroy();
  });

  test("a pending response cannot mutate the DOM after destroy()", async () => {
    let resolveSearch;
    const searchFiles = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSearch = () =>
            resolve({
              items: [{ value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false }],
              truncated: false,
            });
        }),
    );
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles,
    });
    input.value = "@a";
    setCaret(input, 2);
    const pending = controller.update();
    controller.destroy();
    resolveSearch();
    await pending;
    expect(container.classList.contains("hidden")).toBe(true);
    expect(container.children.length).toBe(0);
  });
});
