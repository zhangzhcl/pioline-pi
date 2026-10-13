// ABOUTME: Versioned workflow data contracts shared by the canvas, Agent tools,
// and scheduler. This module has no UI or runtime dependencies.

import {
  edgeValueType,
  isCompatibleType,
  isJsonValue,
  isRecord,
  requireString,
  validateNodeMeta,
  valueMatchesType,
  WORKFLOW_SCHEMA_VERSION,
} from "./node-meta-contracts.js";
import { validateWorkflowStartSchema } from "./workflow-start-schema.js";

export { validateNodeMeta, valueMatchesType, WORKFLOW_SCHEMA_VERSION };

// Older drafts could persist a static value alongside an incoming edge. The
// executor has always resolved that port from the edge, so remove the shadowed
// value when loading/re-running those records before enforcing the invariant.
export function normalizeWorkflowInputBindings(workflow) {
  const normalized = structuredClone(workflow);
  if (!isRecord(normalized) || !Array.isArray(normalized.nodes) || !Array.isArray(normalized.edges))
    return normalized;
  const nodes = new Map(normalized.nodes.map((node) => [node?.instanceId, node]));
  for (const edge of normalized.edges) {
    if (typeof edge?.targetNodeId !== "string" || typeof edge?.targetPort !== "string") continue;
    const target = nodes.get(edge.targetNodeId);
    if (
      isRecord(target?.portValues) &&
      Object.hasOwn(target.portValues, edge.targetPort) &&
      target.portValues[edge.targetPort]?.mode === "static"
    )
      delete target.portValues[edge.targetPort];
  }
  return normalized;
}

// Runtime state belongs to WorkflowRun. Strip the legacy draft field while
// loading old records so the next normal edit migrates them on save.
export function stripWorkflowNodeRuntime(workflow) {
  const normalized = structuredClone(workflow);
  if (!isRecord(normalized) || !Array.isArray(normalized.nodes)) return normalized;
  for (const node of normalized.nodes) {
    if (isRecord(node)) delete node.runtime;
  }
  return normalized;
}

