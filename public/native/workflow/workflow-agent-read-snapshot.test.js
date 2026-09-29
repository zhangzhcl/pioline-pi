import { describe, expect, it } from "vitest";
import { loadWorkflowSnapshotForAgentRead } from "./workflow-agent-read-snapshot.js";

const currentRecord = {
  workflow: { id: "workflow-1", workspaceId: "workspace-1", revision: 3 },
};

function readWith(record) {
  return loadWorkflowSnapshotForAgentRead({
    workflowService: { load: async () => record },
    currentRecord,
    workspaceId: "workspace-1",
  });
}

describe("Host-authoritative Agent workflow snapshots", () => {
  it("rejects a Host record for a different workflow", async () => {
    await expect(
      readWith({ workflow: { id: "workflow-2", workspaceId: "workspace-1", revision: 3 } }),
    ).rejects.toThrow("The Host returned a different workflow or workspace.");
  });

  it("rejects a Host record from a different workspace", async () => {
    await expect(
      readWith({ workflow: { id: "workflow-1", workspaceId: "workspace-2", revision: 3 } }),
    ).rejects.toThrow("The Host returned a different workflow or workspace.");
  });

  it("waits for pending local writes and then returns the latest matching Host record", async () => {
    const order = [];
    const record = {
      workflow: { id: "workflow-1", workspaceId: "workspace-1", revision: 4 },
    };
    const latest = await loadWorkflowSnapshotForAgentRead({
      workflowService: {
        load: async (id, workspaceId) => {
          order.push(["load", id, workspaceId]);
          return record;
        },
      },
      currentRecord,
      workspaceId: "workspace-1",
      waitForPendingWrites: async () => order.push(["writes"]),
      refreshNodeMetaCatalog: async () => order.push(["catalog"]),
    });

    expect(order).toEqual([["writes"], ["catalog"], ["load", "workflow-1", "workspace-1"]]);
    expect(latest).toBe(record);
  });

  it("returns the complete Host-authored graph for Agent context", async () => {
    const manualRecord = {
      workflow: {
        id: "workflow-1",
        workspaceId: "workspace-1",
        revision: 4,
        nodes: [
          {
            instanceId: "start",
            meta: { id: "pipline.start", version: "1.0.0" },
            paramValues: { inputSchema: { properties: { topic: "string" }, required: ["topic"] } },
            portValues: {},
          },
          {
            instanceId: "extract-title",
            meta: { id: "pipline.extract", version: "1.0.0" },
            paramValues: { path: "title" },
            portValues: {},
          },
          {
            instanceId: "end",
            meta: { id: "pipline.end", version: "1.0.0" },
            paramValues: { returnMode: "value" },
            portValues: {},
          },
        ],
        edges: [
          {
            id: "start-title",
            sourceNodeId: "start",
            sourcePort: "input",
            targetNodeId: "extract-title",
            targetPort: "value",
          },
          {
            id: "title-end",
            sourceNodeId: "extract-title",
            sourcePort: "value",
            targetNodeId: "end",
            targetPort: "result",
          },
        ],
      },
    };

    const latest = await readWith(manualRecord);

    expect(latest.workflow.revision).toBe(4);
    expect(latest.workflow.nodes).toEqual(manualRecord.workflow.nodes);
    expect(latest.workflow.edges).toEqual(manualRecord.workflow.edges);
    expect(latest.workflow.nodes[0].paramValues.inputSchema.required).toEqual(["topic"]);
    expect(latest.workflow.edges[0]).toMatchObject({
      sourceNodeId: "start",
      sourcePort: "input",
      targetNodeId: "extract-title",
      targetPort: "value",
    });
  });
});
