import { describe, expect, it } from "vitest";
import { BUILTIN_NODE_METAS, createStarterWorkflow } from "./builtin-node-registry.js";
import { searchNodeTemplateMetas } from "./node-template-search.js";
import { applyWorkflowCommand } from "./workflow-commands.js";
import { createWorkflowRetryRun, createWorkflowRun, WorkflowRunner } from "./workflow-runner.js";

function workflowWithEndMode(returnMode) {
  const workflow = createStarterWorkflow({
    id: "workflow-return-mode",
    workspaceId: "workspace-return-mode",
    makeId: (() => {
      let sequence = 0;
      return () => `node-${++sequence}`;
    })(),
    timestamp: "2026-09-27T00:00:00.000Z",
  });
  if (returnMode)
    workflow.nodes.find((node) => node.meta.id === "pipline.end").paramValues.returnMode =
      returnMode;
  return workflow;
}

function workflowWithAssignAndMerge() {
  const workflow = createStarterWorkflow({
    id: "workflow-assign-merge-v2",
    workspaceId: "workspace-assign-merge-v2",
    makeId: (() => {
      let sequence = 0;
      return () => `node-${++sequence}`;
    })(),
    timestamp: "2026-09-27T00:00:00.000Z",
  });
  const [start, , end] = workflow.nodes;
  const firstAssign = {
    instanceId: "assign-first",
    meta: { id: "pipline.assign", version: "2.0.0" },
    position: { x: 200, y: 100 },
    paramValues: { varName: "first" },
    portValues: {},
  };
  const secondAssign = {
    ...structuredClone(firstAssign),
    instanceId: "assign-second",
    paramValues: { varName: "second" },
    position: { x: 200, y: 240 },
  };
  const merge = {
    instanceId: "merge-values",
    meta: { id: "pipline.merge", version: "2.0.0" },
    position: { x: 440, y: 170 },
    paramValues: {},
    portValues: {},
  };
  workflow.nodes = [start, firstAssign, secondAssign, merge, end];
  workflow.edges = [
    {
      id: "start-first",
      sourceNodeId: start.instanceId,
      sourcePort: "input",
      targetNodeId: firstAssign.instanceId,
      targetPort: "value",
    },
    {
      id: "start-second",
      sourceNodeId: start.instanceId,
      sourcePort: "input",
      targetNodeId: secondAssign.instanceId,
      targetPort: "value",
    },
    {
      id: "first-merge",
      sourceNodeId: firstAssign.instanceId,
      sourcePort: "output",
      targetNodeId: merge.instanceId,
      targetPort: "in0",
    },
    {
      id: "second-merge",
      sourceNodeId: secondAssign.instanceId,
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

function workflowWithObjectMerge(conflict) {
  const workflow = workflowWithEndMode();
  const [start, , end] = workflow.nodes;
  const extract = (instanceId, path, y) => ({
    instanceId,
    meta: { id: "pipline.extract", version: "2.0.0" },
    position: { x: 180, y },
    paramValues: { path },
    portValues: {},
  });
  const assign = (instanceId, y) => ({
    instanceId,
    meta: { id: "pipline.assign", version: "2.0.0" },
    position: { x: 380, y },
    paramValues: { varName: "shared" },
    portValues: {},
  });
  const extractFirst = extract("extract-first-object-value", "first", 80);
  const extractSecond = extract("extract-second-object-value", "second", 220);
  const assignFirst = assign("assign-first-object-value", 80);
  const assignSecond = assign("assign-second-object-value", 220);
  const merge = {
    instanceId: "merge-object-values",
    meta: { id: "pipline.merge", version: "1.0.0" },
    position: { x: 600, y: 150 },
    paramValues: { conflict },
    portValues: {},
  };
  workflow.nodes = [start, extractFirst, extractSecond, assignFirst, assignSecond, merge, end];
  workflow.edges = [
    [start, "input", extractFirst, "source", "start-extract-first"],
    [start, "input", extractSecond, "source", "start-extract-second"],
    [extractFirst, "value", assignFirst, "value", "extract-assign-first"],
    [extractSecond, "value", assignSecond, "value", "extract-assign-second"],
    [assignFirst, "output", merge, "values", "assign-merge-first"],
    [assignSecond, "output", merge, "values", "assign-merge-second"],
    [merge, "result", end, "result", "merge-end"],
  ].map(([source, sourcePort, target, targetPort, id]) => ({
    id,
    sourceNodeId: source.instanceId,
    sourcePort,
    targetNodeId: target.instanceId,
    targetPort,
  }));
  return workflow;
}

describe("workflow Assign and Merge v2", () => {
  it("uses the current Pi Agent version in new starter workflows", () => {
    const workflow = workflowWithEndMode();
    expect(workflow.nodes.find((node) => node.meta.id === "pipline.pi-agent").meta.version).toBe(
      "2.0.0",
    );
  });

  it("runs connected Assign values and aggregates them in connection order", async () => {
    const workflow = workflowWithAssignAndMerge();
    const run = createWorkflowRun(
      workflow,
      { request: "ship it" },
      { nodeMetas: BUILTIN_NODE_METAS },
    );
    const runner = new WorkflowRunner({ nodeMetas: BUILTIN_NODE_METAS });

    await expect(runner.run(run)).resolves.toMatchObject({
      status: "success",
      result: [{ first: { request: "ship it" } }, { second: { request: "ship it" } }],
    });
  });

  it("concatenates connected arrays without nesting or reordering their values", async () => {
    const workflow = workflowWithEndMode();
    const [start, , end] = workflow.nodes;
    const makeExtract = (instanceId, path, position) => ({
      instanceId,
      meta: { id: "pipline.extract", version: "2.0.0" },
      position,
      paramValues: { path },
      portValues: {},
    });
    const first = makeExtract("extract-first-array", "first", { x: 180, y: 80 });
    const second = makeExtract("extract-second-array", "second", { x: 180, y: 220 });
    const merge = {
      instanceId: "merge-concatenate-arrays",
      meta: { id: "pipline.merge", version: "3.0.0" },
      position: { x: 420, y: 150 },
      paramValues: { mode: "concatenate" },
      portValues: {},
    };
    workflow.nodes = [start, first, second, merge, end];
    workflow.edges = [
      {
        id: "start-extract-first",
        sourceNodeId: start.instanceId,
        sourcePort: "input",
        targetNodeId: first.instanceId,
        targetPort: "source",
      },
      {
        id: "start-extract-second",
        sourceNodeId: start.instanceId,
        sourcePort: "input",
        targetNodeId: second.instanceId,
        targetPort: "source",
      },
      {
        id: "first-merge",
        sourceNodeId: first.instanceId,
        sourcePort: "value",
        targetNodeId: merge.instanceId,
        targetPort: "in0",
      },
      {
        id: "second-merge",
        sourceNodeId: second.instanceId,
        sourcePort: "value",
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

    const run = createWorkflowRun(workflow, { first: [1, 2], second: [3] });
    await expect(new WorkflowRunner().run(run)).resolves.toMatchObject({
      status: "success",
      result: [1, 2, 3],
    });
  });

  it("groups values under stable named Merge input ports", async () => {
    const workflow = workflowWithEndMode();
    const [start, , end] = workflow.nodes;
    const merge = {
      instanceId: "merge-group-by-port",
      meta: { id: "pipline.merge-by-port", version: "1.0.0" },
      position: { x: 420, y: 150 },
      paramValues: {},
      portValues: {},
    };
    workflow.nodes = [start, merge, end];
    workflow.edges = [
      {
        id: "start-merge-group-0",
        sourceNodeId: start.instanceId,
        sourcePort: "input",
        targetNodeId: merge.instanceId,
        targetPort: "input0",
      },
      {
        id: "start-merge-group-2",
        sourceNodeId: start.instanceId,
        sourcePort: "input",
        targetNodeId: merge.instanceId,
        targetPort: "input2",
      },
      {
        id: "merge-group-end",
        sourceNodeId: merge.instanceId,
        sourcePort: "result",
        targetNodeId: end.instanceId,
        targetPort: "result",
      },
    ];

    const run = createWorkflowRun(workflow, { value: "value" });
    await expect(new WorkflowRunner().run(run)).resolves.toMatchObject({
      status: "success",
      result: {
        input0: [{ value: "value" }],
        input1: [],
        input2: [{ value: "value" }],
        input3: [],
      },
    });
  });

  it("keeps static multi-values grouped beside linked Merge input values", async () => {
    const workflow = workflowWithEndMode();
    const [start, , end] = workflow.nodes;
    const merge = {
      instanceId: "merge-static-and-linked-groups",
      meta: { id: "pipline.merge-by-port", version: "1.0.0" },
      position: { x: 420, y: 150 },
      paramValues: {},
      portValues: {
        input1: {
          mode: "static",
          staticValue: ["manual", { source: "static" }],
        },
      },
    };
    workflow.nodes = [start, merge, end];
    workflow.edges = [
      {
        id: "start-merge-linked-group",
        sourceNodeId: start.instanceId,
        sourcePort: "input",
        targetNodeId: merge.instanceId,
        targetPort: "input0",
      },
      {
        id: "merge-static-linked-end",
        sourceNodeId: merge.instanceId,
        sourcePort: "result",
        targetNodeId: end.instanceId,
        targetPort: "result",
      },
    ];

    const run = createWorkflowRun(workflow, { value: "linked" });
    await expect(new WorkflowRunner().run(run)).resolves.toMatchObject({
      status: "success",
      result: {
        input0: [{ value: "linked" }],
        input1: ["manual", { source: "static" }],
        input2: [],
        input3: [],
      },
    });
  });

  it.each([
    { conflict: "first", expected: { shared: "first" } },
    { conflict: "last", expected: { shared: "second" } },
    { conflict: "error", error: "Merge key conflict: shared" },
  ])("applies the explicit object key policy: $conflict", async ({ conflict, expected, error }) => {
    const run = createWorkflowRun(workflowWithObjectMerge(conflict), {
      first: "first",
      second: "second",
    });
    const result = await new WorkflowRunner().run(run);
    if (error) {
      expect(result.status).toBe("error");
      expect(result.error).toBe(error);
    } else {
      expect(result.status).toBe("success");
      expect(result.result).toEqual(expected);
    }
  });

  it("keeps legacy Assign hidden and exposes explicit object Merge", () => {
    expect(searchNodeTemplateMetas(BUILTIN_NODE_METAS, "assign").matches).not.toContainEqual(
      expect.objectContaining({ id: "pipline.assign", version: "1.0.0" }),
    );
    expect(searchNodeTemplateMetas(BUILTIN_NODE_METAS, "merge").matches).toContainEqual(
      expect.objectContaining({
        id: "pipline.merge",
        version: "1.0.0",
        labelKey: "workflow.nodeTypes.mergeObjects",
      }),
    );
  });

  it("rejects adding a retired built-in definition to a workflow", () => {
    const workflow = workflowWithEndMode();
    const legacyMeta = BUILTIN_NODE_METAS.get("pipline.assign@1.0.0");
    expect(legacyMeta).toBeDefined();
    expect(() =>
      applyWorkflowCommand(
        workflow,
        {
          type: "add_node",
          node: {
            instanceId: "legacy-merge",
            meta: { id: legacyMeta.id, version: legacyMeta.version },
            position: { x: 40, y: 40 },
            paramValues: {},
            portValues: {},
          },
        },
        BUILTIN_NODE_METAS,
      ),
    ).toThrow("This node template is retired and cannot be added.");
  });
});

describe("workflow Run snapshots exclude legacy node runtime", () => {
  it("strips draft runtime fields before freezing a new Run", () => {
    const workflow = workflowWithEndMode();
    workflow.nodes[0].runtime = { status: "success", logs: ["old"], result: {} };

    const run = createWorkflowRun(workflow, {}, { id: "run-strips-legacy-runtime" });

    expect(run.snapshot.nodes[0]).not.toHaveProperty("runtime");
    expect(workflow.nodes[0]).toHaveProperty("runtime");
  });

  it("strips legacy runtime fields when creating a retry snapshot", () => {
    const previousRun = createWorkflowRun(workflowWithEndMode(), {}, { id: "legacy-run" });
    const targetNode = previousRun.snapshot.nodes.find(
      (node) => node.meta.id === "pipline.pi-agent",
    );
    previousRun.snapshot.nodes[0].runtime = { status: "success", logs: ["old"], result: {} };
    previousRun.status = "error";
    previousRun.nodeStates[targetNode.instanceId] = {
      status: "error",
      logs: [],
      output: null,
      error: "legacy failure",
    };

    const retry = createWorkflowRetryRun(previousRun, targetNode.instanceId, {
      id: "retry-strips-legacy-runtime",
    });

    expect(retry.snapshot.nodes[0]).not.toHaveProperty("runtime");
  });
});

describe("workflow Extract v2", () => {
  it("reads fixed paths from a top-level array source", async () => {
    const workflow = workflowWithEndMode();
    const [start, , end] = workflow.nodes;
    const arrayValue = {
      instanceId: "extract-array-value",
      meta: { id: "pipline.extract", version: "1.0.0" },
      position: { x: 200, y: 0 },
      paramValues: { path: "items" },
      portValues: {},
    };
    const extract = {
      instanceId: "extract-array-item",
      meta: { id: "pipline.extract", version: "2.0.0" },
      position: { x: 400, y: 0 },
      paramValues: { path: "1.name" },
      portValues: {},
    };
    workflow.nodes = [start, arrayValue, extract, end];
    workflow.edges = [
      {
        id: "start-array-value",
        sourceNodeId: start.instanceId,
        sourcePort: "input",
        targetNodeId: arrayValue.instanceId,
        targetPort: "source",
      },
      {
        id: "array-value-extract",
        sourceNodeId: arrayValue.instanceId,
        sourcePort: "value",
        targetNodeId: extract.instanceId,
        targetPort: "source",
      },
      {
        id: "extract-end",
        sourceNodeId: extract.instanceId,
        sourcePort: "value",
        targetNodeId: end.instanceId,
        targetPort: "result",
      },
    ];

    const run = createWorkflowRun(
      workflow,
      { items: [{ name: "first" }, { name: "second" }] },
      { id: "extract-array-run" },
    );
    const completed = await new WorkflowRunner().run(run);

    expect(completed.status).toBe("success");
    expect(completed.result).toBe("second");
  });
});
