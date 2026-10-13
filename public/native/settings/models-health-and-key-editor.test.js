import { describe, expect, test } from "vitest";
import {
  describeModelHealth,
  describeProviderSummary,
  healthDotClass,
} from "./models-health-and-key-editor.js";
import {
  escapeSelectorValue,
  getProviderModels,
  isCodexProvider,
  PROVIDER_ICON_ALIASES,
} from "./models-provider-picker.js";

describe("models-health-and-key-editor pure helpers", () => {
  test("healthDotClass classifies latency tiers and error states", () => {
    expect(healthDotClass(null)).toBe("unknown");
    expect(healthDotClass({ status: "checking" })).toBe("checking");
    expect(healthDotClass({ status: "unhealthy" })).toBe("unhealthy");
    expect(healthDotClass({ status: "healthy" })).toBe("healthy");
    expect(healthDotClass({ status: "healthy", latencyMs: 800 })).toBe("healthy");
    expect(healthDotClass({ status: "healthy", latencyMs: 2000 })).toBe("healthy-slow");
    expect(healthDotClass({ status: "healthy", latencyMs: 3500 })).toBe("healthy-veryslow");
  });

  test("describeModelHealth and describeProviderSummary return i18n keys or formatted strings", () => {
    expect(describeModelHealth({ status: "unknown" })).toBeTruthy();
    expect(describeModelHealth({ status: "healthy", latencyMs: 120 })).toBeTruthy();
    expect(describeModelHealth({ status: "unhealthy", error: "401" })).toBeTruthy();
    expect(
      describeProviderSummary([
        { visible: true, health: { status: "healthy" } },
        { visible: false, health: { status: "unhealthy" } },
      ]),
    ).toBeTruthy();
  });

  test("provider picker helpers normalize models, codex provider, and icon aliases", () => {
    expect(isCodexProvider({ provider: "openai-codex" })).toBe(true);
    expect(isCodexProvider({ provider: "anthropic" })).toBe(false);
    expect(getProviderModels({ models: [{ id: "m1" }] })).toEqual([{ id: "m1" }]);
    expect(getProviderModels({})).toEqual([]);
    expect(PROVIDER_ICON_ALIASES["amazon-bedrock"]).toBe("aws");
    expect(escapeSelectorValue("a/b")).toBeTruthy();
  });
});
