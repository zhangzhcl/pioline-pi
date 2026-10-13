import { describe, expect, it, vi } from "vitest";
import { setupWorkflowModeController } from "./workflow-mode-controller.js";

describe("setupWorkflowModeController", () => {
  it("skips opening workflow mode when prompt does not explicitly request a workflow", async () => {
    const preferences = { get: vi.fn() };
    const controller = setupWorkflowModeController({
      button: null,
      input: document.createElement("textarea"),
      sendButton: document.createElement("button"),
      control: {},
      preferences,
      runtime: {},
      getTarget: () => ({ workspaceId: "ws-1", sessionId: "s-1", instanceId: "i-1" }),
      getPiBusy: () => false,
      getModel: () => null,
      t: (key) => key,
      showError: vi.fn(),
    });

    await controller.ensureWorkflowModeForPrompt("explain how this function works");
    expect(preferences.get).not.toHaveBeenCalled();
  });

  it("notifies standalone workflow window when target switches", () => {
    const invoke = vi.fn();
    globalThis.__TAURI__ = { core: { invoke } };
    try {
      const controller = setupWorkflowModeController({
        button: null,
        input: document.createElement("textarea"),
        sendButton: document.createElement("button"),
        control: {},
        preferences: { get: vi.fn() },
        runtime: {},
        getTarget: () => ({ workspaceId: "ws-1", sessionId: "s-1", instanceId: "i-1" }),
        getPiBusy: () => false,
        getModel: () => null,
        t: (key) => key,
        showError: vi.fn(),
      });

      const nextTarget = { workspaceId: "ws-2", sessionId: "s-2", instanceId: "i-2" };
      controller.syncTargetOnSwitch(nextTarget);
      expect(invoke).toHaveBeenCalledWith("update_workflow_window_target", {
        workspaceId: "ws-2",
        target: nextTarget,
      });
    } finally {
      delete globalThis.__TAURI__;
    }
  });
});
