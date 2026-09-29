// ABOUTME: Executes immutable workflow snapshots through registered, trusted
// node executors. This module never evaluates user-provided source code.

import { BUILTIN_NODE_METAS, nodeMetaKey } from "./builtin-node-registry.js";
import {
  normalizeWorkflowInputBindings,
  stripWorkflowNodeRuntime,
  validateNodeMeta,
  validateWorkflow,
  valueMatchesType,
} from "./workflow-contracts.js";
import { validateWorkflowStartInput } from "./workflow-start-schema.js";

const RUN_SCHEMA_VERSION = 1;
const RUN_STATES = new Set(["queued", "running", "success", "error", "cancelled", "interrupted"]);
const MAX_RUN_CONCURRENCY = 4;
const MAX_RUN_JSON_BYTES = 7 * 1024 * 1024;
const MAX_RUN_MUTABLE_BYTES = MAX_RUN_JSON_BYTES - 128 * 1024;
const MAX_RUN_EVENT_BYTES = 1024 * 1024;
const MAX_NODE_OUTPUT_BYTES = 512 * 1024;
const MAX_RUN_LOG_BYTES = 2 * 1024 * 1024;
const MAX_RUN_EVENT_COUNT = 10_000;
const TERMINAL_RUN_EVENTS = new Set([
  "node_failed",
  "node_interrupted",
  "run_completed",
  "run_failed",
  "run_cancelled",
]);

function clone(value) {
  return structuredClone(value);
}

function assertJson(value, name) {
  try {
    JSON.stringify(value);
  } catch {
    throw new TypeError(`${name} must be JSON serializable`);
  }
}

function jsonByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assertRunSize(run) {
  const durable = { ...run };
  delete durable.events;
  if (jsonByteLength(durable) > MAX_RUN_MUTABLE_BYTES)
    throw new RangeError("Workflow run state exceeds the 7 MB limit");
}

function recordBytes(value) {
  return jsonByteLength(value);
}

function errorText(error) {
  return (error?.message || String(error)).slice(0, 2_048);
}

function getByPath(value, path) {
  if (typeof path !== "string" || path.length === 0) return undefined;
  const parts = path.split(".");
  if (parts.some((part) => part.length === 0)) return undefined;
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(part)) return undefined;
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index >= current.length) return undefined;
      current = current[index];
    } else if (typeof current === "object" && Object.hasOwn(current, part)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function jsonValuesEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonValuesEqual(left[key], right[key]),
    )
  );
}

function compare(left, operator, right) {
  switch (operator) {
    case "equals":
      return jsonValuesEqual(left, right);
    case "notEquals":
      return !jsonValuesEqual(left, right);
    case "exists":
      return left !== undefined;
    default:
      throw new Error(`Unsupported declarative comparison operator: ${operator}`);
  }
}

