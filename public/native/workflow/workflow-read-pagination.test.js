import { describe, expect, it } from "vitest";
import { validateWorkflowReadPageRequest } from "./workflow-read-pagination.js";

function validateRead(request, revisions = {}) {
  return validateWorkflowReadPageRequest(request, {
    workflowRevision: 4,
    catalogRevision: "catalog-7",
    nodeCount: 3,
    edgeCount: 2,
    catalogCount: 5,
    ...revisions,
  });
}

describe("workflow Agent read pagination", () => {
  it("leaves the first page open and requires both revision tokens for continuations", () => {
    expect(validateRead({})).toBeNull();
    expect(validateRead({ workflowNodeOffset: 1 })).toContain(
      "Continuation pages require the workflow and node catalog revisions.",
    );
    expect(validateRead({ catalogOffset: 1, expectedWorkflowRevision: 4 })).toContain(
      "Continuation pages require the workflow and node catalog revisions.",
    );
  });

  it("accepts matching revisions and rejects stale graph or catalog pages", () => {
    const continuation = {
      workflowEdgeOffset: 1,
      expectedWorkflowRevision: 4,
      expectedCatalogRevision: "catalog-7",
    };
    expect(validateRead(continuation)).toBeNull();
    expect(validateRead({ ...continuation, expectedWorkflowRevision: 3 })).toContain(
      "Workflow changed while paging.",
    );
    expect(validateRead({ ...continuation, expectedCatalogRevision: "catalog-6" })).toContain(
      "Node catalog changed while paging.",
    );
  });

  it("checks catalog offsets against visible templates, not retired entries", () => {
    const revisions = { expectedWorkflowRevision: 4, expectedCatalogRevision: "catalog-7" };
    expect(validateRead({ catalogOffset: 5, ...revisions })).toBeNull();
    expect(validateRead({ catalogOffset: 6, ...revisions })).toContain(
      "catalogOffset is beyond the end of the node catalog.",
    );
  });
});
