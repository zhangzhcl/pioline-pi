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

describe("FilePreviewPanel — layout, save, conflicts, and tabs", () => {
  test("enlarge adds enlarged class", () => {
    const p = createPanel();
    p.enlarge();
    expect(panel.classList.contains("enlarged")).toBe(true);
    expect(panel.classList.contains("collapsed")).toBe(false);
    p.destroy();
  });

  test("collapse removes enlarged class", () => {
    const p = createPanel();
    p.enlarge();
    p.collapse();
    expect(panel.classList.contains("enlarged")).toBe(false);
    p.destroy();
  });

  test("closePanel collapses panel", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    p.closePanel();
    expect(panel.classList.contains("collapsed")).toBe(true);
    p.destroy();
  });

  test("closePanel preserves tabs (not closing them)", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    p.closePanel();
    expect(p.state.getTabs().length).toBe(1);
    p.destroy();
  });

  test("does not close a dirty tab when confirmation is cancelled", async () => {
    const confirmDirty = vi.fn(async () => "cancel");
    const p = createPanel({ confirmDirty });
    await p.openFile("/test/workspace/main.js");
    const tab = p.state.getActiveTab();
    p.currentRenderer.getEditor().setValue("changed\n");

    const closed = await p._closeTab(tab.id);

    expect(closed).toBe(false);
    expect(confirmDirty).toHaveBeenCalledOnce();
    expect(p.state.getTab(tab.id)).not.toBeNull();
    p.destroy();
  });

  test("edit control switches an editable text tab into edit mode", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/main.js");

    document.getElementById("file-preview-mode-edit").click();
    await Promise.resolve();

    expect(p.state.getActiveTab()?.mode).toBe("edit");
    expect(content.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
    p.destroy();
  });

  test("keeps edits made while a save request is in flight dirty", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/main.js");
    const tab = p.state.getActiveTab();
    p.state.updateTab(tab.id, { content: "first edit\n", dirty: true });
    let resolveSave;
    global.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    const saving = p._saveTab(tab.id);
    p.state.updateTab(tab.id, { content: "second edit\n", dirty: true });
    resolveSave({
      ok: true,
      status: 200,
      json: async () => ({ mtimeMs: 1700000001000 }),
    });
    await saving;

    expect(p.state.getTab(tab.id)?.content).toBe("second edit\n");
    expect(p.state.getTab(tab.id)?.originalContent).toBe("first edit\n");
    expect(p.state.getTab(tab.id)?.dirty).toBe(true);
    p.destroy();
  });

  test("explicit save can overwrite after a conflict decision", async () => {
    const resolveConflict = vi.fn(async () => "overwrite");
    const p = createPanel({ resolveConflict });
    await p.openFile("/test/workspace/main.js");
    const tab = p.state.getActiveTab();
    p.state.updateTab(tab.id, { content: "updated\n", dirty: true });
    const requests = [];
    global.fetch = vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) {
        return { ok: false, status: 409, json: async () => ({ error: "conflict" }) };
      }
      return { ok: true, status: 200, json: async () => ({ mtimeMs: 1700000002000 }) };
    });

    const saved = await p._saveTab(tab.id);

    expect(saved).toBe(true);
    expect(resolveConflict).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[1].force).toBe(true);
    expect(p.state.getTab(tab.id)?.dirty).toBe(false);
    expect(p.state.getTab(tab.id)?.conflict).toBe(false);
    p.destroy();
  });

  test("tab bar renders file names", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/main.js");
    const tabName = tabBar.querySelector(".file-preview-tab-name");
    expect(tabName).not.toBeNull();
    expect(tabName.textContent).toBe("main.js");
    p.destroy();
  });

  test("tabs and splitter expose keyboard interactions", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/a.js");
    await p.openFile("/test/workspace/b.js");
    const firstTab = tabBar.querySelector('[data-tab-id="file:/test/workspace/a.js"]');

    expect(firstTab?.getAttribute("role")).toBe("tab");
    expect(firstTab?.getAttribute("tabindex")).toBe("0");
    firstTab?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    expect(p.state.getActiveTab()?.filePath).toBe("/test/workspace/a.js");

    const initialRatio = p.panelRatio;
    resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(p.panelRatio).toBeGreaterThan(initialRatio);
    expect(resizer.getAttribute("aria-valuenow")).not.toBeNull();
    p.destroy();
  });

  test("tab bar renders close buttons", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/main.js");
    const closeBtn = tabBar.querySelector(".file-preview-tab-close");
    expect(closeBtn).not.toBeNull();
    p.destroy();
  });

  test("setWorkspaceRoot loads persisted tabs", () => {
    const tabsData = {
      byRoot: {
        "/test/workspace": {
          tabs: [
            {
              id: "file:/test/workspace/persisted.js",
              kind: "file",
              filePath: "/test/workspace/persisted.js",
              fileName: "persisted.js",
              mode: "preview",
            },
          ],
          activeTabId: "file:/test/workspace/persisted.js",
          touchedAt: Date.now(),
        },
      },
    };

    const { FileTabState } = require("./file-tab-state.js");
    const memStorage = new Map();
    memStorage.set("picot-file-tabs", JSON.stringify(tabsData));
    const state = new FileTabState({
      storage: {
        getItem: (k) => memStorage.get(k) ?? null,
        setItem: (k, v) => memStorage.set(k, v),
        removeItem: (k) => memStorage.delete(k),
      },
    });
    state.load("/test/workspace");
    expect(state.getTabs().length).toBe(1);
    expect(state.getTabs()[0].fileName).toBe("persisted.js");
  });

  test("destroy cleans up renderer", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    p.destroy();
    expect(content.querySelectorAll(".cm-editor").length).toBe(0);
  });
});

