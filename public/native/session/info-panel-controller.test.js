import { describe, expect, it, vi } from "vitest";
import { setupInfoPanelController } from "./info-panel-controller.js";

describe("setupInfoPanelController", () => {
  it("navigates active tree via config gateway and re-hydrates snapshot", async () => {
    document.body.innerHTML = `
      <aside id="info-sidebar" class="collapsed"><div id="info-panel"></div></aside>
    `;
    const call = vi.fn().mockResolvedValue({ ok: true });
    const hydrateSnapshotOnce = vi.fn().mockResolvedValue(undefined);
    const controller = setupInfoPanelController({
      data: {
        workspaceInfo: vi.fn(),
        readSessionTree: vi.fn(),
      },
      runtime: {
        request: vi.fn(),
      },
      control: {},
      config: { call },
      turnTrace: { getTurns: () => [] },
      getTarget: () => ({ workspaceId: "ws-1", sessionId: "s-1", instanceId: "i-1" }),
      getSessions: () => [],
      getCurrentModel: () => null,
      isStreaming: () => false,
      hydrateSnapshotOnce,
      t: (key) => key,
    });

    await controller.navigateActiveTree("entry-42");
    expect(call).toHaveBeenCalledWith("navigate_tree", {
      targetId: "entry-42",
      summarize: false,
      label: "infoPanel.resumeBranch",
    });
    expect(hydrateSnapshotOnce).toHaveBeenCalledTimes(1);
  });
});
