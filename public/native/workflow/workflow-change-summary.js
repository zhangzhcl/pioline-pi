// ABOUTME: Builds bounded, value-safe workflow edit history for the Pi agent.

function shortText(value, limit = 128) {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}

function summarizeOperation(command) {
  if (!command || typeof command !== "object") return { type: "unknown" };
  if (command.type === "apply_batch") {
    const operations = Array.isArray(command.operations) ? command.operations : [];
    return {
      type: "apply_batch",
      operations: operations.slice(0, 20).map(summarizeOperation),
      ...(operations.length > 20 ? { omittedOperationCount: operations.length - 20 } : {}),
    };
  }
  switch (command.type) {
    case "add_node":
      return {
        type: command.type,
        instanceId: shortText(command.node?.instanceId),
        meta: {
          id: shortText(command.node?.meta?.id),
          version: shortText(command.node?.meta?.version),
        },
      };
    case "connect":
      return {
        type: command.type,
        edge: {
          sourceNodeId: shortText(command.edge?.sourceNodeId),
          sourcePort: shortText(command.edge?.sourcePort),
          targetNodeId: shortText(command.edge?.targetNodeId),
          targetPort: shortText(command.edge?.targetPort),
        },
      };
    case "move_node":
      return {
        type: command.type,
        instanceId: shortText(command.instanceId),
        position:
          Number.isFinite(command.position?.x) && Number.isFinite(command.position?.y)
            ? { x: command.position.x, y: command.position.y }
            : undefined,
      };
    case "remove_edge":
      return { type: command.type, edgeId: shortText(command.edgeId) };
    case "remove_node":
      return { type: command.type, instanceId: shortText(command.instanceId) };
    case "set_param":
    case "clear_param":
    case "set_input":
    case "clear_input":
      return {
        type: command.type,
        instanceId: shortText(command.instanceId),
        name: shortText(command.name),
        ...(command.type.startsWith("set_") ? { valueChanged: true } : {}),
      };
    case "seed_starter":
      return {
        type: command.type,
        nodeCount: Number.isSafeInteger(command.nodeCount) ? command.nodeCount : undefined,
        edgeCount: Number.isSafeInteger(command.edgeCount) ? command.edgeCount : undefined,
      };
    case "undo_snapshot":
    case "redo_snapshot": {
      const summary = command.snapshotSummary;
      return {
        type: command.type,
        snapshotSummary: {
          nodeCount: Number.isSafeInteger(summary?.nodeCount) ? summary.nodeCount : null,
          edgeCount: Number.isSafeInteger(summary?.edgeCount) ? summary.edgeCount : null,
        },
      };
    }
    default:
      return { type: shortText(command.type) ?? "unknown" };
  }
}

export function summarizeWorkflowChanges(events, limit = 12) {
  const history = Array.isArray(events) ? events : [];
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, 20)) : 12;
  const recent = boundedLimit === 0 ? [] : history.slice(-boundedLimit);
  return {
    items: recent.map((event) => ({
      revision: Number.isSafeInteger(event?.revision) ? event.revision : null,
      actor: ["user", "agent", "system"].includes(event?.actor) ? event.actor : "unknown",
      ...(typeof event?.timestamp === "string" ? { timestamp: event.timestamp.slice(0, 40) } : {}),
      command: summarizeOperation(event?.command),
    })),
    omittedCount: Math.max(0, history.length - boundedLimit),
  };
}
