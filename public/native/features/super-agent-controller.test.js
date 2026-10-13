import { describe, expect, it, vi } from "vitest";
import { setupSuperAgentController } from "./super-agent-controller.js";

describe("setupSuperAgentController", () => {
  it("toggles super-agent-active body class and keeps runtime panel collapsed by default", () => {
    document.body.innerHTML = `
      <div id="super-agent-chat-header" class="hidden"></div>
      <button id="sidebar-agent-inbox-btn" class="hidden"></button>
      <super-agent-runtime></super-agent-runtime>
    `;
    const input = document.createElement("textarea");
    const controller = setupSuperAgentController({
      adapter: {},
      runtime: {},
      input,
      composerAutoResize: { sync: vi.fn() },
      getTarget: () => ({ workspaceId: "ws-1", sessionId: "sa-1", instanceId: "i-1" }),
      getSidebar: () => null,
      switchSession: vi.fn(),
      showError: vi.fn(),
    });

    controller.updateSuperAgentActiveState({
      id: "sa-1",
      projectPath: "/home/user/.pi/agent/super-agent",
      kind: "super-agent",
    });
    expect(document.body.classList.contains("super-agent-active")).toBe(true);
    expect(document.querySelector("super-agent-runtime").classList.contains("collapsed")).toBe(
      true,
    );

    controller.updateSuperAgentActiveState(null);
    expect(document.body.classList.contains("super-agent-active")).toBe(false);
  });
});
