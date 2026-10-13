// ABOUTME: Factory and validation helpers for creating and resuming immutable
// workflow run records before execution.

import { BUILTIN_NODE_METAS, nodeMetaKey } from "./builtin-node-registry.js";
import {
  assertJson,
  builtins,
  captureNodeMetaSnapshot,
  clone,
  jsonByteLength,
  MAX_NODE_OUTPUT_BYTES,
  nodeMetaRegistry,
} from "./workflow-builtin-executors.js";
import {
  normalizeWorkflowInputBindings,
  stripWorkflowNodeRuntime,
  validateWorkflow,
  valueMatchesType,
} from "./workflow-contracts.js";
import { validateWorkflowStartInput } from "./workflow-start-schema.js";

export const RUN_SCHEMA_VERSION = 1;
export const RUN_STATES = new Set([
  "queued",
  "running",
  "success",
  "error",
  "cancelled",
  "interrupted",
]);
export const MAX_RUN_CONCURRENCY = 4;
export const MAX_RUN_JSON_BYTES = 7 * 1024 * 1024;
export const MAX_RUN_MUTABLE_BYTES = MAX_RUN_JSON_BYTES - 128 * 1024;
export const MAX_RUN_EVENT_BYTES = 1024 * 1024;
export const MAX_RUN_LOG_BYTES = 2 * 1024 * 1024;
export const MAX_RUN_EVENT_COUNT = 10_000;
export const TERMINAL_RUN_EVENTS = new Set([
  "node_failed",
  "node_interrupted",
  "run_completed",
  "run_failed",
  "run_cancelled",
]);

export function assertRunSize(run) {
  const durable = { ...run };
  delete durable.events;
  if (jsonByteLength(durable) > MAX_RUN_MUTABLE_BYTES)
    throw new RangeError("Workflow run state exceeds the 7 MB limit");
}

export function missingWorkflowExecutors(
  workflow,
  nodeMetas = BUILTIN_NODE_METAS,
  executors = new Map(),
  metaSnapshot,
) {
  const registry = nodeMetaRegistry(nodeMetas, metaSnapshot);
  const available = new Map([...builtins(), ...executors]);
  const missing = [];
  for (const node of workflow?.nodes ?? []) {
    const meta = registry.get(nodeMetaKey(node.meta));
    if (!meta || meta.type === "start" || meta.type === "end") continue;
    if (!available.has(nodeMetaKey(node.meta))) missing.push(meta.label);
  }
  return missing;
}

export function createWorkflowRun(
  workflow,
  input = {},
  {
    id,
    createdAt = new Date().toISOString(),
    nodeMetas = BUILTIN_NODE_METAS,
    maxConcurrency = 1,
    nodeMetaSnapshot,
  } = {},
) {
  if (
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > MAX_RUN_CONCURRENCY
  )
    throw new TypeError(`maxConcurrency must be an integer between 1 and ${MAX_RUN_CONCURRENCY}`);
  const registry = nodeMetaRegistry(nodeMetas, nodeMetaSnapshot);
  const normalizedWorkflow = normalizeWorkflowInputBindings(stripWorkflowNodeRuntime(workflow));
  const errors = validateWorkflow(normalizedWorkflow, registry, { requireComplete: true });
  if (errors.length) throw new TypeError(`Workflow cannot run: ${errors.join("; ")}`);
  assertJson(input, "Workflow input");
  if (jsonByteLength(input) > MAX_NODE_OUTPUT_BYTES)
    throw new RangeError("Workflow input exceeds the 512 KB limit");
  const snapshot = normalizedWorkflow;
  const frozenNodeMetas = captureNodeMetaSnapshot(snapshot, registry);
  const startNode = snapshot.nodes.find(
    (node) => registry.get(nodeMetaKey(node.meta))?.type === "start",
  );
  const startMeta = startNode && registry.get(nodeMetaKey(startNode.meta));
  const startOutput = startMeta?.outputs.find((port) => port.name === "input");
  if (!startOutput || !valueMatchesType(input, startOutput.type))
    throw new TypeError("Workflow input does not match the Start node input schema");
  validateWorkflowStartInput(
    input,
    startNode.paramValues?.inputSchema === undefined
      ? { properties: {}, required: [] }
      : startNode.paramValues.inputSchema,
  );
  const run = {
    schemaVersion: RUN_SCHEMA_VERSION,
    id,
    workflowId: snapshot.id,
    workspaceId: snapshot.workspaceId,
    workflowRevision: snapshot.revision,
    snapshot,
    nodeMetaSnapshot: frozenNodeMetas,
    input: clone(input),
    maxConcurrency,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    nodeStates: Object.fromEntries(
      snapshot.nodes.map((node) => [
        node.instanceId,
        { status: "idle", logs: [], output: null, error: null },
      ]),
    ),
    events: [],
    result: null,
    error: null,
  };
  assertRunSize(run);
  return run;
}