function builtins() {
  return new Map([
    ["pipline.start@1.0.0", async ({ inputs, runInput }) => ({ input: inputs.input ?? runInput })],
    ["pipline.end@1.0.0", async ({ inputs }) => ({ result: inputs.result })],
    ["pipline.assign@1.0.0", async ({ params }) => ({ value: { [params.name]: params.value } })],
    [
      "pipline.assign@2.0.0",
      async ({ inputs, params }) => ({ output: { [params.varName]: inputs.value } }),
    ],
    [
      "pipline.template@1.0.0",
      async ({ inputs, params }) => {
        const text = params.template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, path) => {
          const value = getByPath(inputs.values, path);
          return value === undefined || value === null
            ? ""
            : typeof value === "string"
              ? value
              : JSON.stringify(value);
        });
        return { text };
      },
    ],
    [
      "pipline.extract@1.0.0",
      async ({ inputs, params }) => {
        const value = getByPath(inputs.source, params.path);
        if (value === undefined) throw new Error(`Extract path not found: ${params.path}`);
        return { value };
      },
    ],
    [
      "pipline.extract@2.0.0",
      async ({ inputs, params }) => {
        const value = getByPath(inputs.source, params.path);
        if (value === undefined) throw new Error(`Extract path not found: ${params.path}`);
        return { value };
      },
    ],
    [
      "pipline.merge@1.0.0",
      async ({ inputs, params }) => {
        const result = {};
        const values = inputs.values ?? [];
        if (!Array.isArray(values)) throw new Error("Merge values input must be an array");
        for (const object of values) {
          if (!object || Array.isArray(object) || typeof object !== "object")
            throw new Error("Merge accepts only objects");
          for (const [key, value] of Object.entries(object)) {
            if (Object.hasOwn(result, key)) {
              if (params.conflict === "error") throw new Error(`Merge key conflict: ${key}`);
              if (params.conflict === "first") continue;
            }
            Object.defineProperty(result, key, {
              value,
              enumerable: true,
              configurable: true,
              writable: true,
            });
          }
        }
        return { result };
      },
    ],
    ["pipline.merge@2.0.0", async ({ inputs }) => ({ list: inputs.in0 ?? [] })],
    [
      "pipline.merge@3.0.0",
      async ({ inputs, params }) => {
        const values = inputs.in0 ?? [];
        if (!Array.isArray(values)) throw new Error("Merge values input must be an array");
        if (params.mode === "collect") return { list: values };
        if (params.mode === "concatenate") {
          const list = [];
          for (const value of values) {
            if (!Array.isArray(value)) throw new Error("Merge concatenation accepts only arrays");
            for (const item of value) list.push(item);
          }
          return { list };
        }
        throw new Error(`Unsupported Merge array mode: ${params.mode}`);
      },
    ],
    [
      "pipline.merge-by-port@1.0.0",
      async ({ inputs }) => ({
        result: {
          input0: inputs.input0 ?? [],
          input1: inputs.input1 ?? [],
          input2: inputs.input2 ?? [],
          input3: inputs.input3 ?? [],
        },
      }),
    ],
    [
      "pipline.filter@1.0.0",
      async ({ inputs, params }) => {
        if (!Array.isArray(inputs.items)) throw new Error("Filter items input must be an array");
        return {
          items: inputs.items.filter((item) =>
            compare(getByPath(item, params.path), params.operator, params.value),
          ),
        };
      },
    ],
    [
      "pipline.condition@1.0.0",
      async ({ inputs, params }) => {
        const branch = compare(inputs.value, params.operator, params.expected) ? "true" : "false";
        return { [branch]: inputs.value };
      },
    ],
    [
      "pipline.condition@2.0.0",
      async ({ inputs, params }) => {
        const value = params.path === "" ? inputs.value : getByPath(inputs.value, params.path);
        const branch = compare(value, params.operator, params.expected) ? "true" : "false";
        return { [branch]: inputs.value };
      },
    ],
  ]);
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

function topologicalOrder(workflow) {
  const orderIndex = new Map(workflow.nodes.map((node, index) => [node.instanceId, index]));
  const indegree = new Map(workflow.nodes.map((node) => [node.instanceId, 0]));
  const outgoing = new Map();
  for (const edge of workflow.edges) {
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
    const targets = outgoing.get(edge.sourceNodeId) ?? [];
    targets.push(edge.targetNodeId);
    outgoing.set(edge.sourceNodeId, targets);
  }
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  ready.sort((left, right) => orderIndex.get(left) - orderIndex.get(right));
  const sorted = [];
  while (ready.length) {
    const id = ready.shift();
    sorted.push(id);
    for (const target of outgoing.get(id) ?? []) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        ready.push(target);
        ready.sort((left, right) => orderIndex.get(left) - orderIndex.get(right));
      }
    }
  }
  if (sorted.length !== workflow.nodes.length) throw new Error("Workflow graph contains a cycle");
  return sorted;
}

function resolveInputs(node, workflow, outputs, meta, activeEdges = null) {
  const resolved = {};
  for (const port of meta.inputs) {
    const links = workflow.edges.filter(
      (edge) =>
        edge.targetNodeId === node.instanceId &&
        edge.targetPort === port.name &&
        (!activeEdges || activeEdges.has(edge.id)),
    );
    const binding = node.portValues?.[port.name];
    if (links.length) {
      const values = links.map((edge) => {
        const output = outputs.get(edge.sourceNodeId);
        if (!output || !Object.hasOwn(output, edge.sourcePort))
          throw new Error(`Upstream output is missing: ${edge.sourceNodeId}.${edge.sourcePort}`);
        return output[edge.sourcePort];
      });
      resolved[port.name] = port.multi ? values : values[0];
    } else if (binding?.mode === "static") {
      resolved[port.name] = clone(binding.staticValue);
    } else if (port.required) {
      throw new Error(`Required input is not connected: ${port.label}`);
    }
  }
  return resolved;
}

