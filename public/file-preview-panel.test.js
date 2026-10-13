import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FilePreviewPanel } from "./file-preview-panel.js";
import { initI18n } from "./i18n.js";

let panel, resizer, tabBar, content, mainContainer;

beforeEach(async () => {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  global.fetch = vi.fn((url) => {
    if (String(url).includes("/locales/")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          messages: { copied: "Copied!" },
          nav: {},
          git: {
            diffOriginal: "Original",
            diffModified: "Modified",
            diffEmpty: "No changes",
            comparison: {
              changes: "Changes",
              staged: "Staged",
            },
          },
          files: {
            preview: {
              close: "Close",
              conflict: "File modified externally",
              copyFailed: "Copy failed",
              loadError: "Failed to load file",
              loading: "Loading…",
              htmlLive: "Live HTML preview",
              readOnly: "Read-only",
              saveError: "Failed to save file",
              saved: "Saved",
              saving: "Saving…",
              unsupportedBinary: "Unsupported binary",
              markitdown: {
                pythonMissing: "Install Python 3.10 or later to preview this file.",
                pythonTooOld: "Python {version} is too old. Install Python 3.10 or later.",
                markitdownMissing: "Install MarkItDown to preview this file.",
                markitdownIncompatible:
                  "Update MarkItDown to a version that supports stdin conversion.",
                installPosix: "python3 -m pip install markitdown",
                installWindows: "py -3 -m pip install markitdown",
              },
            },
            unsaved: { title: "Unsaved changes" },
          },
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ content: "# Test\n", mtimeMs: 1700000000000 }),
    });
  });

  await initI18n();

  document.body.replaceChildren();
  mainContainer = document.createElement("div");
  mainContainer.className = "main";
  mainContainer.style.width = "800px";
  document.body.appendChild(mainContainer);

  panel = document.createElement("section");
  panel.className = "file-preview-panel collapsed";
  panel.id = "file-preview-panel";
  document.body.appendChild(panel);

  resizer = document.createElement("div");
  resizer.className = "file-preview-resizer collapsed";
  resizer.id = "file-preview-resizer";
  document.body.appendChild(resizer);

  tabBar = document.createElement("div");
  tabBar.className = "file-preview-tabs";
  tabBar.id = "file-preview-tabs";
  document.body.appendChild(tabBar);

  content = document.createElement("div");
  content.className = "file-preview-content";
  content.id = "file-preview-content";
  document.body.appendChild(content);

  const enlargeBtn = document.createElement("button");
  enlargeBtn.id = "file-preview-enlarge";
  enlargeBtn.className = "hidden";
  document.body.appendChild(enlargeBtn);

  const collapseBtn = document.createElement("button");
  collapseBtn.id = "file-preview-collapse";
  document.body.appendChild(collapseBtn);

  const closeBtn = document.createElement("button");
  closeBtn.id = "file-preview-close";
  document.body.appendChild(closeBtn);

  const toolbar = document.createElement("div");
  toolbar.id = "file-preview-toolbar";
  document.body.appendChild(toolbar);
  for (const id of [
    "file-preview-toolbar-toggle",
    "file-preview-mode-preview",
    "file-preview-mode-edit",
    "file-preview-save",
    "file-preview-reload",
    "file-preview-search",
    "file-preview-go-to-line",
    "file-preview-copy",
  ]) {
    const button = document.createElement("button");
    button.id = id;
    document.body.appendChild(button);
  }
  const goToLineInput = document.createElement("input");
  goToLineInput.id = "file-preview-go-to-line-input";
  goToLineInput.className = "hidden";
  document.body.appendChild(goToLineInput);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function createPanel(options = {}) {
  const storedValues = new Map();
  return new FilePreviewPanel({
    panel,
    resizer,
    tabBar,
    content,
    mainContainer,
    workspaceRoot: "/test/workspace",
    storage: {
      getItem: (key) => storedValues.get(key) ?? null,
      setItem: (key, value) => storedValues.set(key, String(value)),
      removeItem: (key) => storedValues.delete(key),
    },
    ...options,
  });
}

