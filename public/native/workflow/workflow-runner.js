// ABOUTME: Executes immutable workflow snapshots through registered, trusted
// node executors. This module never evaluates user-provided source code.

import { BUILTIN_NODE_METAS, nodeMetaKey } from "./builtin-node-registry.js";
import {
  assertJson,
  builtins,
  clone,
  errorText,
  jsonByteLength,
  MAX_NODE_OUTPUT_BYTES,
  nodeMetaRegistry,
  recordBytes,
  resolveInputs,
  resolveParams,
  topologicalOrder,
  validateInputs,
  validateOutputs,
} from "./workflow-builtin-executors.js";
import { validateWorkflow } from "./workflow-contracts.js";
import {
  createWorkflowRetryRun,
  createWorkflowRun,
  MAX_RUN_EVENT_BYTES,
  MAX_RUN_EVENT_COUNT,
  MAX_RUN_JSON_BYTES,
  MAX_RUN_LOG_BYTES,
  MAX_RUN_MUTABLE_BYTES,
  missingWorkflowExecutors,
  RUN_SCHEMA_VERSION,
  RUN_STATES,
  TERMINAL_RUN_EVENTS,
  validateWorkflowRun,
} from "./workflow-run-factory.js";
import { validateWorkflowStartInput } from "./workflow-start-schema.js";

export { createWorkflowRetryRun, createWorkflowRun, missingWorkflowExecutors, validateWorkflowRun };

const TEXT_ENCODER = new TextEncoder();

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
    const incomingEdgesByTarget = new Map();
    const outgoingEdgesBySource = new Map();
    for (const edge of active.snapshot.edges) {
      let incoming = incomingEdgesByTarget.get(edge.targetNodeId);
      if (!incoming) {
        incoming = [];
        incomingEdgesByTarget.set(edge.targetNodeId, incoming);
      }
      incoming.push(edge);

      let outgoing = outgoingEdgesBySource.get(edge.sourceNodeId);
      if (!outgoing) {
        outgoing = [];
        outgoingEdgesBySource.set(edge.sourceNodeId, outgoing);
      }
      outgoing.push(edge);
    }

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
        for (const edge of outgoingEdgesBySource.get(node.instanceId) ?? []) {
          if (Object.hasOwn(state.output, edge.sourcePort)) activeEdges.add(edge.id);
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
            for (const edge of outgoingEdgesBySource.get(instanceId) ?? [])
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
            if (TEXT_ENCODER.encode(text).byteLength > 64 * 1024)
              throw new RangeError("A node log message exceeds the 64 KB limit");
            const messageBytes = recordBytes(text);
            if (logBytes + messageBytes > MAX_RUN_LOG_BYTES)
              throw new RangeError("Workflow run logs exceed the 2 MB limit");
            const deltaDurableBytes = messageBytes + (state.logs.length > 0 ? 1 : 0);
            if (durableBytes + deltaDurableBytes > MAX_RUN_MUTABLE_BYTES)
              throw new RangeError("Workflow run state exceeds the 7 MB limit");
            active.nodeStates[instanceId] = { ...state, logs: [...state.logs, text] };
            durableBytes += deltaDurableBytes;
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
          for (const edge of outgoingEdgesBySource.get(instanceId) ?? []) {
            if (Object.hasOwn(nodeOutput ?? {}, edge.sourcePort)) activeEdges.add(edge.id);
          }
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
              (incomingEdgesByTarget.get(instanceId) ?? []).every((edge) => {
                const status = active.nodeStates[edge.sourceNodeId]?.status;
                return status !== "idle" && status !== "running";
              }),
            )
            .sort((left, right) => orderIndex.get(left) - orderIndex.get(right));

          for (const instanceId of ready) {
            const incoming = incomingEdgesByTarget.get(instanceId) ?? [];
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
