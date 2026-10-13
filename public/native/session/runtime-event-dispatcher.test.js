import { describe, expect, it, vi } from "vitest";
import { setupRuntimeEventDispatcher } from "./runtime-event-dispatcher.js";

describe("setupRuntimeEventDispatcher", () => {
  it("dispatches workflow host events as CustomEvent on window and aborts foreground run", () => {
    let subscriber = null;
    const runtime = {
      subscribe: (fn) => {
        subscriber = fn;
      },
      request: vi.fn().mockResolvedValue({}),
    };
    const cancelForeground = vi.fn();

    const dispatcher = setupRuntimeEventDispatcher({
      runtime,
      config: {},
      oauthGateway: { consumeFrame: () => false },
      subagentRuns: { applyEvent: () => false },
      taskCompletionNotifications: { handleRuntimeFrame: vi.fn() },
      turnTrace: { handleRuntimeFrame: vi.fn() },
      queuedMessages: document.createElement("div"),
      abortButton: document.createElement("button"),
      messageRenderer: {},
      toolRenderer: {},
      todoMirrorPanel: {},
      extensionUi: { cancelForeground },
      convNav: {},
      contextUsage: {},
      chatHistory: {},
      workspacePanels: {},
      infoPanelController: {},
      costAndCompaction: {},
      superAgentController: {},
      sessionHydration: {},
      sessionSwitching: { getSidebar: () => null },
      getTarget: () => ({ workspaceId: "ws-1", sessionId: "s-1", instanceId: "i-1" }),
      getStore: () => ({ lifecycle: "idle", queue: [] }),
      setStore: vi.fn(),
      getCurrentModelContextWindow: () => 200000,
      setStatus: vi.fn(),
      t: (key) => key,
      showError: vi.fn(),
    });

    const received = [];
    window.addEventListener("pipline:workflow-host-event", (event) => received.push(event.detail));
    subscriber({ type: "workflow_changed", workflowId: "wf-1" });
    expect(received).toEqual([{ type: "workflow_changed", workflowId: "wf-1" }]);

    dispatcher.abortCurrentRun();
    expect(runtime.request).toHaveBeenCalledWith(
      { type: "abort" },
      { workspaceId: "ws-1", sessionId: "s-1", instanceId: "i-1" },
    );
    expect(cancelForeground).toHaveBeenCalledTimes(1);
  });
});
