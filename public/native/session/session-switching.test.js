import { describe, expect, it, vi } from "vitest";
import { setupSessionSwitchingController } from "./session-switching.js";

describe("setupSessionSwitchingController", () => {
  it("defers firstMessage upsert for temporary sessions until session_bound", () => {
    const upsertSession = vi.fn();
    let target = {
      workspaceId: "ws-1",
      sessionId: "temporary-abc",
      instanceId: "inst-1",
    };

    const controller = setupSessionSwitchingController({
      adapter: { subscribeTarget: vi.fn() },
      runtime: {},
      data: {},
      control: {},
      config: {},
      messagesElement: document.createElement("div"),
      queuedMessages: document.createElement("div"),
      input: document.createElement("textarea"),
      composerAutoResize: { sync: vi.fn() },
      convNav: { rebuild: vi.fn() },
      messageRenderer: { clear: vi.fn() },
      toolRenderer: { clear: vi.fn() },
      todoMirrorPanel: { clear: vi.fn() },
      extensionWidgets: { clear: vi.fn() },
      customUiPanel: { close: vi.fn() },
      filePreviewFollow: { clear: vi.fn() },
      extensionUi: { setForegroundSession: vi.fn() },
      sessionUiState: { loadProfile: vi.fn().mockResolvedValue(null) },
      chatHistory: {
        resetLiveProcessGroup: vi.fn(),
        setActiveSearchQuery: vi.fn(),
        applyActiveSearchHighlight: vi.fn(),
      },
      sessionHydration: {
        resetInFlight: vi.fn(),
        hydrateSnapshotOnce: vi.fn(),
        clearDiskHistoryFallbackForSession: vi.fn(),
      },
      infoPanelController: {
        onTargetChanged: vi.fn(),
        syncSessionInfo: vi.fn(),
      },
      costAndCompaction: { resetForNewTarget: vi.fn() },
      workflowModeController: { syncTargetOnSwitch: vi.fn() },
      superAgentController: {
        setSelectSessionHandler: vi.fn(),
        updateSuperAgentActiveState: vi.fn(),
        setAgentInboxNavSession: vi.fn(),
      },
      resetRuntimeStreamingState: vi.fn(),
      getTarget: () => target,
      setTarget: (next) => {
        target = next;
      },
      getStore: () => ({ lifecycle: "idle", queue: [] }),
      setStore: vi.fn(),
      markConfigGatewayUnready: vi.fn(),
      getCurrentModel: () => ({ provider: null, id: null }),
      getCurrentThinkingLevel: () => "off",
      getPendingModelRestore: () => null,
      setPendingModelRestore: vi.fn(),
      updateComposerModel: vi.fn(),
      updateComposerThinking: vi.fn(),
      setStatus: vi.fn(),
      t: (key) => key,
      showError: vi.fn(),
    });

    // 临时会话先缓存首条用户消息，不立即写入侧边栏
    controller.upsertActiveSessionFromUserMessage({ content: "First message in temp session" });
    expect(upsertSession).not.toHaveBeenCalled();
  });
});
