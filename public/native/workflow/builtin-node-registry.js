import builtinNodeMetaDocument from "../../../shared/workflow/builtin-node-metas.json";

export const BUILTIN_NODE_METAS = new Map(
  builtinNodeMetaDocument.map((meta) => [`${meta.id}@${meta.version}`, meta]),
);

export function nodeMetaKey(reference) {
  return `${reference?.id ?? ""}@${reference?.version ?? ""}`;
}

export function createStarterWorkflow({
  id,
  workspaceId,
  makeId,
  timestamp,
  workflowName = "Workflow",
  initialPiTask = "Describe the task for Pi.",
}) {
  const workflow = {
    schemaVersion: 1,
    id,
    workspaceId,
    name: workflowName,
    description: "",
    revision: 0,
    nodes: [
      {
        instanceId: makeId(),
        meta: { id: "pipline.start", version: "1.0.0" },
        position: { x: 40, y: 140 },
        paramValues: {},
        portValues: {},
      },
      {
        instanceId: makeId(),
        meta: { id: "pipline.pi-agent", version: "2.0.0" },
        position: { x: 340, y: 140 },
        paramValues: { prompt: initialPiTask },
        portValues: {},
      },
      {
        instanceId: makeId(),
        meta: { id: "pipline.end", version: "1.0.0" },
        position: { x: 660, y: 140 },
        paramValues: {},
        portValues: {},
      },
    ],
    edges: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  workflow.edges = [
    {
      id: makeId(),
      sourceNodeId: workflow.nodes[0].instanceId,
      sourcePort: "input",
      targetNodeId: workflow.nodes[1].instanceId,
      targetPort: "context",
    },
    {
      id: makeId(),
      sourceNodeId: workflow.nodes[1].instanceId,
      sourcePort: "content",
      targetNodeId: workflow.nodes[2].instanceId,
      targetPort: "result",
    },
  ];
  return workflow;
}
