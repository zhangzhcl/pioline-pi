// ABOUTME: Adds opt-in, reviewable workflow tools to the native Pi session.

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "pipline_workflow";
const INPUT_TITLE = "Pipline workflow bridge";
const INPUT_MARKER = "__PIPLINE_WORKFLOW_TOOL_V1__";
const Id = Type.String({ minLength: 1, maxLength: 128 });
const WorkflowOperation = Type.Union([
  Type.Object({
    type: Type.Literal("add_node"),
    node: Type.Object({
      instanceId: Id,
      meta: Type.Object({ id: Id, version: Id }),
      position: Type.Object({ x: Type.Number(), y: Type.Number() }),
      paramValues: Type.Optional(Type.Record(Type.String(), Type.Any())),
      portValues: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),
  }),
  Type.Object({
    type: Type.Literal("connect"),
    edge: Type.Object({
      id: Id,
      sourceNodeId: Id,
      sourcePort: Id,
      targetNodeId: Id,
      targetPort: Id,
    }),
  }),
  Type.Object({
    type: Type.Literal("move_node"),
    instanceId: Id,
    position: Type.Object({ x: Type.Number(), y: Type.Number() }),
  }),
  Type.Object({ type: Type.Literal("remove_edge"), edgeId: Id }),
  Type.Object({ type: Type.Literal("remove_node"), instanceId: Id }),
  Type.Object({ type: Type.Literal("set_param"), instanceId: Id, name: Id, value: Type.Any() }),
  Type.Object({ type: Type.Literal("clear_param"), instanceId: Id, name: Id }),
  Type.Object({ type: Type.Literal("clear_input"), instanceId: Id, name: Id }),
  Type.Object({ type: Type.Literal("set_input"), instanceId: Id, name: Id, value: Type.Any() }),
]);

type WorkflowToolRequest = {
  requestId: string;
  operation: "read" | "search_node_templates" | "propose" | "propose_node_meta";
  query?: string;
  searchLimit?: number;
  baseRevision?: number;
  catalogOffset?: number;
  catalogLimit?: number;
  expectedCatalogRevision?: string;
  expectedWorkflowRevision?: number;
  workflowNodeOffset?: number;
  workflowEdgeOffset?: number;
  workflowItemLimit?: number;
  operations?: Record<string, unknown>[];
  meta?: Record<string, unknown>;
};

function setWorkflowToolEnabled(pi: ExtensionAPI, enabled: boolean): void {
  const active = pi.getActiveTools().filter((name) => name !== TOOL_NAME);
  pi.setActiveTools(enabled ? [...active, TOOL_NAME] : active);
}

export function registerPicotWorkflowTools(pi: ExtensionAPI): void {
  let workflowModeEnabled = false;
  pi.on("session_start", () => {
    workflowModeEnabled = false;
    setWorkflowToolEnabled(pi, false);
  });

  pi.registerCommand("pipline-workflow-mode", {
    description: "Enable or disable Pipline workflow tools for the active workflow mode",
    handler: async (rawArguments) => {
      const mode = rawArguments.trim().toLowerCase();
      if (mode !== "on" && mode !== "off") return;
      workflowModeEnabled = mode === "on";
      setWorkflowToolEnabled(pi, workflowModeEnabled);
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Pipline Workflow",
    description:
      "Search node templates, read the active Pipline workflow, propose graph operations, or propose a new NodeMeta template. All changes require user approval in the desktop app.",
    promptSnippet: "Search nodes or read and propose changes to the active Pipline workflow.",
    promptGuidelines: [
      "When the user asks about the active workflow, call pipline_workflow with operation=read instead of relying on old chat context. The node catalog and workflow graph are paginated. Read every page before proposing edits: follow nodeCatalog.nextOffset with catalogOffset, graph.nextNodeOffset with workflowNodeOffset, and graph.nextEdgeOffset with workflowEdgeOffset. Keep the same workflowItemLimit (default 25) while paging so offsets are consistent. Pass graph.revision as expectedWorkflowRevision and nodeCatalog.revision as expectedCatalogRevision on every continuation; if either changes, restart reading from offset 0. Active graph node parameter values are truncated above 4 KB; ask the user or inspect the relevant node instead of treating the preview as the complete value.",
      "The read response includes bounded recentChanges with the actor, revision, and operation summary for recent canvas edits. Use it to explain what the user or Agent changed before suggesting the next step. Parameter and input values are intentionally omitted from change summaries; use the current graph's params/portValues when you need their present values.",
      "The read response includes the active Run's running nodes, waiting nodes, progress counts, concurrency limit, recent node events/logs, and errors. Use it to explain what is happening now; do not infer progress from stale conversation text.",
      "When matching a requested capability to existing nodes, call operation=search_node_templates with a concise query in the user's language. It returns a small ranked list of localized node summaries and catalogRevision, and remains available while a Run is active. Reuse a returned id/version when proposing a graph; pass that catalogRevision as expectedCatalogRevision so Pipline can reject stale matches. Search may include node capabilities from other supported locales to help cross-language matching.",
      "While the Run status is queued or running, treat the graph and node catalog as observation-only: do not propose workflow edits. Explain the current Run and wait until it reaches a terminal status before proposing graph changes.",
      "For workflow edits, read the latest graph revision and search or read the node catalog first, then call operation=propose with baseRevision, expectedCatalogRevision, and operations[]. Do not omit expectedCatalogRevision: Pipline will reject proposals based on a missing or stale node catalog. Supported operations are add_node (instanceId, meta {id,version}, position {x,y}, paramValues, portValues), connect (edge {id,sourceNodeId,sourcePort,targetNodeId,targetPort}), move_node, remove_edge, remove_node, set_param, clear_param, set_input, and clear_input.",
      "If no existing node can provide a capability, call operation=propose_node_meta with meta containing schemaVersion=1, a unique custom.<slug> id, version, type=custom, label, description, typed inputs/outputs/params, execution {kind:user-code}, least-privilege permissions, and optionally implementationDraft {language:typescript,source,entryFn}. Include complete i18n display text for en, zh, es, and ja: each locale entry has label, description, inputs and outputs maps keyed by port name, and a params map keyed by parameter name whose entries contain label plus translated description/options labels when those exist. Keep internal IDs, port/parameter names, option values and executor contracts language-neutral. For an input with multi=true, declare type {kind:array,items:<type of each incoming connection>}; static values use the same aggregate array shape. The source is inert documentation and is never executed.",
      "After a NodeMeta candidate is approved and saved, unless the user asked only to save a reusable template, read the latest workflow and node catalog, then propose adding an instance of that new template with task-specific parameter values, input bindings, and connections. The graph proposal has its own user approval; do not say the node is on the canvas until Pipline confirms that graph proposal was applied.",
      "implementationDraft.source is optional inert documentation, not executable workflow code; never claim it can be executed. Do not propose arbitrary runnable source through graph operations. Only use node template IDs returned by the read operation. The desktop validates the whole graph and asks the user before applying the batch.",
    ],
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("read"),
        Type.Literal("search_node_templates"),
        Type.Literal("propose"),
        Type.Literal("propose_node_meta"),
      ]),
      baseRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      query: Type.Optional(Type.String({ minLength: 2, maxLength: 200 })),
      searchLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      catalogOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      catalogLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
      expectedCatalogRevision: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      expectedWorkflowRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      workflowNodeOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      workflowEdgeOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      workflowItemLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      operations: Type.Optional(Type.Array(WorkflowOperation, { maxItems: 100 })),
      meta: Type.Optional(Type.Any()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      if (!ctx.hasUI) throw new Error("Pipline workflow tools require the desktop UI.");
      signal?.throwIfAborted();
      const request: WorkflowToolRequest = {
        requestId: randomUUID(),
        operation: params.operation,
        ...(typeof params.query === "string" ? { query: params.query } : {}),
        ...(typeof params.searchLimit === "number" ? { searchLimit: params.searchLimit } : {}),
        ...(typeof params.baseRevision === "number" ? { baseRevision: params.baseRevision } : {}),
        ...(typeof params.catalogOffset === "number"
          ? { catalogOffset: params.catalogOffset }
          : {}),
        ...(typeof params.catalogLimit === "number" ? { catalogLimit: params.catalogLimit } : {}),
        ...(typeof params.expectedCatalogRevision === "string"
          ? { expectedCatalogRevision: params.expectedCatalogRevision }
          : {}),
        ...(typeof params.expectedWorkflowRevision === "number"
          ? { expectedWorkflowRevision: params.expectedWorkflowRevision }
          : {}),
        ...(typeof params.workflowNodeOffset === "number"
          ? { workflowNodeOffset: params.workflowNodeOffset }
          : {}),
        ...(typeof params.workflowEdgeOffset === "number"
          ? { workflowEdgeOffset: params.workflowEdgeOffset }
          : {}),
        ...(typeof params.workflowItemLimit === "number"
          ? { workflowItemLimit: params.workflowItemLimit }
          : {}),
        ...(Array.isArray(params.operations)
          ? { operations: params.operations as Record<string, unknown>[] }
          : {}),
        ...(params.meta && typeof params.meta === "object"
          ? { meta: params.meta as Record<string, unknown> }
          : {}),
      };
      const response = await ctx.ui.input(INPUT_TITLE, `${INPUT_MARKER}${JSON.stringify(request)}`);
      if (signal?.aborted) throw new Error("Pipline workflow request was cancelled.");
      if (!response) throw new Error("Pipline workflow request was cancelled or unavailable.");
      let result: { ok?: boolean; error?: string };
      try {
        result = JSON.parse(response) as typeof result;
      } catch {
        throw new Error("Pipline returned an invalid workflow response.");
      }
      if (!result.ok) throw new Error(result.error || "Pipline rejected the workflow request.");
      return { content: [{ type: "text", text: response }], details: {} };
    },
  });
}
