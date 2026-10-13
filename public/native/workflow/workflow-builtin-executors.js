// ABOUTME: Built-in trusted workflow node executors, graph topology helpers,
// and port/parameter validation utilities for the workflow runner.

import { nodeMetaKey } from "./builtin-node-registry.js";
import { validateNodeMeta, valueMatchesType } from "./workflow-contracts.js";

export const MAX_NODE_OUTPUT_BYTES = 512 * 1024;
const TEXT_ENCODER = new TextEncoder();

export function clone(value) {
  return structuredClone(value);
}

export function assertJson(value, name) {
  try {
    JSON.stringify(value);
  } catch {
    throw new TypeError(`${name} must be JSON serializable`);
  }
}

export function jsonByteLength(value) {
  return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
}

export function recordBytes(value) {
  return jsonByteLength(value);
}

export function errorText(error) {
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

export function builtins() {
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

export function topologicalOrder(workflow) {
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

export function resolveInputs(node, workflow, outputs, meta, activeEdges = null) {
  const linksByPort = new Map();
  for (const edge of workflow.edges) {
    if (edge.targetNodeId !== node.instanceId || (activeEdges && !activeEdges.has(edge.id)))
      continue;
    let list = linksByPort.get(edge.targetPort);
    if (!list) {
      list = [];
      linksByPort.set(edge.targetPort, list);
    }
    list.push(edge);
  }
  const resolved = {};
  for (const port of meta.inputs) {
    const links = linksByPort.get(port.name);
    const binding = node.portValues?.[port.name];
    if (links?.length) {
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

export function validateOutputs(meta, outputs) {
  assertJson(outputs, "Node outputs");
  if (jsonByteLength(outputs) > MAX_NODE_OUTPUT_BYTES)
    throw new RangeError("Node outputs exceed the 512 KB limit");
  const declaredOutputs = new Set();
  for (const port of meta.outputs) {
    declaredOutputs.add(port.name);
    if (outputs[port.name] === undefined) {
      if (port.required) throw new Error(`Required output is missing: ${port.label}`);
      continue;
    }
    assertJson(outputs[port.name], `Output ${port.name}`);
    if (!valueMatchesType(outputs[port.name], port.type))
      throw new Error(`Output ${port.label} does not match ${JSON.stringify(port.type)}`);
  }
  for (const name of Object.keys(outputs)) {
    if (!declaredOutputs.has(name)) throw new Error(`Executor returned unknown output: ${name}`);
  }
}

export function validateInputs(meta, inputs) {
  for (const port of meta.inputs) {
    if (!Object.hasOwn(inputs, port.name)) {
      if (port.required) throw new Error(`Required input is missing: ${port.label}`);
      continue;
    }
    if (!valueMatchesType(inputs[port.name], port.type))
      throw new Error(`Input ${port.label} does not match ${JSON.stringify(port.type)}`);
  }
}

export function resolveParams(meta, supplied = {}) {
  const resolved = {};
  for (const param of meta.params) {
    if (Object.hasOwn(supplied, param.name)) resolved[param.name] = clone(supplied[param.name]);
    else if (param.defaultValue !== undefined) resolved[param.name] = clone(param.defaultValue);
  }
  return resolved;
}

export function nodeMetaRegistry(nodeMetas, snapshot = {}) {
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

export function captureNodeMetaSnapshot(workflow, registry) {
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