export function createWorkflowRetryRun(
  previousRun,
  nodeId,
  { id, createdAt = new Date().toISOString(), nodeMetas = BUILTIN_NODE_METAS } = {},
) {
  validateWorkflowRun(previousRun);
  if (!new Set(["error", "cancelled", "interrupted"]).has(previousRun.status))
    throw new TypeError("Only a failed, cancelled, or interrupted run can be resumed.");
  if (!previousRun.snapshot || previousRun.id === undefined)
    throw new TypeError("The previous Run snapshot is unavailable.");
  const registry = nodeMetaRegistry(nodeMetas, previousRun.nodeMetaSnapshot);
  const workflowSnapshot = normalizeWorkflowInputBindings(
    stripWorkflowNodeRuntime(previousRun.snapshot),
  );
  const snapshotErrors = validateWorkflow(workflowSnapshot, registry, {
    requireComplete: true,
  });
  if (snapshotErrors.length)
    throw new TypeError(`Previous Run snapshot is invalid: ${snapshotErrors.join("; ")}`);
  const targetState = previousRun.nodeStates?.[nodeId];
  if (!targetState || !new Set(["error", "interrupted"]).has(targetState.status))
    throw new TypeError("Select a node that failed or was interrupted in the previous Run.");

  const descendants = new Set([nodeId]);
  const outgoing = new Map();
  for (const edge of workflowSnapshot.edges) {
    const targets = outgoing.get(edge.sourceNodeId) ?? [];
    targets.push(edge.targetNodeId);
    outgoing.set(edge.sourceNodeId, targets);
  }
  const queue = [nodeId];
  for (let index = 0; index < queue.length; index += 1) {
    for (const next of outgoing.get(queue[index]) ?? []) {
      if (descendants.has(next)) continue;
      descendants.add(next);
      queue.push(next);
    }
  }

  const resumed = createWorkflowRun(workflowSnapshot, previousRun.input, {
    id,
    createdAt,
    nodeMetas,
    maxConcurrency: previousRun.maxConcurrency ?? 1,
    nodeMetaSnapshot: previousRun.nodeMetaSnapshot,
  });
  const explicitSkipIds = new Set(
    (previousRun.events ?? [])
      .filter((event) => event.type === "node_skipped")
      .map((event) => event.nodeId),
  );
  const retrySeedStates = {};
  for (const node of workflowSnapshot.nodes) {
    const state = previousRun.nodeStates?.[node.instanceId];
    if (!state) continue;
    if (
      descendants.has(node.instanceId) ||
      state.status === "running" ||
      state.status === "error" ||
      state.status === "interrupted" ||
      (state.status === "skipped" && !explicitSkipIds.has(node.instanceId))
    ) {
      continue;
    }
    if (state.status === "success")
      retrySeedStates[node.instanceId] = {
        status: "success",
        output: clone(state.output),
      };
    else if (state.status === "skipped") retrySeedStates[node.instanceId] = { status: "skipped" };
  }
  resumed.retrySeedStates = retrySeedStates;
  resumed.retryOfRunId = previousRun.id;
  resumed.resumeFromNodeId = nodeId;
  return resumed;
}

export function validateWorkflowRun(run) {
  if (!run || run.schemaVersion !== RUN_SCHEMA_VERSION || !RUN_STATES.has(run.status))
    throw new TypeError("Workflow run record is invalid");
  if (
    run.maxConcurrency !== undefined &&
    (!Number.isSafeInteger(run.maxConcurrency) ||
      run.maxConcurrency < 1 ||
      run.maxConcurrency > MAX_RUN_CONCURRENCY)
  )
    throw new TypeError("Workflow run maxConcurrency is invalid");
  if (run.retryOfRunId !== undefined && typeof run.retryOfRunId !== "string")
    throw new TypeError("Workflow run retryOfRunId is invalid");
  if (run.resumeFromNodeId !== undefined && typeof run.resumeFromNodeId !== "string")
    throw new TypeError("Workflow run resumeFromNodeId is invalid");
  return true;
}
