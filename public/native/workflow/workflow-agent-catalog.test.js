import { describe, expect, it, vi } from "vitest";
import { refreshWorkflowCatalogForAgent } from "./workflow-agent-catalog.js";

describe("refreshWorkflowCatalogForAgent", () => {
  it("refreshes the Host catalog before an Agent operation continues", async () => {
    const refreshNodeMetaCatalog = vi.fn().mockResolvedValue(undefined);

    await expect(refreshWorkflowCatalogForAgent(refreshNodeMetaCatalog)).resolves.toEqual({
      ok: true,
    });
    expect(refreshNodeMetaCatalog).toHaveBeenCalledOnce();
  });

  it("returns catalog failures as a tool result instead of throwing", async () => {
    const refreshNodeMetaCatalog = vi.fn().mockRejectedValue(new Error("Host unavailable"));

    await expect(refreshWorkflowCatalogForAgent(refreshNodeMetaCatalog)).resolves.toEqual({
      ok: false,
      error: "Host unavailable",
    });
  });
});
