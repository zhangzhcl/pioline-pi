import { describe, expect, it } from "vitest";
import { createStarterWorkflow } from "./builtin-node-registry.js";
import { createWorkflowRun, WorkflowRunner } from "./workflow-runner.js";

function workflowWithFilter() {
  const workflow = createStarterWorkflow({
    id: "workflow-exists-semantics",
    workspaceId: "workspace-exists-semantics",
    makeId: (() => {
      let sequence = 0;
      return () => `node-${++sequence}`;
    })(),
    timestamp: "2026-09-28T00:00:00.000Z",
  });
  const [start, , end] = workflow.nodes;
  const extract = {
    instanceId: "extract-items",
    meta: { id: "pipline.extract", version: "2.0.0" },
    position: { x: 220, y: 140 },
    paramValues: { path: "items" },
    portValues: {},
  };
  const filter = {
    instanceId: "filter-present-values",
    meta: { id: "pipline.filter", version: "1.0.0" },
    position: { x: 440, y: 140 },
    paramValues: { path: "value", operator: "exists" },
    portValues: {},
  };
  workflow.nodes = [start, extract, filter, end];
  workflow.edges = [
    {
      id: "start-extract",
      sourceNodeId: start.instanceId,
      sourcePort: "input",
      targetNodeId: extract.instanceId,
      targetPort: "source",
    },
    {
      id: "extract-filter",
      sourceNodeId: extract.instanceId,
      sourcePort: "value",
      targetNodeId: filter.instanceId,
      targetPort: "items",
    },
    {
      id: "filter-end",
      sourceNodeId: filter.instanceId,
      sourcePort: "items",
      targetNodeId: end.instanceId,
      targetPort: "result",
    },
  ];
  return workflow;
}

function workflowWithNullCondition() {
  const workflow = createStarterWorkflow({
    id: "workflow-null-condition",
    workspaceId: "workspace-null-condition",
    makeId: (() => {
      let sequence = 0;
      return () => `condition-node-${++sequence}`;
    })(),
    timestamp: "2026-09-28T00:00:00.000Z",
  });
  const [start, , end] = workflow.nodes;
  const extract = {
    instanceId: "extract-null-value",
    meta: { id: "pipline.extract", version: "2.0.0" },
    position: { x: 200, y: 140 },
    paramValues: { path: "value" },
    portValues: {},
  };
  const condition = {
    instanceId: "condition-null-value",
    meta: { id: "pipline.condition", version: "1.0.0" },
    position: { x: 400, y: 140 },
    paramValues: { operator: "exists" },
    portValues: {},
  };
  const present = {
    instanceId: "assign-present",
    meta: { id: "pipline.assign", version: "2.0.0" },
    position: { x: 600, y: 60 },
    paramValues: { varName: "present" },
    portValues: {},
  };
  const missing = {
    ...structuredClone(present),
    instanceId: "assign-missing",
    position: { x: 600, y: 220 },
    paramValues: { varName: "missing" },
    portValues: {},
  };
  const merge = {
    instanceId: "merge-condition",
    meta: { id: "pipline.merge", version: "2.0.0" },
    position: { x: 820, y: 140 },
    paramValues: {},
    portValues: {},
  };
  workflow.nodes = [start, extract, condition, present, missing, merge, end];
  workflow.edges = [
    {
      id: "start-extract",
      sourceNodeId: start.instanceId,
      sourcePort: "input",
      targetNodeId: extract.instanceId,
      targetPort: "source",
    },
    {
      id: "extract-condition",
      sourceNodeId: extract.instanceId,
      sourcePort: "value",
      targetNodeId: condition.instanceId,
      targetPort: "value",
    },
    {
      id: "condition-present",
      sourceNodeId: condition.instanceId,
      sourcePort: "true",
      targetNodeId: present.instanceId,
      targetPort: "value",
    },
    {
      id: "condition-missing",
      sourceNodeId: condition.instanceId,
      sourcePort: "false",
      targetNodeId: missing.instanceId,
      targetPort: "value",
    },
    {
      id: "present-merge",
      sourceNodeId: present.instanceId,
      sourcePort: "output",
      targetNodeId: merge.instanceId,
      targetPort: "in0",
    },
    {
      id: "missing-merge",
      sourceNodeId: missing.instanceId,
      sourcePort: "output",
      targetNodeId: merge.instanceId,
      targetPort: "in0",
    },
    {
      id: "merge-end",
      sourceNodeId: merge.instanceId,
      sourcePort: "list",
      targetNodeId: end.instanceId,
      targetPort: "result",
    },
  ];
  return workflow;
}

describe("exists comparison semantics", () => {
  it("keeps explicitly present null values and rejects only missing paths", async () => {
    const workflow = workflowWithFilter();
    const items = [{ value: null }, {}, { value: false }, { value: 0 }, { value: "" }];
    const run = await new WorkflowRunner().run(
      createWorkflowRun(workflow, { items }, { id: "run-exists-null" }),
    );

    expect(run.status).toBe("success");
    expect(run.result).toEqual([{ value: null }, { value: false }, { value: 0 }, { value: "" }]);
  });

  it("routes an explicit null through Condition's existing branch", async () => {
    const workflow = workflowWithNullCondition();
    const run = await new WorkflowRunner().run(
      createWorkflowRun(workflow, { value: null }, { id: "run-condition-null" }),
    );

    expect(run.status).toBe("success");
    expect(run.result).toEqual([{ present: null }]);
    expect(run.nodeStates["assign-present"].status).toBe("success");
    expect(run.nodeStates["assign-missing"].status).toBe("skipped");
  });
});
