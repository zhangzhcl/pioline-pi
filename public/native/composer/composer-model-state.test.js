import { describe, expect, it, vi } from "vitest";
import { createComposerModelStateController } from "./composer-model-state.js";

describe("createComposerModelStateController", () => {
  it("updates model and thinking level while persisting session UI profile", () => {
    document.body.innerHTML = `
      <div id="model-dropdown">
        <button id="model-dropdown-btn"><span id="model-dropdown-label"></span></button>
        <div id="model-dropdown-menu"></div>
      </div>
      <button id="thinking-btn"></button>
    `;
    const saveProfile = vi.fn().mockResolvedValue({});
    const setContextWindowSize = vi.fn();

    const controller = createComposerModelStateController({
      modelDropdown: document.getElementById("model-dropdown"),
      modelDropdownBtn: document.getElementById("model-dropdown-btn"),
      modelDropdownLabel: document.getElementById("model-dropdown-label"),
      modelDropdownMenu: document.getElementById("model-dropdown-menu"),
      thinkingBtn: document.getElementById("thinking-btn"),
      runtime: { request: vi.fn() },
      config: { call: vi.fn() },
      contextUsage: { setContextWindowSize },
      sessionUiState: { saveProfile },
      getTarget: () => ({ workspaceId: "ws-1", sessionId: "s-1" }),
      onOpenSettings: vi.fn(),
      onThinkingLevelSelected: vi.fn(),
      t: (k) => k,
      showError: vi.fn(),
    });

    controller.updateComposerModel({
      provider: "anthropic",
      id: "claude-sonnet-4",
      contextWindow: 200000,
    });
    expect(controller.getCurrentModel()).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4",
    });
    expect(controller.getCurrentModelContextWindow()).toBe(200000);
    expect(setContextWindowSize).toHaveBeenCalledWith(200000);
    expect(saveProfile).toHaveBeenCalledWith({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "off",
    });

    controller.updateComposerThinking("high");
    expect(controller.getCurrentThinkingLevel()).toBe("high");
    expect(saveProfile).toHaveBeenLastCalledWith({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "high",
    });

    controller.setPendingModelRestore({ provider: "openai", modelId: "gpt-4o" });
    expect(controller.consumePendingModelRestore()).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
    expect(controller.getPendingModelRestore()).toBeNull();
  });
});
