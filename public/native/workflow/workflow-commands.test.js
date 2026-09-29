import { describe, expect, it } from "vitest";
import { BUILTIN_NODE_METAS, createStarterWorkflow } from "./builtin-node-registry.js";
import { applyWorkflowCommand } from "./workflow-commands.js";

describe("workflow input commands", () => {
  it("clears an optional static input without changing graph edges", () => {
    let sequence = 0;
    const workflow = createStarterWorkflow({
      id: "clear-input-test",
      workspaceId: "clear-input-test",
      makeId: () => `instance-${++sequence}`,
      timestamp: "2026-09-27T00:00:00.000Z",
    });
    const node = workflow.nodes.find((item) => item.meta.id === "pipline.pi-agent");
    node.portValues.context = { mode: "static", staticValue: { topic: "test" } };
    const originalEdges = structuredClone(workflow.edges);

    applyWorkflowCommand(
      workflow,
      { type: "clear_input", instanceId: node.instanceId, name: "context" },
      BUILTIN_NODE_METAS,
    );

    expect(node.portValues).not.toHaveProperty("context");
    expect(workflow.edges).toEqual(originalEdges);
  });

  it("rejects clearing an unknown input", () => {
    let sequence = 0;
    const workflow = createStarterWorkflow({
      id: "clear-input-invalid-test",
      workspaceId: "clear-input-invalid-test",
      makeId: () => `instance-${++sequence}`,
      timestamp: "2026-09-27T00:00:00.000Z",
    });
    const node = workflow.nodes.find((item) => item.meta.id === "pipline.pi-agent");
    expect(() =>
      applyWorkflowCommand(
        workflow,
        { type: "clear_input", instanceId: node.instanceId, name: "unknown" },
        BUILTIN_NODE_METAS,
      ),
    ).toThrow("Unknown node input.");
  });

  it("stores an explicit null static value instead of clearing the input", () => {
    let sequence = 0;
    const workflow = createStarterWorkflow({
      id: "null-input-test",
      workspaceId: "null-input-test",
      makeId: () => `instance-${++sequence}`,
      timestamp: "2026-09-27T00:00:00.000Z",
    });
    const assign = {
      instanceId: "assign-null",
      meta: { id: "pipline.assign", version: "2.0.0" },
      position: { x: 240, y: 140 },
      paramValues: { varName: "nullable" },
      portValues: {},
    };
    applyWorkflowCommand(workflow, { type: "add_node", node: assign }, BUILTIN_NODE_METAS);

    applyWorkflowCommand(
      workflow,
      { type: "set_input", instanceId: assign.instanceId, name: "value", value: null },
      BUILTIN_NODE_METAS,
    );

    expect(
      workflow.nodes.find((node) => node.instanceId === assign.instanceId).portValues.value,
    ).toEqual({ mode: "static", staticValue: null });
  });
});
