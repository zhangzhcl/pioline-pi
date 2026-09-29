// ABOUTME: Revisioned workflow command service. Persistence is injected so the
// native host remains the sole durable-state owner across UI and Agent clients.

import {
  createWorkflowEvent,
  normalizeWorkflowInputBindings,
  stripWorkflowNodeRuntime,
  validateWorkflow,
  WORKFLOW_SCHEMA_VERSION,
} from "./workflow-contracts.js";

const MAX_WORKFLOW_JSON_BYTES = 8 * 1024 * 1024;
const MAX_WORKFLOW_EVENT_JSON_BYTES = 1024 * 1024;

function assertPayloadSize(value, limit, label) {
  const encoded = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (encoded > limit) throw new RangeError(`${label} exceeds the supported size limit`);
}

function omittedValueSummary(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { omitted: true, encoding: "unavailable" };
  }
  return {
    omitted: true,
    valueType: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    serializedBytes: new TextEncoder().encode(encoded).byteLength,
  };
}

function summarizeWorkflowCommand(command) {
  if (!command || typeof command !== "object") return command;
  switch (command.type) {
    case "apply_batch":
      return { ...command, operations: command.operations.map(summarizeWorkflowCommand) };
    case "set_param":
    case "set_input":
      return { ...command, value: omittedValueSummary(command.value) };
    case "clear_param":
    case "clear_input":
      return { ...command };
    case "add_node":
      return {
        ...command,
        node: {
          instanceId: command.node?.instanceId,
          meta: command.node?.meta,
          position: command.node?.position,
          params: Object.keys(command.node?.paramValues ?? {}),
          inputs: Object.keys(command.node?.portValues ?? {}),
          valuesOmitted: true,
        },
      };
    case "undo_snapshot":
    case "redo_snapshot":
      return {
        type: command.type,
        idempotencyKey: command.idempotencyKey,
        snapshotSummary: {
          nodeCount: command.snapshot?.nodes?.length ?? 0,
          edgeCount: command.snapshot?.edges?.length ?? 0,
        },
      };
    case "seed_starter":
      return {
        type: command.type,
        idempotencyKey: command.idempotencyKey,
        nodeCount: command.nodes?.length ?? 0,
        edgeCount: command.edges?.length ?? 0,
      };
    default:
      return command;
  }
}

export function createHostWorkflowRepository(hostControl) {
  if (
    !hostControl ||
    typeof hostControl.loadWorkflow !== "function" ||
    typeof hostControl.createWorkflow !== "function" ||
    typeof hostControl.compareAndSwapWorkflow !== "function"
  ) {
    throw new TypeError("Host control gateway does not support workflow persistence");
  }
  return {
    load: (workflowId, workspaceId) => hostControl.loadWorkflow(workflowId, workspaceId),
    create: (workflow) => hostControl.createWorkflow(workflow),
    compareAndSwap: (record) => hostControl.compareAndSwapWorkflow(record),
  };
}

export class WorkflowRevisionConflict extends Error {
  constructor(expected, actual) {
    super(`Workflow revision conflict: expected ${expected}, current revision is ${actual}`);
    this.name = "WorkflowRevisionConflict";
    this.expectedRevision = expected;
    this.actualRevision = actual;
  }
}

export class WorkflowService {
  #repository;
  #nodeMetas;
  #listeners = new Set();

  constructor(repository, { nodeMetas = new Map() } = {}) {
    if (
      !repository ||
      typeof repository.load !== "function" ||
      typeof repository.compareAndSwap !== "function"
    ) {
      throw new TypeError("WorkflowService requires a load/compareAndSwap repository");
    }
    this.#repository = repository;
    this.#nodeMetas = nodeMetas;
  }

  async load(workflowId, workspaceId) {
    const record = await this.#repository.load(workflowId, workspaceId);
    if (!record) return null;
    const workflow = normalizeWorkflowInputBindings(stripWorkflowNodeRuntime(record.workflow));
    const errors = validateWorkflow(workflow, this.#nodeMetas);
    const blockingErrors = errors.filter((error) => !error.startsWith("Start inputSchema"));
    if (blockingErrors.length)
      throw new Error(`Stored workflow is invalid: ${blockingErrors.join("; ")}`);
    if (!Array.isArray(record.events)) throw new Error("Stored workflow event log is invalid");
    return { ...structuredClone(record), workflow };
  }

  async create(workflow) {
    const errors = validateWorkflow(workflow, this.#nodeMetas);
    if (errors.length) throw new TypeError(`Cannot create invalid workflow: ${errors.join("; ")}`);
    assertPayloadSize(workflow, MAX_WORKFLOW_JSON_BYTES, "Workflow");
    const created = await this.#repository.create?.(structuredClone(workflow));
    if (!created) throw new Error(`Workflow ${workflow.id} already exists or could not be created`);
    return structuredClone(workflow);
  }

  async apply({
    workflowId,
    workspaceId,
    baseRevision,
    actor,
    command,
    applyCommand,
    expectedCatalogRevision,
  }) {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0)
      throw new TypeError("baseRevision must be a non-negative integer");
    if (typeof applyCommand !== "function")
      throw new TypeError("applyCommand must be provided by the workflow domain");
    const current = await this.load(workflowId, workspaceId);
    if (!current) throw new Error(`Workflow ${workflowId} does not exist`);
    if (current.workflow.revision !== baseRevision) {
      throw new WorkflowRevisionConflict(baseRevision, current.workflow.revision);
    }

    const nextWorkflow = structuredClone(current.workflow);
    await applyCommand(nextWorkflow, structuredClone(command));
    nextWorkflow.schemaVersion = WORKFLOW_SCHEMA_VERSION;
    nextWorkflow.revision = baseRevision + 1;
    nextWorkflow.updatedAt = new Date().toISOString();
    const errors = validateWorkflow(nextWorkflow, this.#nodeMetas);
    if (errors.length)
      throw new TypeError(`Workflow command produced invalid state: ${errors.join("; ")}`);

    const event = createWorkflowEvent({
      workflowId,
      workspaceId,
      revision: nextWorkflow.revision,
      actor,
      command: summarizeWorkflowCommand(command),
      timestamp: nextWorkflow.updatedAt,
    });
    assertPayloadSize(nextWorkflow, MAX_WORKFLOW_JSON_BYTES, "Workflow");
    assertPayloadSize(event, MAX_WORKFLOW_EVENT_JSON_BYTES, "Workflow event");
    const saved = await this.#repository.compareAndSwap({
      workflowId,
      workspaceId,
      expectedRevision: baseRevision,
      workflow: nextWorkflow,
      event,
      ...(expectedCatalogRevision ? { expectedCatalogRevision } : {}),
    });
    if (!saved) {
      const latest = await this.#repository.load(workflowId, workspaceId);
      throw new WorkflowRevisionConflict(baseRevision, latest?.workflow?.revision ?? -1);
    }
    const result = { workflow: nextWorkflow, event };
    for (const listener of this.#listeners) listener(structuredClone(result));
    return result;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
