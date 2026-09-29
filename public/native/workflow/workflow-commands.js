// ABOUTME: Applies validated user operations to the canonical workflow graph.

import { nodeMetaKey } from "./builtin-node-registry.js";

function findNode(workflow, instanceId) {
  const node = workflow.nodes.find((item) => item.instanceId === instanceId);
  if (!node) throw new Error(`Unknown node instance: ${instanceId}`);
  return node;
}

function getMeta(node, nodeMetas) {
  const meta = nodeMetas.get(nodeMetaKey(node.meta));
  if (!meta) throw new Error(`Unknown node template: ${nodeMetaKey(node.meta)}`);
  return meta;
}

function isTypeCompatible(output, input) {
  if (output === "any" || input === "any") return true;
  if (typeof output === "string" || typeof input === "string") return output === input;
  if (output.kind === "any" || input.kind === "any") return true;
  return output.kind === input.kind;
}

function edgeInputType(port) {
  return port?.multi === true && typeof port.type === "object" && port.type?.kind === "array"
    ? port.type.items
    : port?.type;
}

function assertNoCycle(workflow, newEdge) {
  const outgoing = new Map();
  for (const edge of [...workflow.edges, newEdge]) {
    const next = outgoing.get(edge.sourceNodeId) ?? [];
    next.push(edge.targetNodeId);
    outgoing.set(edge.sourceNodeId, next);
  }
  const visited = new Set();
  const visiting = new Set();
  const walk = (nodeId) => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const next of outgoing.get(nodeId) ?? []) if (walk(next)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  if ([...outgoing.keys()].some(walk))
    throw new Error("Workflow connections cannot contain a cycle.");
}

export function applyWorkflowCommand(workflow, command, nodeMetas) {
  switch (command.type) {
    case "apply_batch":
      if (!Array.isArray(command.operations) || command.operations.length === 0)
        throw new Error("A workflow proposal must contain at least one operation.");
      for (const operation of command.operations)
        applyWorkflowCommand(workflow, operation, nodeMetas);
      break;
    case "seed_starter":
      if (workflow.nodes.length || workflow.edges.length)
        throw new Error("Only an empty workflow can use the starter graph.");
      workflow.nodes.push(...structuredClone(command.nodes));
      workflow.edges.push(...structuredClone(command.edges));
      break;
    case "add_node": {
      const meta = nodeMetas.get(nodeMetaKey(command.node?.meta));
      if (!meta) throw new Error("Node template is unavailable.");
      if (meta.catalogHidden === true)
        throw new Error("This node template is retired and cannot be added.");
      if (workflow.nodes.some((node) => node.instanceId === command.node.instanceId))
        throw new Error("Node instance id already exists.");
      workflow.nodes.push(structuredClone(command.node));
      break;
    }
    case "move_node": {
      const node = findNode(workflow, command.instanceId);
      if (!Number.isFinite(command.position?.x) || !Number.isFinite(command.position?.y))
        throw new Error("Node position is invalid.");
      node.position = { x: command.position.x, y: command.position.y };
      break;
    }
    case "connect": {
      const source = findNode(workflow, command.edge?.sourceNodeId);
      const target = findNode(workflow, command.edge?.targetNodeId);
      const sourcePort = getMeta(source, nodeMetas).outputs.find(
        (port) => port.name === command.edge.sourcePort,
      );
      const targetPort = getMeta(target, nodeMetas).inputs.find(
        (port) => port.name === command.edge.targetPort,
      );
      if (!sourcePort || !targetPort) throw new Error("Connection refers to an unknown port.");
      if (!isTypeCompatible(sourcePort.type, edgeInputType(targetPort)))
        throw new Error("Port types are incompatible.");
      if (
        !targetPort.multi &&
        workflow.edges.some(
          (edge) => edge.targetNodeId === target.instanceId && edge.targetPort === targetPort.name,
        )
      ) {
        throw new Error("This input port only accepts one connection.");
      }
      if (workflow.edges.some((edge) => edge.id === command.edge.id))
        throw new Error("Connection id already exists.");
      assertNoCycle(workflow, command.edge);
      // A link becomes the sole source for this input. Drop any previous
      // static binding atomically so the inspector and executor cannot disagree.
      delete target.portValues?.[targetPort.name];
      workflow.edges.push(structuredClone(command.edge));
      break;
    }
    case "remove_edge":
      workflow.edges = workflow.edges.filter((edge) => edge.id !== command.edgeId);
      break;
    case "remove_node":
      {
        const target = findNode(workflow, command.instanceId);
        const targetMeta = getMeta(target, nodeMetas);
        if (targetMeta.type === "start") throw new Error("The Start node cannot be removed.");
        if (
          targetMeta.type === "end" &&
          workflow.nodes.filter((node) => getMeta(node, nodeMetas).type === "end").length <= 1
        )
          throw new Error("A workflow must keep at least one End node.");
      }
      workflow.nodes = workflow.nodes.filter((node) => node.instanceId !== command.instanceId);
      workflow.edges = workflow.edges.filter(
        (edge) =>
          edge.sourceNodeId !== command.instanceId && edge.targetNodeId !== command.instanceId,
      );
      break;
    case "set_param": {
      const node = findNode(workflow, command.instanceId);
      const param = getMeta(node, nodeMetas).params.find((item) => item.name === command.name);
      if (!param) throw new Error("Unknown node parameter.");
      node.paramValues[command.name] = structuredClone(command.value);
      break;
    }
    case "clear_param": {
      const node = findNode(workflow, command.instanceId);
      const param = getMeta(node, nodeMetas).params.find((item) => item.name === command.name);
      if (!param) throw new Error("Unknown node parameter.");
      delete node.paramValues[command.name];
      break;
    }
    case "set_input": {
      const node = findNode(workflow, command.instanceId);
      const port = getMeta(node, nodeMetas).inputs.find((item) => item.name === command.name);
      if (!port?.allowStaticValue) throw new Error("This input does not allow a static value.");
      if (
        workflow.edges.some(
          (edge) => edge.targetNodeId === node.instanceId && edge.targetPort === port.name,
        )
      )
        throw new Error("Remove the input connection before setting a static value.");
      node.portValues[command.name] = {
        mode: "static",
        staticValue: structuredClone(command.value),
      };
      break;
    }
    case "clear_input": {
      const node = findNode(workflow, command.instanceId);
      const port = getMeta(node, nodeMetas).inputs.find((item) => item.name === command.name);
      if (!port) throw new Error("Unknown node input.");
      delete node.portValues[command.name];
      break;
    }
    default:
      throw new Error(`Unsupported workflow operation: ${command.type}`);
  }
}
