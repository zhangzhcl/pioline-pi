import { describe, expect, it, vi } from "vitest";
import {
  findModelContextWindow,
  formatModelName,
  formatThinkingLevelLabel,
  setupComposerModelPicker,
} from "./composer-model-picker.js";

describe("composer-model-picker utils", () => {
  it("formats model names cleanly", () => {
    expect(formatModelName("claude-3-5-sonnet-20241022")).toBe("3-5-sonnet");
    expect(formatModelName({ name: "claude-3-opus" })).toBe("3-opus");
    expect(formatModelName({ id: "gpt-4o" })).toBe("gpt-4o");
    expect(formatModelName(null)).toBe("");
  });

  it("formats thinking level labels with translation fallback", () => {
    const t = (key) => (key === "settings.thinkingLevels.high" ? "高" : key);
    expect(formatThinkingLevelLabel("high", t)).toBe("高");
    expect(formatThinkingLevelLabel("budget", t)).toBe("budget");
    expect(formatThinkingLevelLabel(null, null)).toBe("off");
  });

  it("finds context window size from model list", () => {
    const models = [
      { provider: "anthropic", id: "claude-3-5", contextWindow: 200000 },
      { provider: "openai", id: "gpt-4o", contextWindow: "128000" },
    ];
    expect(findModelContextWindow(models, "anthropic", "claude-3-5")).toBe(200000);
    expect(findModelContextWindow(models, "openai", "gpt-4o")).toBe(128000);
    expect(findModelContextWindow(models, "anthropic", "unknown")).toBe(0);
    expect(findModelContextWindow(null, "anthropic", "claude-3-5")).toBe(0);
  });
});

describe("setupComposerModelPicker", () => {
  function setupTestDom() {
    const modelDropdown = document.createElement("div");
    modelDropdown.id = "model-dropdown";

    const modelDropdownBtn = document.createElement("button");
    modelDropdownBtn.id = "model-dropdown-btn";

    const modelDropdownLabel = document.createElement("span");
    modelDropdownLabel.id = "model-dropdown-label";
    modelDropdownBtn.appendChild(modelDropdownLabel);

    const modelDropdownMenu = document.createElement("div");
    modelDropdownMenu.id = "model-dropdown-menu";
    modelDropdownMenu.className = "hidden";

    modelDropdown.append(modelDropdownBtn, modelDropdownMenu);

    const thinkingBtn = document.createElement("button");
    thinkingBtn.id = "thinking-btn";

    document.body.append(modelDropdown, thinkingBtn);

    return {
      modelDropdown,
      modelDropdownBtn,
      modelDropdownLabel,
      modelDropdownMenu,
      thinkingBtn,
    };
  }

  it("toggles dropdown visibility on button click", () => {
    const dom = setupTestDom();
    const picker = setupComposerModelPicker({
      ...dom,
      getTarget: () => ({ workspaceId: "ws1" }),
      t: (k) => k,
    });

    dom.modelDropdownBtn.click();
    expect(dom.modelDropdownMenu.classList.contains("hidden")).toBe(false);
    expect(dom.modelDropdown.classList.contains("open")).toBe(true);

    dom.modelDropdownBtn.click();
    expect(dom.modelDropdownMenu.classList.contains("hidden")).toBe(true);
    expect(dom.modelDropdown.classList.contains("open")).toBe(false);

    picker.destroy();
  });

  it("cycles thinking level when thinking button is clicked", async () => {
    const dom = setupTestDom();
    const runtime = {
      request: vi.fn().mockResolvedValue({
        response: { data: { level: "high" } },
      }),
    };
    const onThinkingLevelSelected = vi.fn();

    const picker = setupComposerModelPicker({
      ...dom,
      runtime,
      getTarget: () => ({ workspaceId: "ws1" }),
      onThinkingLevelSelected,
      t: (k, params) => (params?.level ? `Thinking: ${params.level}` : k),
    });

    await dom.thinkingBtn.click();

    expect(runtime.request).toHaveBeenCalledWith(
      { type: "cycle_thinking_level" },
      { workspaceId: "ws1" },
    );
    expect(onThinkingLevelSelected).toHaveBeenCalledWith("high");

    picker.destroy();
  });

  it("updates model and thinking displays", () => {
    const dom = setupTestDom();
    const picker = setupComposerModelPicker({
      ...dom,
      t: (k, params) => (params?.level ? `Thinking: ${params.level}` : k),
    });

    picker.updateModelDisplay({ id: "claude-3-opus" });
    expect(dom.modelDropdownLabel.textContent).toBe("3-opus");

    picker.updateThinkingDisplay("high");
    expect(dom.thinkingBtn.textContent).toBe("Thinking: high");
    expect(dom.thinkingBtn.classList.contains("off")).toBe(false);

    picker.updateThinkingDisplay("off");
    expect(dom.thinkingBtn.classList.contains("off")).toBe(true);

    picker.destroy();
  });
});