function validateOutputs(meta, outputs) {
  assertJson(outputs, "Node outputs");
  if (jsonByteLength(outputs) > MAX_NODE_OUTPUT_BYTES)
    throw new RangeError("Node outputs exceed the 512 KB limit");
  for (const port of meta.outputs) {
    if (outputs[port.name] === undefined) {
      if (port.required) throw new Error(`Required output is missing: ${port.label}`);
      continue;
    }
    assertJson(outputs[port.name], `Output ${port.name}`);
    if (!valueMatchesType(outputs[port.name], port.type))
      throw new Error(`Output ${port.label} does not match ${JSON.stringify(port.type)}`);
  }
  for (const name of Object.keys(outputs)) {
    if (!meta.outputs.some((port) => port.name === name))
      throw new Error(`Executor returned unknown output: ${name}`);
  }
}

function validateInputs(meta, inputs) {
  for (const port of meta.inputs) {
    if (!Object.hasOwn(inputs, port.name)) {
      if (port.required) throw new Error(`Required input is missing: ${port.label}`);
      continue;
    }
    if (!valueMatchesType(inputs[port.name], port.type))
      throw new Error(`Input ${port.label} does not match ${JSON.stringify(port.type)}`);
  }
}

function resolveParams(meta, supplied = {}) {
  const resolved = {};
  for (const param of meta.params) {
    if (Object.hasOwn(supplied, param.name)) resolved[param.name] = clone(supplied[param.name]);
    else if (param.defaultValue !== undefined) resolved[param.name] = clone(param.defaultValue);
  }
  return resolved;
}

function nodeMetaRegistry(nodeMetas, snapshot = {}) {
  const registry = new Map(nodeMetas ?? []);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    throw new TypeError("Workflow run NodeMeta snapshot is invalid");
  for (const [key, meta] of Object.entries(snapshot)) {
    if (nodeMetaKey(meta) !== key || validateNodeMeta(meta).length)
      throw new TypeError(`Workflow run NodeMeta snapshot entry is invalid: ${key}`);
    registry.set(key, clone(meta));
  }
  return registry;
}

