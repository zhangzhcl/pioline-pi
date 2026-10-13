import { describe, expect, it, vi } from "vitest";
import {
  computeTotalCostFromMessages,
  setupSessionCostAndCompaction,
} from "./session-cost-compaction.js";

describe("session-cost-compaction", () => {
  it("computes total cost across assistant messages", () => {
    expect(
      computeTotalCostFromMessages([
        { role: "user" },
        { role: "assistant", usage: { cost: { total: 0.0125 } } },
        { role: "assistant", usage: { cost: { total: 0.0075 } } },
      ]),
    ).toBeCloseTo(0.02, 6);
    expect(computeTotalCostFromMessages(null)).toBe(0);
  });

  it("updates and resets session cost DOM element", () => {
    const sessionCostEl = document.createElement("span");
    const controller = setupSessionCostAndCompaction({
      sessionCostEl,
      compactContextButton: null,
      runtime: { request: vi.fn().mockResolvedValue({}) },
      contextUsage: { setSessionTotals: vi.fn(), setCompacting: vi.fn(), canCompact: true },
      getTarget: () => ({ workspaceId: "ws-1", sessionId: "s-1", instanceId: "i-1" }),
      getStore: () => ({ lifecycle: "idle", compaction: null }),
      clearStoreCompaction: vi.fn(),
      getSessions: () => [],
      t: (key) => key,
      showError: vi.fn(),
    });

    controller.setSessionCost(0.015);
    expect(sessionCostEl.classList.contains("visible")).toBe(true);
    expect(sessionCostEl.textContent).toBe("$0.0150");

    controller.addSessionCost(0.005);
    expect(sessionCostEl.textContent).toBe("$0.0200");

    controller.setSessionCost(0);
    expect(sessionCostEl.classList.contains("visible")).toBe(false);
    expect(sessionCostEl.textContent).toBe("");
  });
});
