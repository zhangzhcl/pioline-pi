// ABOUTME: Produces deterministic, editable node positions for a DAG workflow.

const LAYER_GAP = 280;
const ROW_GAP = 180;
const START_X = 48;
const START_Y = 48;

export function layoutWorkflowNodes(workflow) {
  if (!workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges))
    throw new TypeError("A valid workflow graph is required for layout.");

  const order = new Map(workflow.nodes.map((node, index) => [node.instanceId, index]));
  const indegree = new Map(workflow.nodes.map((node) => [node.instanceId, 0]));
  const outgoing = new Map(workflow.nodes.map((node) => [node.instanceId, []]));
  for (const edge of workflow.edges) {
    if (!indegree.has(edge.sourceNodeId) || !indegree.has(edge.targetNodeId))
      throw new Error("Cannot lay out a workflow with dangling edges.");
    indegree.set(edge.targetNodeId, indegree.get(edge.targetNodeId) + 1);
    outgoing.get(edge.sourceNodeId).push(edge.targetNodeId);
  }

  const queue = workflow.nodes
    .filter((node) => indegree.get(node.instanceId) === 0)
    .map((node) => node.instanceId);
  const layer = new Map(workflow.nodes.map((node) => [node.instanceId, 0]));
  let cursor = 0;
  while (cursor < queue.length) {
    const source = queue[cursor++];
    for (const target of outgoing.get(source)) {
      layer.set(target, Math.max(layer.get(target), layer.get(source) + 1));
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        queue.push(target);
        queue.sort((left, right) => order.get(left) - order.get(right));
      }
    }
  }
  if (cursor !== workflow.nodes.length)
    throw new Error("Cannot lay out a workflow containing a cycle.");

  const byLayer = new Map();
  for (const node of workflow.nodes) {
    const level = layer.get(node.instanceId);
    const nodes = byLayer.get(level) ?? [];
    nodes.push(node);
    byLayer.set(level, nodes);
  }

  return workflow.nodes.map((node) => {
    const nodes = byLayer.get(layer.get(node.instanceId));
    const row = nodes.findIndex((item) => item.instanceId === node.instanceId);
    return {
      type: "move_node",
      instanceId: node.instanceId,
      position: {
        x: START_X + layer.get(node.instanceId) * LAYER_GAP,
        y: START_Y + row * ROW_GAP,
      },
    };
  });
}
