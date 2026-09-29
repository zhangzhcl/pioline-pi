import { describe, expect, it, vi } from "vitest";
import { createWorkflowNodeCatalogLoader } from "./workflow-node-catalog-loader.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createWorkflowNodeCatalogLoader", () => {
  it("does not return an older catalog response after a newer request", async () => {
    const first = deferred();
    const second = deferred();
    const listCatalog = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const loadCatalog = createWorkflowNodeCatalogLoader({
      getWorkspaceId: () => "workspace-1",
      listCatalog,
    });
    const oldRequest = loadCatalog();
    const newRequest = loadCatalog();
    second.resolve({ catalogRevision: "new" });

    await expect(newRequest).resolves.toEqual({ catalogRevision: "new" });
    first.resolve({ catalogRevision: "old" });
    await expect(oldRequest).rejects.toThrow(
      "The workflow context changed while loading the node catalog.",
    );
  });

  it("does not return a catalog loaded for a workspace that is no longer active", async () => {
    const response = deferred();
    let workspaceId = "workspace-1";
    const loadCatalog = createWorkflowNodeCatalogLoader({
      getWorkspaceId: () => workspaceId,
      listCatalog: vi.fn(() => response.promise),
    });
    const request = loadCatalog();
    workspaceId = "workspace-2";
    response.resolve({ catalogRevision: "workspace-1-catalog" });

    await expect(request).rejects.toThrow(
      "The workflow context changed while loading the node catalog.",
    );
  });
});