function captureNodeMetaSnapshot(workflow, registry) {
  const snapshot = {};
  for (const node of workflow.nodes) {
    const key = nodeMetaKey(node.meta);
    if (Object.hasOwn(snapshot, key)) continue;
    const meta = registry.get(key);
    if (!meta) throw new TypeError(`Workflow node template is unavailable: ${key}`);
    snapshot[key] = clone(meta);
  }
  return snapshot;
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

export class WorkflowRunner {
  #executors;
  #clock;
  #nodeMetas;

  constructor({
    executors = new Map(),
    clock = () => new Date().toISOString(),
    nodeMetas = BUILTIN_NODE_METAS,
  } = {}) {
    this.#executors = new Map([...builtins(), ...executors]);
    this.#clock = clock;
    this.#nodeMetas = nodeMetas;
  }

  async run(run, { signal, onEvent = () => {} } = {}) {
    if (
      !run ||
      run.schemaVersion !== RUN_SCHEMA_VERSION ||
      !RUN_STATES.has(run.status) ||
      run.status !== "queued"
    )
      throw new TypeError("A queued workflow run is required");
    validateWorkflowRun(run);
    const runNodeMetas = nodeMetaRegistry(this.#nodeMetas, run.nodeMetaSnapshot);
    const snapshotErrors = validateWorkflow(run.snapshot, runNodeMetas, {
      requireComplete: true,
    });
    if (snapshotErrors.length)
      throw new TypeError(`Workflow run snapshot is invalid: ${snapshotErrors.join("; ")}`);
    const missingExecutors = missingWorkflowExecutors(run.snapshot, runNodeMetas, this.#executors);
    if (missingExecutors.length)
      throw new TypeError(`No trusted executor is registered for: ${missingExecutors.join(", ")}`);
    assertJson(run.input, "Workflow input");
    const active = clone(run);
    active.maxConcurrency ??= 1;
    const retrySeedStates = active.retrySeedStates ?? {};
    delete active.retrySeedStates;
    let durableBytes = recordBytes({ ...active, events: undefined });
    let logBytes = Object.values(active.nodeStates).reduce(
      (total, state) => total + state.logs.reduce((sum, message) => sum + recordBytes(message), 0),
      0,
    );
    const setNodeState = (instanceId, nextState) => {
      const previousState = active.nodeStates[instanceId];
      const nextBytes = durableBytes - recordBytes(previousState) + recordBytes(nextState);
      if (nextBytes > MAX_RUN_MUTABLE_BYTES)
        throw new RangeError("Workflow run state exceeds the 7 MB limit");
      active.nodeStates[instanceId] = nextState;
      durableBytes = nextBytes;
    };
    const emit = (type, detail = {}) => {
      const event = {
        id: `${active.id}:${active.events.length + 1}`,
        runId: active.id,
        workflowId: active.workflowId,
        revision: active.workflowRevision,
        type,
        timestamp: this.#clock(),
        ...detail,
      };
      const terminalReserve = active.snapshot.nodes.length + 1;
      if (
        active.events.length >= MAX_RUN_EVENT_COUNT - terminalReserve &&
        !TERMINAL_RUN_EVENTS.has(type)
      )
        throw new RangeError("Workflow run reached the 10,000 event limit");
      if (active.events.length >= MAX_RUN_EVENT_COUNT)
        throw new RangeError("Workflow run reached the 10,000 event limit");
      if (jsonByteLength(event) > MAX_RUN_EVENT_BYTES)
        throw new RangeError("Workflow run event exceeds the 1 MB limit");
      active.events.push(event);
      active.updatedAt = event.timestamp;
      onEvent(clone(event), clone(active));
    };
    const outputs = new Map(
      Object.entries(active.nodeStates)
        .filter(([, state]) => state.status === "success" && state.output !== null)
        .map(([nodeId, state]) => [nodeId, clone(state.output)]),
    );
    const activeEdges = new Set();
    for (const edge of active.snapshot.edges) {
      const output = outputs.get(edge.sourceNodeId);
      if (output && Object.hasOwn(output, edge.sourcePort)) activeEdges.add(edge.id);
    }
    active.status = "running";
    emit("run_started", {
      ...(active.retryOfRunId ? { retryOfRunId: active.retryOfRunId } : {}),
      ...(active.resumeFromNodeId ? { resumeFromNodeId: active.resumeFromNodeId } : {}),
    });
    for (const node of active.snapshot.nodes) {
      const seed = retrySeedStates[node.instanceId];
      if (!seed) continue;
      if (seed.status === "success") {
        const state = {
          status: "success",
          logs: [],
          output: clone(seed.output),
          error: null,
        };
        setNodeState(node.instanceId, state);
        outputs.set(node.instanceId, clone(state.output));
        for (const edge of active.snapshot.edges) {
          if (edge.sourceNodeId === node.instanceId && Object.hasOwn(state.output, edge.sourcePort))
            activeEdges.add(edge.id);
        }
        emit("node_completed", {
          nodeId: node.instanceId,
          output: state.output,
          ...(active.retryOfRunId ? { reusedFromRunId: active.retryOfRunId } : {}),
        });
      } else if (seed.status === "skipped") {
        setNodeState(node.instanceId, {
          status: "skipped",
          logs: [],
          output: null,
          error: null,
        });
        emit("node_skipped", {
          nodeId: node.instanceId,
          reason: "Preserved inactive branch from the previous Run",
        });
      }
    }
    try {
      const byId = new Map(active.snapshot.nodes.map((node) => [node.instanceId, node]));
      const orderedIds = topologicalOrder(active.snapshot);
      const orderIndex = new Map(orderedIds.map((id, index) => [id, index]));
      const pending = new Set(
        orderedIds.filter((instanceId) => active.nodeStates[instanceId]?.status === "idle"),
      );
      const running = new Map();
      let firstFailure = null;

      const executeNode = async (instanceId) => {
        const node = byId.get(instanceId);
        const meta = runNodeMetas.get(nodeMetaKey(node.meta));
        try {
          if (meta.type === "start") {
            const nodeOutput = outputs.get(instanceId) ?? { input: clone(active.input) };
            validateWorkflowStartInput(
              nodeOutput.input,
              node.paramValues?.inputSchema === undefined
                ? { properties: {}, required: [] }
                : node.paramValues.inputSchema,
            );
            validateOutputs(meta, nodeOutput);
            outputs.set(instanceId, nodeOutput);
            for (const edge of active.snapshot.edges.filter(
              (item) => item.sourceNodeId === instanceId,
            ))
              activeEdges.add(edge.id);
            setNodeState(instanceId, {
              status: "success",
              logs: [],
              output: nodeOutput,
              error: null,
            });
            emit("node_completed", { nodeId: instanceId, output: nodeOutput });
            return null;
          }
          if (meta.type === "end") {
            const inputs = resolveInputs(node, active.snapshot, outputs, meta, activeEdges);
            validateInputs(meta, inputs);
            const { returnMode = "variable" } = resolveParams(meta, node.paramValues);
            let result;
            if (returnMode === "variable") result = inputs.result;
            else if (returnMode === "text")
              result =
                typeof inputs.result === "string" ? inputs.result : JSON.stringify(inputs.result);
            else throw new TypeError(`Unsupported End return mode: ${returnMode}`);
            const nodeOutput = { result };
            outputs.set(instanceId, nodeOutput);
            setNodeState(instanceId, {
              status: "success",
              logs: [],
              output: nodeOutput,
              error: null,
            });
            emit("node_completed", { nodeId: instanceId, output: nodeOutput });
            return null;
          }

          setNodeState(instanceId, { ...active.nodeStates[instanceId], status: "running" });
          emit("node_started", { nodeId: instanceId, nodeType: meta.type });
          const executor = this.#executors.get(nodeMetaKey(node.meta));
          if (!executor)
            throw new Error(`No trusted executor is registered for node ${meta.label}`);
          const inputs = resolveInputs(node, active.snapshot, outputs, meta, activeEdges);
          validateInputs(meta, inputs);
          const log = (message) => {
            const state = active.nodeStates[instanceId];
            const text = String(message);
            if (new TextEncoder().encode(text).byteLength > 64 * 1024)
              throw new RangeError("A node log message exceeds the 64 KB limit");
            const messageBytes = recordBytes(text);
            if (logBytes + messageBytes > MAX_RUN_LOG_BYTES)
              throw new RangeError("Workflow run logs exceed the 2 MB limit");
            setNodeState(instanceId, { ...state, logs: [...state.logs, text] });
            logBytes += messageBytes;
            emit("node_log", { nodeId: instanceId, message: text });
          };
          const nodeOutput = await executor({
            node: clone(node),
            meta: clone(meta),
            inputs,
            params: resolveParams(meta, node.paramValues),
            runInput: clone(active.input),
            workflow: clone(active.snapshot),
            runId: active.id,
            nodeMetas: runNodeMetas,
            signal,
            log,
          });
          if (signal?.aborted) throw new DOMException("Workflow run was cancelled", "AbortError");
          validateOutputs(meta, nodeOutput ?? {});
          const clonedOutput = clone(nodeOutput ?? {});
          const previousState = active.nodeStates[instanceId];
          setNodeState(instanceId, {
            status: "success",
            logs: previousState.logs,
            output: clonedOutput,
            error: null,
          });
          outputs.set(instanceId, clonedOutput);
          for (const edge of active.snapshot.edges.filter(
            (item) =>
              item.sourceNodeId === instanceId && Object.hasOwn(nodeOutput ?? {}, item.sourcePort),
          ))
            activeEdges.add(edge.id);
          emit("node_completed", { nodeId: instanceId, output: clonedOutput });
          return null;
        } catch (error) {
          const message = errorText(error);
          const state = active.nodeStates[instanceId];
          outputs.delete(instanceId);
          if (error?.name === "AbortError") {
            setNodeState(instanceId, {
              ...state,
              output: null,
              status: "interrupted",
              error: message,
            });
            emit("node_interrupted", { nodeId: instanceId, error: message });
          } else {
            setNodeState(instanceId, { ...state, output: null, status: "error", error: message });
            emit("node_failed", { nodeId: instanceId, error: message });
          }
          return error;
        }
      };

      while (pending.size || running.size) {
        if (signal?.aborted && !firstFailure) {
          firstFailure = new DOMException("Workflow run was cancelled", "AbortError");
        }
        if (firstFailure) {
          if (running.size) await Promise.allSettled(running.values());
          running.clear();
          break;
        }
        let madeProgress = false;
        if (!firstFailure) {
          const ready = [...pending]
            .filter((instanceId) =>
              active.snapshot.edges
                .filter((edge) => edge.targetNodeId === instanceId)
                .every((edge) => {
                  const status = active.nodeStates[edge.sourceNodeId]?.status;
                  return status !== "idle" && status !== "running";
                }),
            )
            .sort((left, right) => orderIndex.get(left) - orderIndex.get(right));

          for (const instanceId of ready) {
            const incoming = active.snapshot.edges.filter(
              (edge) => edge.targetNodeId === instanceId,
            );
            const node = byId.get(instanceId);
            const meta = runNodeMetas.get(nodeMetaKey(node.meta));
            if (incoming.length && !incoming.some((edge) => activeEdges.has(edge.id))) {
              pending.delete(instanceId);
              setNodeState(instanceId, {
                status: "skipped",
                logs: [],
                output: null,
                error: null,
              });
              emit("node_skipped", { nodeId: instanceId, reason: "No active incoming branch" });
              madeProgress = true;
              continue;
            }
            if (running.size >= active.maxConcurrency) break;
            if (
              meta.execution?.kind === "pi-agent" &&
              [...running.keys()].some(
                (id) =>
                  runNodeMetas.get(nodeMetaKey(byId.get(id).meta))?.execution?.kind === "pi-agent",
              )
            )
              continue;
            pending.delete(instanceId);
            running.set(instanceId, executeNode(instanceId));
            madeProgress = true;
          }
        }

        if (running.size) {
          const settled = await Promise.race(
            [...running].map(([instanceId, promise]) =>
              promise.then(
                (error) => ({ instanceId, error }),
                (error) => ({ instanceId, error }),
              ),
            ),
          );
          running.delete(settled.instanceId);
          if (settled.error && !firstFailure) firstFailure = settled.error;
          madeProgress = true;
        }
        if (!madeProgress && pending.size && !running.size)
          throw new Error("Workflow scheduler could not resolve pending node dependencies.");
      }
      if (firstFailure) throw firstFailure;
      const endNodes = active.snapshot.nodes.filter(
        (node) =>
          runNodeMetas.get(nodeMetaKey(node.meta))?.type === "end" &&
          active.nodeStates[node.instanceId]?.status === "success",
      );
      if (endNodes.length === 0)
        throw new Error("No End node completed; all result branches were skipped.");
      const unresolved = active.snapshot.nodes.filter((node) =>
        ["error", "interrupted"].includes(active.nodeStates[node.instanceId]?.status),
      );
      if (unresolved.length)
        throw new Error(
          `Run still has unresolved failed nodes: ${unresolved.map((node) => node.instanceId).join(", ")}`,
        );
      const results = endNodes.map((node) => outputs.get(node.instanceId)?.result);
      const result = results.length === 1 ? results[0] : results;
      assertJson(result, "Workflow result");
      if (jsonByteLength(result) > MAX_NODE_OUTPUT_BYTES)
        throw new RangeError("Workflow result exceeds the 512 KB limit");
      active.result = result;
      if (recordBytes({ ...active, events: undefined }) > MAX_RUN_JSON_BYTES) {
        active.result = null;
        throw new RangeError("Workflow run state exceeds the 7 MB limit");
      }
      active.status = "success";
      emit("run_completed", { result: active.result });
    } catch (error) {
      const terminalStatus = error?.name === "AbortError" ? "cancelled" : "error";
      const terminalError = errorText(error);
      for (const [instanceId, state] of Object.entries(active.nodeStates))
        if (state.status === "running") {
          const nodeStatus = terminalStatus === "cancelled" ? "interrupted" : "error";
          setNodeState(instanceId, {
            ...state,
            status: nodeStatus,
            error: terminalError,
          });
          emit(nodeStatus === "interrupted" ? "node_interrupted" : "node_failed", {
            nodeId: instanceId,
            error: terminalError,
          });
        } else if (state.status === "idle") {
          setNodeState(instanceId, { ...state, status: "skipped" });
          emit("node_skipped", {
            nodeId: instanceId,
            reason:
              terminalStatus === "cancelled"
                ? "Run cancelled before this node started"
                : "Run stopped after a node failed",
          });
        }
      active.status = terminalStatus;
      active.error = terminalError;
      emit(terminalStatus === "cancelled" ? "run_cancelled" : "run_failed", {
        error: terminalError,
      });
    }
    return active;
  }
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
