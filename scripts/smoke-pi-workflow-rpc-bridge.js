import { loadWorkflowSnapshotForAgentRead } from "../public/native/workflow/workflow-agent-read-snapshot.js";
import { summarizeWorkflowChanges } from "../public/native/workflow/workflow-change-summary.js";
import { nodeMetaCandidate } from "./smoke-pi-workflow-rpc-provider.js";

export function parseWorkflowRequest(event) {
  const marker = "__PIPLINE_WORKFLOW_TOOL_V1__";
  if (
    event.type !== "extension_ui_request" ||
    event.method !== "input" ||
    event.title !== "Pipline workflow bridge" ||
    typeof event.placeholder !== "string" ||
    !event.placeholder.startsWith(marker)
  )
    return undefined;
  return JSON.parse(event.placeholder.slice(marker.length));
}

export function createWorkflowBridgeHandler({ writeStdin }) {
  const counts = {
    workflowSearchCalls: 0,
    workflowReadCalls: 0,
    workflowProposalCalls: 0,
    workflowNodeMetaProposalCalls: 0,
  };

  async function returnWorkflowResult(event, workflowRequest) {
    if (typeof workflowRequest.requestId !== "string")
      throw new Error(`Pi sent a request without an id: ${JSON.stringify(workflowRequest)}`);
    let result;
    if (workflowRequest.operation === "search_node_templates") {
      if (!["数组筛选", "英文文本 URL slug"].includes(workflowRequest.query))
        throw new Error(
          `Pi sent an invalid workflow search request: ${JSON.stringify(workflowRequest)}`,
        );
      counts.workflowSearchCalls += 1;
      result = {
        ok: true,
        operation: "search_node_templates",
        catalogRevision: "catalog-smoke-r4",
        matches:
          workflowRequest.query === "数组筛选"
            ? [{ id: "pipline.filter", version: "1.0.0", label: "筛选" }]
            : [],
      };
    } else if (workflowRequest.operation === "read") {
      counts.workflowReadCalls += 1;
      if (counts.workflowReadCalls === 3) {
        result = {
          ok: true,
          operation: "read",
          workflow: {
            id: "workflow-smoke",
            name: "Pipline proposal smoke",
            workspaceId: "workspace-smoke",
            revision: 9,
            nodes: [
              { instanceId: "start", meta: { id: "pipline.start", version: "1.0.0" } },
              { instanceId: "pi-node", meta: { id: "pipline.pi-agent", version: "2.0.0" } },
              { instanceId: "end", meta: { id: "pipline.end", version: "1.0.0" } },
            ],
            edges: [
              {
                id: "start-pi",
                sourceNodeId: "start",
                sourcePort: "input",
                targetNodeId: "pi-node",
                targetPort: "context",
              },
              {
                id: "pi-end",
                sourceNodeId: "pi-node",
                sourcePort: "content",
                targetNodeId: "end",
                targetPort: "result",
              },
            ],
            graph: {
              revision: 9,
              totalNodes: 3,
              totalEdges: 2,
              nextNodeOffset: null,
              nextEdgeOffset: null,
            },
            nodeCatalog: { revision: "catalog-smoke-r4", total: 9, nextOffset: null },
          },
        };
        writeStdin(
          `${JSON.stringify({
            type: "extension_ui_response",
            id: event.id,
            value: JSON.stringify(result),
          })}\n`,
        );
        return;
      }
      if (counts.workflowReadCalls === 2) {
        result = {
          ok: true,
          operation: "read",
          workflow: {
            id: "workflow-smoke",
            revision: 9,
            run: {
              id: "run-smoke",
              status: "success",
              workflowRevision: 9,
              progress: {
                total: 3,
                running: 0,
                waiting: 0,
                succeeded: 3,
                failed: 0,
                skipped: 0,
                interrupted: 0,
              },
              activeNodes: [],
              nodes: [
                { instanceId: "start", status: "success", output: { input: {} } },
                { instanceId: "assign", status: "success", output: { value: {} } },
                { instanceId: "end", status: "success", output: { result: {} } },
              ],
              result: { summary: {} },
              recentEvents: [
                { type: "run_started" },
                { type: "node_completed", instanceId: "start" },
                { type: "node_completed", instanceId: "assign" },
                { type: "node_completed", instanceId: "end" },
                { type: "run_completed" },
              ],
            },
          },
        };
        writeStdin(
          `${JSON.stringify({
            type: "extension_ui_response",
            id: event.id,
            value: JSON.stringify(result),
          })}\n`,
        );
        return;
      }
      let pendingWritesWaited = false;
      const freshRecord = await loadWorkflowSnapshotForAgentRead({
        currentRecord: { workflow: { id: "workflow-smoke", revision: 8 } },
        workspaceId: "workspace-smoke",
        waitForPendingWrites: async () => {
          pendingWritesWaited = true;
        },
        workflowService: {
          async load(workflowId, workspaceId) {
            if (workflowId !== "workflow-smoke" || workspaceId !== "workspace-smoke")
              throw new Error("Agent read used the wrong workflow target.");
            return {
              workflow: { id: workflowId, workspaceId, revision: 9 },
              events: [
                {
                  revision: 9,
                  actor: "user",
                  timestamp: "2026-09-27T10:00:00.000Z",
                  command: {
                    type: "apply_batch",
                    operations: [
                      {
                        type: "set_param",
                        instanceId: "filter-node",
                        name: "predicate",
                        value: "smoke-private-value",
                      },
                      {
                        type: "connect",
                        edge: {
                          sourceNodeId: "map-node",
                          sourcePort: "items",
                          targetNodeId: "filter-node",
                          targetPort: "items",
                        },
                      },
                    ],
                  },
                },
              ],
            };
          },
        },
      });
      if (!pendingWritesWaited || freshRecord.workflow.revision !== 9)
        throw new Error("Pi read did not refresh the Host-authoritative workflow record.");
      const recentChanges = summarizeWorkflowChanges(freshRecord.events);
      const serialized = JSON.stringify(recentChanges);
      if (serialized.includes("smoke-private-value"))
        throw new Error("Recent change summary leaked an edited parameter value.");
      result = {
        ok: true,
        operation: "read",
        workflow: { id: "workflow-smoke", revision: 9, recentChanges },
      };
    } else if (workflowRequest.operation === "propose_node_meta") {
      const meta = workflowRequest.meta;
      if (
        workflowRequest.expectedCatalogRevision !== "catalog-smoke-r4" ||
        meta?.id !== nodeMetaCandidate.id ||
        meta?.version !== nodeMetaCandidate.version ||
        meta?.implementationDraft?.source !== nodeMetaCandidate.implementationDraft.source ||
        !["en", "zh", "es", "ja"].every((locale) => typeof meta.i18n?.[locale]?.label === "string")
      )
        throw new Error(
          `Pi sent an incomplete NodeMeta candidate: ${JSON.stringify(workflowRequest)}`,
        );
      counts.workflowNodeMetaProposalCalls += 1;
      result = {
        ok: true,
        operation: "propose_node_meta",
        meta: {
          id: meta.id,
          version: meta.version,
          implementation: { compiled: true, executable: false },
        },
        nodeCatalog: { revision: "catalog-smoke-r5" },
        approval: "approved",
      };
    } else if (workflowRequest.operation === "propose") {
      if (
        workflowRequest.baseRevision !== 9 ||
        workflowRequest.expectedCatalogRevision !== "catalog-smoke-r4" ||
        workflowRequest.operations?.length !== 1 ||
        workflowRequest.operations[0]?.type !== "set_param" ||
        workflowRequest.operations[0]?.instanceId !== "pi-node" ||
        workflowRequest.operations[0]?.value !== "整理输入并输出要点"
      )
        throw new Error(
          `Pi sent an invalid revision-bound graph proposal: ${JSON.stringify(workflowRequest)}`,
        );
      counts.workflowProposalCalls += 1;
      result = {
        ok: true,
        operation: "propose",
        applied: true,
        revision: 10,
        approval: "approved",
      };
    } else {
      throw new Error(`Pi sent an unexpected workflow operation: ${workflowRequest.operation}`);
    }
    writeStdin(
      `${JSON.stringify({
        type: "extension_ui_response",
        id: event.id,
        value: JSON.stringify(result),
      })}\n`,
    );
  }

  return { counts, returnWorkflowResult };
}