describe("FilePreviewPanel — loading, modes, and navigation", () => {
  test("revealWrite returns null for a new file instead of forcing the panel open", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ previewStatus: "ready", renderAs: "text", content: "x" }),
      }),
    );
    const p = createPanel();
    const tab = await p.revealWrite("/test/workspace/fresh.md");
    expect(tab).toBeNull();
    expect(p.state.getTabs()).toHaveLength(0);
    p.destroy();
  });

  test("revealWrite silently reloads a clean tab without stealing focus", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ previewStatus: "ready", renderAs: "text", content: "v1" }),
      }),
    );
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    await p.openFile("/test/workspace/other.md");
    const activeId = p.state.getActiveTab().id;
    let calls = 0;
    global.fetch = vi.fn(() => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        json: async () => ({ previewStatus: "ready", renderAs: "text", content: "v2" }),
      });
    });

    const reloaded = await p.revealWrite("/test/workspace/README.md");

    expect(p.state.getTabs()).toHaveLength(2);
    expect(p.state.getActiveTab().id).toBe(activeId);
    expect(reloaded.filePath).toBe("/test/workspace/README.md");
    expect(calls).toBeGreaterThan(0);
    p.destroy();
  });

  test("renders converted responses as read-only Markdown", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          previewStatus: "ready",
          renderAs: "markdown",
          content: "# Converted",
          editable: false,
        }),
      }),
    );
    const p = createPanel();
    await p.openFile("/test/workspace/mail.eml");
    expect(p.state.getActiveTab()).toMatchObject({
      editable: false,
      mode: "preview",
      renderAs: "markdown",
    });
    expect(content.querySelector(".file-markdown-preview")).not.toBeNull();
    expect(document.getElementById("file-preview-mode-edit").disabled).toBe(true);
    p.destroy();
  });

  test("maps an old Python dependency response to localized guidance", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          previewStatus: "dependencyUnavailable",
          dependencyReason: "pythonTooOld",
          pythonVersion: "3.9.7",
          editable: false,
        }),
      }),
    );
    const p = createPanel();
    await p.openFile("/test/workspace/report.docx");
    expect(content.textContent).toContain("Python 3.9.7 is too old");
    expect(content.textContent).not.toContain("stderr");
    p.destroy();
  });

  test("starts collapsed", () => {
    const p = createPanel();
    expect(panel.classList.contains("collapsed")).toBe(true);
    p.destroy();
  });

  test("openFile opens panel and creates tab", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    expect(panel.classList.contains("collapsed")).toBe(false);
    expect(tabBar.children.length).toBe(1);
    p.destroy();
  });

  test("opens source code files in edit mode by default", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/example.js");
    expect(p.state.getActiveTab()?.mode).toBe("edit");
    p.destroy();
  });

  test("opens markdown files in preview mode by default", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    expect(p.state.getActiveTab()?.mode).toBe("preview");
    p.destroy();
  });

  test("opens HTML files in live preview mode by default", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/index.html");
    expect(p.state.getActiveTab()?.mode).toBe("preview");
    expect(content.querySelector("iframe.file-html-frame")).not.toBeNull();
    p.destroy();
  });

  test("revealWrite reloads a clean tab and leaves a dirty tab unsaved", async () => {
    let contents = ["<p>one</p>", "<p>two</p>"];
    const p = createPanel({
      fileApi: {
        readFileContent: async () => ({
          ok: true,
          json: async () => ({ content: contents.shift() ?? "<p>two</p>", mtimeMs: 1 }),
        }),
      },
    });
    await p.openFile("index.html");
    expect(p.state.getActiveTab()?.content).toBe("<p>one</p>");
    await p.revealWrite("index.html");
    expect(p.state.getActiveTab()?.content).toBe("<p>two</p>");
    expect(p.state.getActiveTab()?.dirty).toBe(false);

    p.state.updateTab(p.state.getActiveTab().id, { dirty: true, content: "<p>local</p>" });
    contents = ["<p>disk</p>"];
    await p.revealWrite("index.html");
    expect(p.state.getActiveTab()?.content).toBe("<p>local</p>");
    expect(p.state.getActiveTab()?.dirty).toBe(true);
    p.destroy();
  });

  test("uses the inline line input to navigate and then restores the button", () => {
    const p = createPanel();
    const goToLine = document.getElementById("file-preview-go-to-line");
    const input = document.getElementById("file-preview-go-to-line-input");
    const renderer = { destroy: vi.fn(), goToLine: vi.fn(() => true) };
    const tab = p.state.openFile("/test/workspace/example.js");
    p.state.updateTab(tab.id, { content: "line one\nline two\n" });
    p.currentRenderer = renderer;
    goToLine.disabled = false;
    vi.spyOn(window, "prompt").mockReturnValue(null);

    goToLine.click();

    expect(input.classList.contains("hidden")).toBe(false);

    input.value = "2";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(renderer.goToLine).toHaveBeenCalledWith(2);
    expect(input.classList.contains("hidden")).toBe(true);
    expect(goToLine.classList.contains("hidden")).toBe(false);
    p.destroy();
  });

  test("opening the same file selects it without reloading or losing dirty content", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    const tab = p.state.getActiveTab();
    p.state.updateTab(tab.id, { content: "# Unsaved\n", dirty: true });

    await p.openFile("/test/workspace/README.md");

    const contentCalls = global.fetch.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/files/content"),
    );
    expect(contentCalls).toHaveLength(1);
    expect(p.state.getActiveTab()?.content).toBe("# Unsaved\n");
    expect(p.state.getActiveTab()?.dirty).toBe(true);
    expect(tabBar.children).toHaveLength(1);
    p.destroy();
  });

  test("opening multiple files creates multiple tabs", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/a.js");
    await p.openFile("/test/workspace/b.js");
    expect(tabBar.children.length).toBe(2);
    p.destroy();
  });

  test("uses the server-discovered Python command in dependency guidance", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          previewStatus: "dependencyUnavailable",
          dependencyReason: "markitdownMissing",
          displayCommand: "python",
          editable: false,
        }),
      }),
    );
    const p = createPanel();
    await p.openFile("/test/workspace/report.docx");
    expect(content.textContent).toContain("python -m pip install");
    expect(content.textContent).not.toContain("python3 -m pip install");
    p.destroy();
  });

  test("aborts the old load when switching tabs and reloads it when selected again", async () => {
    const pending = new Map();
    global.fetch = vi.fn((url, options) => {
      const entry = { options, resolve: null };
      const promise = new Promise((resolve) => {
        entry.resolve = resolve;
      });
      pending.set(String(url), entry);
      return promise;
    });
    const p = createPanel();
    const first = p.openFile("/test/workspace/a.docx");
    const firstRequest = pending.get("/api/files/content?path=%2Ftest%2Fworkspace%2Fa.docx");
    const second = p.openFile("/test/workspace/b.docx");
    expect(firstRequest.options.signal.aborted).toBe(true);
    firstRequest.resolve({ ok: true, json: async () => ({ content: "stale" }) });
    pending.get("/api/files/content?path=%2Ftest%2Fworkspace%2Fb.docx").resolve({
      ok: true,
      json: async () => ({ content: "b" }),
    });
    await second;
    await first;
    const aTab = p.state.getTab("file:/test/workspace/a.docx");
    expect(aTab.content).toBeNull();
    const select = tabBar.querySelector('[data-tab-id="file:/test/workspace/a.docx"]');
    select.click();
    await Promise.resolve();
    expect(global.fetch).toHaveBeenCalledTimes(3);
    p.destroy();
  });

  test("finishes independent loads when files resolve out of order", async () => {
    const pending = new Map();
    global.fetch = vi.fn(
      (url) =>
        new Promise((resolve) => {
          pending.set(String(url), resolve);
        }),
    );
    const p = createPanel();

    const firstLoad = p.openFile("/test/workspace/a.js");
    const secondLoad = p.openFile("/test/workspace/b.js");
    pending.get("/api/files/content?path=%2Ftest%2Fworkspace%2Fb.js")({
      ok: true,
      json: async () => ({ content: "const b = 1;\n", mtimeMs: 2 }),
    });
    await secondLoad;
    pending.get("/api/files/content?path=%2Ftest%2Fworkspace%2Fa.js")({
      ok: true,
      json: async () => ({ content: "const a = 1;\n", mtimeMs: 1 }),
    });
    await firstLoad;

    expect(p.state.getTab("file:/test/workspace/a.js")?.loading).toBe(false);
    expect(p.state.getTab("file:/test/workspace/a.js")?.content).toBe("const a = 1;\n");
    expect(p.state.getTab("file:/test/workspace/b.js")?.content).toBe("const b = 1;\n");
    expect(p.state.getActiveTab()?.filePath).toBe("/test/workspace/b.js");
    p.destroy();
  });
});

