import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupWorkflowWindowBridge } from "./workflow-window-bridge.js";

describe("workflow-window-bridge", () => {
  let input;
  let sendButton;
  let composerAutoResize;
  let t;
  let getTarget;
  let getPreferences;
  let showError;
  let invoke;
  let fakeWindow;
  let fakeDocument;
  let windowListeners;
  let docElements;

  beforeEach(() => {
    windowListeners = {};
    docElements = {};

    fakeWindow = {
      addEventListener: vi.fn((event, handler) => {
        windowListeners[event] = handler;
      }),
      removeEventListener: vi.fn((event) => {
        delete windowListeners[event];
      }),
      dispatchEvent: vi.fn((event) => {
        if (windowListeners[event.type]) {
          windowListeners[event.type](event);
        }
      }),
    };

    fakeDocument = {
      getElementById: vi.fn((id) => docElements[id] || null),
    };

    input = { value: "", disabled: false, focus: vi.fn() };
    sendButton = { disabled: false };
    composerAutoResize = { sync: vi.fn() };
    t = vi.fn((key) => key);
    getTarget = vi.fn(() => ({ workspaceId: "ws-1", sessionId: "sess-1" }));
    getPreferences = vi.fn(() => ({
      get: vi.fn().mockResolvedValue("wf-1"),
    }));
    showError = vi.fn();
    invoke = vi.fn().mockResolvedValue(undefined);
  });

  it("handles workflow run lock and unlock", () => {
    setupWorkflowWindowBridge({
      input,
      sendButton,
      windowTarget: fakeWindow,
      documentTarget: fakeDocument,
    });

    // Lock
    fakeWindow.dispatchEvent(
      new CustomEvent("pipline:workflow-run-lock", { detail: { running: true } }),
    );
    expect(input.disabled).toBe(true);
    expect(sendButton.disabled).toBe(true);

    // Unlock
    fakeWindow.dispatchEvent(
      new CustomEvent("pipline:workflow-run-lock", { detail: { running: false } }),
    );
    expect(input.disabled).toBe(false);
    expect(sendButton.disabled).toBe(false);
  });

  it("appends workflow context to chat input", () => {
    input.value = "Hello";
    setupWorkflowWindowBridge({
      input,
      sendButton,
      composerAutoResize,
      formatWorkflowChatContext: (summary) => `Context: ${summary.text}`,
      windowTarget: fakeWindow,
      documentTarget: fakeDocument,
    });

    fakeWindow.dispatchEvent(
      new CustomEvent("pipline:workflow-context", {
        detail: { summary: { text: "Run node #1 done" } },
      }),
    );

    expect(input.value).toBe("Hello\n\nContext: Run node #1 done");
    expect(composerAutoResize.sync).toHaveBeenCalled();
    expect(input.focus).toHaveBeenCalled();
  });

  it("sends workflow context request via Tauri invoke", async () => {
    setupWorkflowWindowBridge({
      input,
      sendButton,
      getTarget,
      invoke,
      windowTarget: fakeWindow,
      documentTarget: fakeDocument,
    });

    fakeWindow.dispatchEvent(
      new CustomEvent("pipline:workflow-context-request", {
        detail: { summary: { node: "test" } },
      }),
    );

    expect(invoke).toHaveBeenCalledWith("send_workflow_context", {
      workspaceId: "ws-1",
      summary: { node: "test" },
    });
  });

  it("updates panel classes on workflow window open, close, and hide", () => {
    const workflowPanel = {
      classList: {
        classes: new Set(),
        add(c) {
          this.classes.add(c);
        },
        remove(c) {
          this.classes.delete(c);
        },
        contains(c) {
          return this.classes.has(c);
        },
      },
    };
    const modeToggle = { setAttribute: vi.fn() };
    docElements["workflow-panel"] = workflowPanel;
    docElements["workflow-mode-toggle"] = modeToggle;

    setupWorkflowWindowBridge({
      windowTarget: fakeWindow,
      documentTarget: fakeDocument,
    });

    fakeWindow.dispatchEvent(new CustomEvent("pipline:workflow-window-opened"));
    expect(workflowPanel.classList.contains("is-detached")).toBe(true);

    fakeWindow.dispatchEvent(new CustomEvent("pipline:workflow-window-closed"));
    expect(workflowPanel.classList.contains("is-detached")).toBe(false);
    expect(modeToggle.setAttribute).toHaveBeenCalledWith("aria-expanded", "true");
  });

  it("opens workflow window on open button click", async () => {
    let clickHandler;
    const openBtn = {
      addEventListener: vi.fn((event, handler) => {
        if (event === "click") clickHandler = handler;
      }),
      removeEventListener: vi.fn(),
    };
    docElements["workflow-open-window"] = openBtn;

    setupWorkflowWindowBridge({
      getTarget,
      getPreferences,
      showError,
      invoke,
      t,
      windowTarget: fakeWindow,
      documentTarget: fakeDocument,
    });

    await clickHandler();

    expect(invoke).toHaveBeenCalledWith("open_workflow_window", {
      workspaceId: "ws-1",
      workflowId: "wf-1",
      target: { workspaceId: "ws-1", sessionId: "sess-1" },
    });
    expect(fakeWindow.dispatchEvent).toHaveBeenCalled();
  });

  it("cleans up event listeners on destroy", () => {
    const bridge = setupWorkflowWindowBridge({
      windowTarget: fakeWindow,
      documentTarget: fakeDocument,
    });

    bridge.destroy();
    expect(fakeWindow.removeEventListener).toHaveBeenCalledWith(
      "pipline:workflow-run-lock",
      expect.any(Function),
    );
    expect(fakeWindow.removeEventListener).toHaveBeenCalledWith(
      "pipline:workflow-context",
      expect.any(Function),
    );
  });
});
