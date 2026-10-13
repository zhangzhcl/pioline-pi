import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { activeAtMention, buildAtMentionValue, setupAtFileMention } from "./at-file-mention.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

function setCaret(input, index) {
  input.setSelectionRange(index, index);
}

function canned(items) {
  return vi.fn(async () => ({ items, truncated: false }));
}

describe("at-file-mention token parsing and insertion", () => {
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

  test("insert adds a built mention at the caret and closes the popup", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([]),
    });
    input.value = "review ";
    setCaret(input, 7);
    controller.insert(buildAtMentionValue("src/a.ts", false), false);
    expect(input.value).toBe("review @src/a.ts ");
    expect(input.selectionStart).toBe(input.value.length);
    expect(container.classList.contains("hidden")).toBe(true);
    controller.destroy();
  });

  test("insert replaces an active @ token instead of appending", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([]),
    });
    input.value = "@oldtail";
    setCaret(input, 8);
    controller.insert(buildAtMentionValue("src/a.ts", false), false);
    expect(input.value).toBe("@src/a.ts ");
    controller.destroy();
  });

  test("insert drops a directory inside a quoted value with no trailing space", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([]),
    });
    input.value = "";
    setCaret(input, 0);
    controller.insert(buildAtMentionValue("my folder", true), true);
    expect(input.value).toBe('@"my folder/"');
    expect(input.selectionStart).toBe(input.value.length - 1);
    controller.destroy();
  });

  test("buildAtMentionValue quotes spaces, slashes directories, and skips quotes otherwise", () => {
    expect(buildAtMentionValue("src/a.ts", false)).toBe("@src/a.ts");
    expect(buildAtMentionValue("src", true)).toBe("@src/");
    expect(buildAtMentionValue("my folder/f.ts", false)).toBe('@"my folder/f.ts"');
  });

  test("recognizes an @ token only at a supported boundary", () => {
    input.value = "@src/a";
    setCaret(input, 6);
    expect(activeAtMention(input)).toEqual({ prefix: "@src/a", start: 0, end: 6 });

    input.value = "name@host";
    setCaret(input, 9);
    expect(activeAtMention(input)).toBeNull();

    input.value = "see @foo";
    setCaret(input, 8);
    expect(activeAtMention(input).prefix).toBe("@foo");

    input.value = "@foo bar";
    setCaret(input, 8);
    expect(activeAtMention(input)).toBeNull();
  });

  test("localizes the popup aria label from i18n", () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([]),
    });
    expect(container.getAttribute("aria-label")).toBe(enMessages.fileMention.listLabel);
    controller.destroy();
  });

  test("does not duplicate a closing quote that already follows the cursor", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        {
          value: '@"dir/file.ts"',
          label: "file.ts",
          description: "dir/file.ts",
          isDirectory: false,
        },
      ]),
    });
    input.value = '@"dir/f"';
    setCaret(input, 7);
    await controller.update();
    controller.select(0);
    expect(input.value).toBe('@"dir/file.ts" ');
    expect(input.value).not.toContain('""');
    controller.destroy();
  });

  test("falls back to direct replacement when setRangeText throws", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@src/a.ts", label: "a.ts", description: "src/a.ts", isDirectory: false },
      ]),
    });
    input.value = "@src/a tail";
    setCaret(input, 6);
    input.setRangeText = () => {
      throw new Error("unsupported");
    };
    await controller.update();
    controller.select(0);
    expect(input.value).toBe("@src/a.ts  tail");
    expect(input.selectionStart).toBe("@src/a.ts ".length);
    controller.destroy();
  });

  test("closing the menu aborts the in-flight request", async () => {
    let resolveSearch;
    const searchFiles = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSearch = () => resolve({ items: [], truncated: false });
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
    controller.close();
    resolveSearch();
    await pending;
    expect(container.classList.contains("hidden")).toBe(true);
    controller.destroy();
  });

  test("keeps a quoted path with spaces active and never crosses a newline", () => {
    input.value = '@"my folder/f';
    setCaret(input, 14);
    expect(activeAtMention(input).prefix).toBe('@"my folder/f');

    input.value = "line one\n@src/a";
    setCaret(input, input.value.length);
    expect(activeAtMention(input).prefix).toBe("@src/a");

    input.value = "line one\n@src a";
    setCaret(input, input.value.length);
    expect(activeAtMention(input)).toBeNull();
  });

  test("inserts a file candidate with a trailing space and correct caret", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@src/a.ts", label: "a.ts", description: "src/a.ts", isDirectory: false },
      ]),
    });
    input.value = "@src/a";
    setCaret(input, 6);
    await controller.update();
    controller.select(0);
    expect(input.value).toBe("@src/a.ts ");
    expect(input.selectionStart).toBe("@src/a.ts ".length);
    controller.destroy();
  });

  test("inserts a directory candidate with no trailing space", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@src/", label: "src/", description: "src", isDirectory: true },
      ]),
    });
    input.value = "@sr";
    setCaret(input, 3);
    await controller.update();
    controller.select(0);
    expect(input.value).toBe("@src/");
    controller.destroy();
  });

  test("leaves the caret inside a quoted directory so typing can continue", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: '@"my dir/"', label: "dir/", description: "my dir", isDirectory: true },
      ]),
    });
    input.value = '@"my d';
    setCaret(input, 6);
    await controller.update();
    controller.select(0);
    expect(input.value).toBe('@"my dir/"');
    expect(input.selectionStart).toBe(input.value.length - 1);
    controller.destroy();
  });

  test("preserves any text after the replaced token and fires an input event", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@src/a.ts", label: "a.ts", description: "src/a.ts", isDirectory: false },
      ]),
    });
    input.value = "@src/axy";
    setCaret(input, 6);
    await controller.update();
    const spy = vi.fn();
    input.addEventListener("input", spy);
    controller.select(0);
    expect(input.value).toBe("@src/a.ts xy");
    expect(spy).toHaveBeenCalled();
    controller.destroy();
  });
});