export function validateWorkflow(
  workflow,
  nodeMetas = new Map(),
  { requireComplete = false } = {},
) {
  const errors = [];
  if (!isRecord(workflow)) return ["workflow must be an object"];
  if (workflow.schemaVersion !== WORKFLOW_SCHEMA_VERSION)
    errors.push("workflow.schemaVersion is unsupported");
  for (const key of ["id", "name"]) requireString(workflow[key], `workflow.${key}`, errors);
  requireString(workflow.workspaceId, "workflow.workspaceId", errors);
  if (!Number.isSafeInteger(workflow.revision) || workflow.revision < 0)
    errors.push("workflow.revision must be a non-negative integer");
  if (!Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) {
    errors.push("workflow.nodes and workflow.edges must be arrays");
    return errors;
  }

  const instances = new Map();
  let startCount = 0;
  let endCount = 0;
  for (const [index, node] of workflow.nodes.entries()) {
    const path = `workflow.nodes[${index}]`;
    if (!isRecord(node)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    requireString(node.instanceId, `${path}.instanceId`, errors);
    if (!isRecord(node.meta)) errors.push(`${path}.meta must contain id and version`);
    else {
      requireString(node.meta.id, `${path}.meta.id`, errors);
      requireString(node.meta.version, `${path}.meta.version`, errors);
    }
    if (instances.has(node.instanceId)) errors.push(`${path}.instanceId is duplicated`);
    instances.set(node.instanceId, node);
    if (
      !isRecord(node.position) ||
      !Number.isFinite(node.position.x) ||
      !Number.isFinite(node.position.y)
    ) {
      errors.push(`${path}.position must contain finite x and y values`);
    }
    if (!isRecord(node.portValues) || !isRecord(node.paramValues))
      errors.push(`${path} portValues and paramValues must be objects`);
    if (Object.hasOwn(node, "runtime"))
      errors.push(`${path}.runtime is not allowed; runtime state belongs to WorkflowRun`);
    const metaKey = isRecord(node.meta) ? `${node.meta.id}@${node.meta.version}` : "";
    const meta = nodeMetas instanceof Map ? nodeMetas.get(metaKey) : nodeMetas?.[metaKey];
    if (meta?.type === "start") startCount += 1;
    if (meta?.type === "end") endCount += 1;
    if ((nodeMetas?.size ?? Object.keys(nodeMetas ?? {}).length) > 0 && !meta)
      errors.push(`${path} references an unavailable node template version`);
    if (meta) {
      if (meta.type === "start") {
        const schemaParam = meta.params.find((param) => param.name === "inputSchema");
        const inputSchema =
          node.paramValues?.inputSchema === undefined
            ? schemaParam?.defaultValue
            : node.paramValues.inputSchema;
        try {
          validateWorkflowStartSchema(inputSchema);
        } catch (error) {
          errors.push(error?.message || String(error));
        }
      }
      for (const name of Object.keys(node.portValues ?? {})) {
        const binding = node.portValues[name];
        const port = meta.inputs.find((candidate) => candidate.name === name);
        if (!port) errors.push(`${path} has an unknown input port ${name}`);
        else if (
          !port.allowStaticValue ||
          binding?.mode !== "static" ||
          !isJsonValue(binding.staticValue)
        )
          errors.push(`${path}.portValues.${name} is not a valid static input binding`);
        else if (!valueMatchesType(binding.staticValue, port.type))
          errors.push(`${path}.portValues.${name}.staticValue does not match its input type`);
      }
      for (const name of Object.keys(node.paramValues ?? {})) {
        const param = meta.params.find((candidate) => candidate.name === name);
        if (!param) {
          errors.push(`${path} has an unknown parameter ${name}`);
        } else if (
          !valueMatchesType(
            node.paramValues[name],
            param.type === "select" ? "string" : param.type === "json" ? "any" : param.type,
          ) ||
          (param.type === "select" &&
            !param.options.some((option) => option.value === node.paramValues[name]))
        ) {
          errors.push(`${path}.paramValues.${name} does not match ${param.type}`);
        }
      }
      for (const param of meta.params) {
        if (
          requireComplete &&
          param.required &&
          node.paramValues?.[param.name] === undefined &&
          param.defaultValue === undefined
        )
          errors.push(`${path} is missing required parameter ${param.name}`);
      }
    }
  }

  if (instances.size > 0 && startCount !== 1)
    errors.push("workflow must contain exactly one Start node");
  if (instances.size > 0 && endCount < 1)
    errors.push("workflow must contain at least one End node");

  const edgeIds = new Set();
  const incomingCounts = new Map();
  const outgoingNodes = new Map();
  for (const [index, edge] of workflow.edges.entries()) {
    const path = `workflow.edges[${index}]`;
    if (!isRecord(edge)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    for (const key of ["sourceNodeId", "sourcePort", "targetNodeId", "targetPort"]) {
      requireString(edge[key], `${path}.${key}`, errors);
    }
    requireString(edge.id, `${path}.id`, errors);
    if (edgeIds.has(edge.id)) errors.push(`${path}.id is duplicated`);
    edgeIds.add(edge.id);
    if (!instances.has(edge.sourceNodeId)) errors.push(`${path} references a missing source node`);
    if (!instances.has(edge.targetNodeId)) errors.push(`${path} references a missing target node`);
    if (edge.sourceNodeId === edge.targetNodeId)
      errors.push(`${path} cannot connect a node to itself`);
    const source = instances.get(edge.sourceNodeId);
    const target = instances.get(edge.targetNodeId);
    const sourceKey = source?.meta ? `${source.meta.id}@${source.meta.version}` : "";
    const targetKey = target?.meta ? `${target.meta.id}@${target.meta.version}` : "";
    const sourceMeta = nodeMetas instanceof Map ? nodeMetas.get(sourceKey) : nodeMetas?.[sourceKey];
    const targetMeta = nodeMetas instanceof Map ? nodeMetas.get(targetKey) : nodeMetas?.[targetKey];
    if (sourceMeta && !sourceMeta.outputs.some((port) => port.name === edge.sourcePort))
      errors.push(`${path} references an unknown source output`);
    if (targetMeta && !targetMeta.inputs.some((port) => port.name === edge.targetPort))
      errors.push(`${path} references an unknown target input`);
    const sourcePort = sourceMeta?.outputs.find((port) => port.name === edge.sourcePort);
    const targetPort = targetMeta?.inputs.find((port) => port.name === edge.targetPort);
    if (sourcePort && targetPort && !isCompatibleType(sourcePort.type, edgeValueType(targetPort)))
      errors.push(`${path} connects incompatible port types`);
    if (targetPort) {
      const key = `${edge.targetNodeId}:${edge.targetPort}`;
      const count = (incomingCounts.get(key) ?? 0) + 1;
      incomingCounts.set(key, count);
      if (count > 1 && !targetPort.multi)
        errors.push(`${path} connects more than once to a single-value input`);
    }
    if (source && target) {
      const next = outgoingNodes.get(source.instanceId) ?? [];
      next.push(target.instanceId);
      outgoingNodes.set(source.instanceId, next);
    }
  }
  for (const node of workflow.nodes) {
    const metaKey = node.meta ? `${node.meta.id}@${node.meta.version}` : "";
    const meta = nodeMetas instanceof Map ? nodeMetas.get(metaKey) : nodeMetas?.[metaKey];
    for (const port of meta?.inputs ?? []) {
      const hasStatic = node.portValues?.[port.name]?.mode === "static";
      const hasLink = (incomingCounts.get(`${node.instanceId}:${port.name}`) ?? 0) > 0;
      if (hasStatic && hasLink)
        errors.push(
          `Node ${node.instanceId} input ${port.name} cannot have both a static value and a connection`,
        );
      if (requireComplete && port.required && !hasStatic && !hasLink)
        errors.push(`Node ${node.instanceId} is missing required input ${port.name}`);
      const binding = node.portValues?.[port.name];
      if (binding?.mode === "static" && !valueMatchesType(binding.staticValue, port.type))
        errors.push(`Node ${node.instanceId} has an invalid value for input ${port.name}`);
    }
  }
  const visited = new Set();
  const visiting = new Set();
  const hasCycle = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of outgoingNodes.get(id) ?? []) if (hasCycle(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if ([...outgoingNodes.keys()].some(hasCycle)) errors.push("workflow.edges contains a cycle");
  if (requireComplete && instances.size > 0) {
    const start = workflow.nodes.find((node) => {
      const reference = node.meta ? `${node.meta.id}@${node.meta.version}` : "";
      const meta = nodeMetas instanceof Map ? nodeMetas.get(reference) : nodeMetas?.[reference];
      return meta?.type === "start";
    });
    if (start) {
      const reachable = new Set([start.instanceId]);
      const pending = [start.instanceId];
      for (let index = 0; index < pending.length; index += 1) {
        for (const target of outgoingNodes.get(pending[index]) ?? []) {
          if (reachable.has(target)) continue;
          reachable.add(target);
          pending.push(target);
        }
      }
      for (const node of workflow.nodes)
        if (!reachable.has(node.instanceId))
          errors.push(`Node ${node.instanceId} is unreachable from the Start node`);
    }
  }
  return errors;
}

export function createWorkflow({
  id,
  name,
  workspaceId,
  description = "",
  createdAt = new Date().toISOString(),
}) {
  const workflow = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id,
    workspaceId,
    name,
    description,
    revision: 0,
    nodes: [],
    edges: [],
    createdAt,
    updatedAt: createdAt,
  };
  const errors = validateWorkflow(workflow);
  if (errors.length) throw new TypeError(errors.join("; "));
  return workflow;
}

export function createWorkflowEvent({
  workflowId,
  workspaceId,
  revision,
  actor,
  command,
  timestamp = new Date().toISOString(),
}) {
  if (!workflowId || !Number.isSafeInteger(revision) || revision < 1)
    throw new TypeError("Invalid workflow event identity");
  if (!workspaceId) throw new TypeError("Workflow event workspaceId is required");
  if (!new Set(["user", "agent", "system"]).has(actor))
    throw new TypeError("Invalid workflow event actor");
  if (!isRecord(command) || typeof command.idempotencyKey !== "string" || !command.idempotencyKey) {
    throw new TypeError("Workflow command must include an idempotencyKey");
  }
  if (!isJsonValue(command)) throw new TypeError("Workflow command must be JSON-compatible");
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowId,
    workspaceId,
    revision,
    actor,
    timestamp,
    command,
  };
}