describe("FilePreviewPanel git diff tabs", () => {
  test("openDiff mounts a diff renderer and sets activeContent", () => {
    const p = createPanel();
    const id = p.openDiff({
      displayPath: "src/main.js",
      comparison: "changes",
      rawPatch:
        "--- a/src/main.js\n+++ b/src/main.js\n@@ -1,1 +1,2 @@\n-old line\n+new line\n+added line",
    });

    expect(id).toBe("git-diff");
    expect(p.activeContent).toEqual({ kind: "diff", id: "git-diff" });
    expect(p.diffTabs.has("git-diff")).toBe(true);
    expect(content.children.length).toBeGreaterThan(0);
    expect(panel.classList.contains("collapsed")).toBe(false);
    p.destroy();
  });

  test("closeDiffTab removes the tab and deactivates", () => {
    const p = createPanel();
    p.openDiff({
      displayPath: "src/main.js",
      comparison: "changes",
      rawPatch: "test patch",
    });

    expect(p.diffTabs.size).toBe(1);
    const result = p.closeDiffTab("git-diff");
    expect(result).toBe(true);
    expect(p.diffTabs.has("git-diff")).toBe(false);
    p.destroy();
  });

  test("openDiff renders a diff tab in the tab bar", () => {
    const p = createPanel();
    p.openDiff({
      displayPath: "src/app.ts",
      comparison: "staged",
      rawPatch: "test",
    });

    const diffTab = tabBar.querySelector('[data-diff-id="git-diff"]');
    expect(diffTab).not.toBeNull();
    expect(diffTab.classList.contains("diff-tab")).toBe(true);
    p.destroy();
  });
});