describe("FilePreviewPanel close and visibility", () => {
  test("getCloseRisk reports dirty file tabs with a monotonic version", () => {
    const p = createPanel();
    const first = p.getCloseRisk();
    expect(first.version).toBeGreaterThan(0);
    expect(Array.isArray(first.dirtyFiles)).toBe(true);
    p.destroy();
  });

  test("showPanel / hidePanel toggle the collapsed state", () => {
    const p = createPanel();
    p.showPanel();
    expect(panel.classList.contains("collapsed")).toBe(false);
    p.hidePanel();
    expect(panel.classList.contains("collapsed")).toBe(true);
    p.destroy();
  });

  test("closing the last file tab closes the panel", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/main.js");

    await p._closeTab(p.state.getActiveTab().id);

    expect(panel.classList.contains("collapsed")).toBe(true);
    p.destroy();
  });
});

describe("FilePreviewPanel workspace restore", () => {
  function seededStorage(seed) {
    const memStorage = new Map();
    memStorage.set("picot-file-tabs", JSON.stringify(seed));
    return {
      getItem: (k) => memStorage.get(k) ?? null,
      setItem: (k, v) => memStorage.set(k, String(v)),
      removeItem: (k) => memStorage.delete(k),
    };
  }

  test("does not flash the panel open when restored content fails to load", async () => {
    const storage = seededStorage({
      byRoot: {
        "/ws/a": {
          tabs: [
            {
              id: "file:/ws/a/missing.js",
              kind: "file",
              filePath: "/ws/a/missing.js",
              fileName: "missing.js",
              mode: "edit",
            },
          ],
          activeTabId: "file:/ws/a/missing.js",
          touchedAt: Date.now(),
        },
      },
    });
    const p = createPanel({ storage });
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    }));

    expect(panel.classList.contains("collapsed")).toBe(true);
    await p.setWorkspaceRoot("/ws/a");

    expect(panel.classList.contains("collapsed")).toBe(true);
    expect(p.state.getTabs().length).toBe(1);
    p.destroy();
  });

  test("opens the panel when restored content loads successfully", async () => {
    const storage = seededStorage({
      byRoot: {
        "/ws/a": {
          tabs: [
            {
              id: "file:/ws/a/real.js",
              kind: "file",
              filePath: "/ws/a/real.js",
              fileName: "real.js",
              mode: "edit",
            },
          ],
          activeTabId: "file:/ws/a/real.js",
          touchedAt: Date.now(),
        },
      },
    });
    const p = createPanel({ storage });
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: "real content\n", mtimeMs: 1 }),
    }));

    await p.setWorkspaceRoot("/ws/a");

    expect(panel.classList.contains("collapsed")).toBe(false);
    p.destroy();
  });

  test("hasPersistedTabs peeks storage without switching state", () => {
    const storage = seededStorage({
      byRoot: {
        "/ws/a": {
          tabs: [
            {
              id: "file:/ws/a/peek.js",
              kind: "file",
              filePath: "/ws/a/peek.js",
              fileName: "peek.js",
              mode: "edit",
            },
          ],
          activeTabId: "file:/ws/a/peek.js",
          touchedAt: Date.now(),
        },
      },
    });
    const p = createPanel({ storage });

    expect(p.hasPersistedTabs("/ws/a")).toBe(true);
    expect(p.hasPersistedTabs("/ws/empty")).toBe(false);
    expect(p.state.getTabs().length).toBe(0);
    p.destroy();
  });
});
