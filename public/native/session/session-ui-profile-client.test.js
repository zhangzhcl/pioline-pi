import { describe, expect, it, vi } from "vitest";
import { createNativeSessionUiStateStore } from "./session-ui-profile-client.js";

describe("createNativeSessionUiStateStore", () => {
  it("loads and saves session UI profile via runtime.sendHostRequest when available", async () => {
    const sendHostRequest = vi
      .fn()
      .mockResolvedValueOnce({
        profile: { provider: "anthropic", modelId: "claude-3-7-sonnet", thinkingLevel: "high" },
      })
      .mockResolvedValueOnce({
        profile: { provider: "openai", modelId: "gpt-4.1", thinkingLevel: "medium" },
      });

    const store = createNativeSessionUiStateStore({
      waitUntilReady: () => Promise.resolve(),
      getSessionId: () => "temporary-session-1",
      getRuntime: () => ({ sendHostRequest }),
    });

    const loaded = await store.loadProfile();
    expect(loaded).toEqual({
      provider: "anthropic",
      modelId: "claude-3-7-sonnet",
      thinkingLevel: "high",
    });
    expect(sendHostRequest).toHaveBeenCalledWith({
      operation: "session_ui_profile_load",
      expectedSessionId: "temporary-session-1",
      fallbackToLatest: true,
    });

    await store.saveProfile({
      provider: "openai",
      modelId: "gpt-4.1",
      thinkingLevel: "medium",
    });
    expect(sendHostRequest).toHaveBeenLastCalledWith({
      operation: "session_ui_profile_save",
      expectedSessionId: "temporary-session-1",
      provider: "openai",
      modelId: "gpt-4.1",
      thinkingLevel: "medium",
    });
  });

  it("skips host requests while sessionId is pending-bootstrap", async () => {
    const sendHostRequest = vi.fn();
    const store = createNativeSessionUiStateStore({
      waitUntilReady: () => Promise.resolve(),
      getSessionId: () => "pending-bootstrap",
      getRuntime: () => ({ sendHostRequest }),
    });

    expect(await store.loadProfile()).toBeNull();
    expect(sendHostRequest).not.toHaveBeenCalled();
  });
});
