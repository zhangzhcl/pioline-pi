import { describe, expect, it, vi } from "vitest";
import { setupComposerSendController } from "./composer-send-controller.js";

describe("setupComposerSendController", () => {
  it("delegates #claude tasks to subagentRuns without sending a Pi prompt", async () => {
    const input = document.createElement("textarea");
    const form = document.createElement("form");
    const startSubagent = vi.fn().mockResolvedValue(undefined);
    const runtimeRequest = vi.fn();

    const controller = setupComposerSendController({
      input,
      form,
      composerCard: document.createElement("div"),
      attachButton: document.createElement("button"),
      imageInput: document.createElement("input"),
      imagePreviews: document.createElement("div"),
      skillSlashMenu: document.createElement("div"),
      atFileMentionMenu: null,
      commandButton: document.createElement("button"),
      commandPalette: document.createElement("div"),
      commandPaletteOverlay: document.createElement("div"),
      commandList: document.createElement("div"),
      composerAutoResize: { sync: vi.fn() },
      runtime: { request: runtimeRequest },
      config: { call: vi.fn() },
      toolRenderer: { expandAll: vi.fn(), collapseAll: vi.fn() },
      messageRenderer: { renderSystemMessage: vi.fn() },
      commandCompatibility: {
        decorate: (items) => [...items],
        beginCommand: vi.fn(),
        prune: vi.fn(),
      },
      subagentCatalog: {
        parseTask: () => ({
          agent: { id: "claude-code", token: "claude", label: "Claude Code" },
          task: "audit security",
        }),
      },
      subagentRuns: { start: startSubagent },
      ensureWorkflowModeForPrompt: vi.fn(),
      remoteWorkspaceDialog: {},
      getTarget: () => ({ workspaceId: "ws-1", sessionId: "s-1", instanceId: "i-1" }),
      getStore: () => ({ lifecycle: "idle" }),
      clearPendingForkSwitchCheck: vi.fn(),
      t: (key) => key,
      showError: vi.fn(),
    });

    input.value = "#claude audit security";
    await controller.sendComposerInput({ altKey: false });

    expect(startSubagent).toHaveBeenCalledWith("audit security", {
      id: "claude-code",
      token: "claude",
      label: "Claude Code",
    });
    expect(runtimeRequest).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });
});
