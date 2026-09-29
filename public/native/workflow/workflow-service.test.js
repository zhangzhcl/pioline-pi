import { describe, expect, it } from "vitest";
import { BUILTIN_NODE_METAS, createStarterWorkflow } from "./builtin-node-registry.js";
import { applyWorkflowCommand } from "./workflow-commands.js";
import { WorkflowService } from "./workflow-service.js";

function legacyWorkflowWithInvalidStartSchema() {
  const workflow = createStarterWorkflow({
    id: "legacy-invalid-start-schema",
    workspaceId: "workspace-test",
    makeId: (() => {
      let id = 0;
      return () => `instance-${++id}`;
    })(),
    timestamp: "2026-09-27T00:00:00.000Z",
  });
  workflow.nodes.find((node) => node.meta.id === "pipline.start").paramValues.inputSchema = {
    properties: { request: { type: "string", pattern: ".+" } },
  };
  return workflow;
}

function repositoryWith(workflow) {
  let record = { workflow: structuredClone(workflow), events: [] };
  return {
    repository: {
      load: async () => structuredClone(record),
      compareAndSwap: async ({ workflow: nextWorkflow, event }) => {
        record = {
          workflow: structuredClone(nextWorkflow),
          events: [...record.events, structuredClone(event)],
        };
        return true;
      },
    },
    read: () => structuredClone(record),
  };
}

describe("workflow service legacy validation recovery", () => {
  it("removes legacy runtime state from drafts and rejects new runtime fields", async () => {
    const original = createStarterWorkflow({
      id: "legacy-runtime-state",
      workspaceId: "workspace-test",
      makeId: (() => {
        let id = 0;
        return () => `instance-${++id}`;
      })(),
      timestamp: "2026-09-27T00:00:00.000Z",
    });
    original.nodes[0].runtime = { status: "success", logs: ["old"], result: {} };
    const { repository, read } = repositoryWith(original);
    const service = new WorkflowService(repository, { nodeMetas: BUILTIN_NODE_METAS });

    const loaded = await service.load(original.id, original.workspaceId);
    expect(loaded.workflow.nodes[0]).not.toHaveProperty("runtime");
    expect(read().workflow.nodes[0]).toHaveProperty("runtime");
    await service.apply({
      workflowId: original.id,
      workspaceId: original.workspaceId,
      baseRevision: 0,
      actor: "user",
      command: { type: "migrate-legacy-draft", idempotencyKey: "migrate-legacy-draft" },
      applyCommand: () => {},
    });
    expect(read().workflow.revision).toBe(1);
    expect(read().workflow.nodes[0]).not.toHaveProperty("runtime");

    const candidate = createStarterWorkflow({
      id: "new-runtime-state",
      workspaceId: "workspace-test",
      makeId: (() => {
        let id = 0;
        return () => `new-instance-${++id}`;
      })(),
      timestamp: "2026-09-27T00:00:00.000Z",
    });
    candidate.nodes[0].runtime = { status: "success", logs: [], result: {} };
    await expect(service.create(candidate)).rejects.toThrow("runtime state belongs to WorkflowRun");
  });

  it("round-trips added node versions and explicit static null values through persistence", async () => {
    let sequence = 0;
    const original = createStarterWorkflow({
      id: "workflow-service-node-roundtrip",
      workspaceId: "workspace-test",
      makeId: () => `instance-${++sequence}`,
      timestamp: "2026-09-28T00:00:00.000Z",
    });
    const { repository, read } = repositoryWith(original);
    const service = new WorkflowService(repository, { nodeMetas: BUILTIN_NODE_METAS });
    const assign = {
      instanceId: "assign-roundtrip",
      meta: { id: "pipline.assign", version: "2.0.0" },
      position: { x: 320, y: 160 },
      paramValues: { varName: "nullable" },
      portValues: {},
    };

    await service.apply({
      workflowId: original.id,
      workspaceId: original.workspaceId,
      baseRevision: 0,
      actor: "user",
      command: {
        type: "add_node",
        node: assign,
        idempotencyKey: "add-assign-roundtrip",
      },
      applyCommand: (workflow, command) =>
        applyWorkflowCommand(workflow, command, BUILTIN_NODE_METAS),
    });
    await service.apply({
      workflowId: original.id,
      workspaceId: original.workspaceId,
      baseRevision: 1,
      actor: "user",
      command: {
        type: "set_input",
        instanceId: assign.instanceId,
        name: "value",
        value: null,
        idempotencyKey: "set-null-roundtrip",
      },
      applyCommand: (workflow, command) =>
        applyWorkflowCommand(workflow, command, BUILTIN_NODE_METAS),
    });

    const reloaded = await service.load(original.id, original.workspaceId);
    const persistedNode = reloaded.workflow.nodes.find(
      (node) => node.instanceId === assign.instanceId,
    );
    expect(reloaded.workflow.revision).toBe(2);
    expect(persistedNode.meta).toEqual({ id: "pipline.assign", version: "2.0.0" });
    expect(persistedNode.paramValues.varName).toBe("nullable");
    expect(persistedNode.portValues.value).toEqual({ mode: "static", staticValue: null });
    expect(read().events).toHaveLength(2);
    expect(read().events[1].command.value).toMatchObject({ omitted: true, valueType: "null" });
  });

  it("loads an invalid legacy Start schema and allows saving its correction", async () => {
    const original = legacyWorkflowWithInvalidStartSchema();
    const { repository, read } = repositoryWith(original);
    const service = new WorkflowService(repository, { nodeMetas: BUILTIN_NODE_METAS });

    const loaded = await service.load(original.id, original.workspaceId);
    expect(loaded.workflow.nodes[0].paramValues.inputSchema).toEqual(
      original.nodes[0].paramValues.inputSchema,
    );
    await expect(
      service.apply({
        workflowId: original.id,
        workspaceId: original.workspaceId,
        baseRevision: 0,
        actor: "user",
        command: { type: "other-edit", idempotencyKey: "other-edit" },
        applyCommand: () => {},
      }),
    ).rejects.toThrow("Workflow command produced invalid state");
    expect(read().workflow.revision).toBe(0);

    const correctedSchema = { properties: { request: "string" }, required: ["request"] };
    const result = await service.apply({
      workflowId: original.id,
      workspaceId: original.workspaceId,
      baseRevision: 0,
      actor: "user",
      command: { type: "repair-start-schema", idempotencyKey: "repair-start-schema" },
      applyCommand: (workflow) => {
        workflow.nodes[0].paramValues.inputSchema = correctedSchema;
      },
    });

    expect(result.workflow.revision).toBe(1);
    expect(read().workflow.nodes[0].paramValues.inputSchema).toEqual(correctedSchema);
  });
});
