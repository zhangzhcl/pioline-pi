import { describe, expect, it } from "vitest";
import { BUILTIN_NODE_METAS, createStarterWorkflow, nodeMetaKey } from "./builtin-node-registry.js";
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

async function runWithPiResult(workflow, value) {
  const nodeMetas = new Map(BUILTIN_NODE_METAS);
  const piNode = workflow.nodes.find((node) => node.meta.id === "pipline.pi-agent");
  const piKey = nodeMetaKey(piNode.meta);
  const piMeta = structuredClone(nodeMetas.get(piKey));
  piMeta.outputs[0].type = "any";
  nodeMetas.set(piKey, piMeta);
  const run = createWorkflowRun(workflow, {}, { id: "run-return-mode", nodeMetas });
  const runner = new WorkflowRunner({
    nodeMetas,
    executors: new Map([[piKey, async () => ({ content: value })]]),
  });
  return runner.run(run);
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

describe("legacy object Merge JSON keys", () => {
  it("preserves __proto__ as an own JSON field instead of changing the result prototype", async () => {
    const workflow = workflowWithEndMode();
    const [start, , end] = workflow.nodes;
    const assign = {
      instanceId: "assign-prototype-key",
      meta: { id: "pipline.assign", version: "2.0.0" },
      position: { x: 220, y: 140 },
      paramValues: { varName: "__proto__" },
      portValues: {},
    };
    const merge = {
      instanceId: "legacy-merge-objects",
      meta: { id: "pipline.merge", version: "1.0.0" },
      position: { x: 460, y: 140 },
      paramValues: { conflict: "error" },
      portValues: {},
    };
    workflow.nodes = [start, assign, merge, end];
    workflow.edges = [
      {
        id: "start-assign",
        sourceNodeId: start.instanceId,
        sourcePort: "input",
        targetNodeId: assign.instanceId,
        targetPort: "value",
      },
      {
        id: "assign-merge",
        sourceNodeId: assign.instanceId,
        sourcePort: "output",
        targetNodeId: merge.instanceId,
        targetPort: "values",
      },
      {
        id: "merge-end",
        sourceNodeId: merge.instanceId,
        sourcePort: "result",
        targetNodeId: end.instanceId,
        targetPort: "result",
      },
    ];

    const result = await new WorkflowRunner().run(createWorkflowRun(workflow, { fromInput: true }));

    expect(result.status).toBe("success");
    expect(result.result).toEqual(JSON.parse('{"__proto__":{"fromInput":true}}'));
    expect(Object.hasOwn(result.result, "__proto__")).toBe(true);
  });
});

describe("workflow End return mode", () => {
  it("preserves the JSON value by default", async () => {
    const value = { answer: 42, tags: ["a", "b"] };
    await expect(runWithPiResult(workflowWithEndMode(), value)).resolves.toMatchObject({
      status: "success",
      result: value,
    });
  });

  it("serializes non-string JSON values as text when selected", async () => {
    const value = { answer: 42, tags: ["a", "b"] };
    await expect(runWithPiResult(workflowWithEndMode("text"), value)).resolves.toMatchObject({
      status: "success",
      result: JSON.stringify(value),
    });
  });

  it("returns strings unchanged in text mode", async () => {
    await expect(runWithPiResult(workflowWithEndMode("text"), "hello")).resolves.toMatchObject({
      status: "success",
      result: "hello",
    });
  });

  it("collects multiple End results in workflow order after applying each return mode", async () => {
    const workflow = workflowWithEndMode();
    const [start, , firstEnd] = workflow.nodes;
    const secondEnd = structuredClone(firstEnd);
    secondEnd.instanceId = "node-end-second";
    secondEnd.position = { x: 660, y: 280 };
    secondEnd.paramValues.returnMode = "text";
    workflow.nodes = [start, firstEnd, secondEnd];
    workflow.edges = [
      {
        id: "start-first-end",
        sourceNodeId: start.instanceId,
        sourcePort: "input",
        targetNodeId: firstEnd.instanceId,
        targetPort: "result",
      },
      {
        id: "start-second-end",
        sourceNodeId: start.instanceId,
        sourcePort: "input",
        targetNodeId: secondEnd.instanceId,
        targetPort: "result",
      },
    ];

    await expect(
      new WorkflowRunner().run(createWorkflowRun(workflow, { answer: 42 })),
    ).resolves.toMatchObject({
      status: "success",
      result: [{ answer: 42 }, '{"answer":42}'],
    });
  });

  it("omits a skipped End branch from the final result", async () => {
    const workflow = workflowWithEndMode();
    const [start, , firstEnd] = workflow.nodes;
    const condition = {
      instanceId: "node-end-condition",
      meta: { id: "pipline.condition", version: "1.0.0" },
      position: { x: 240, y: 140 },
      paramValues: { operator: "equals", expected: { route: "yes" } },
      portValues: {},
    };
    const secondEnd = structuredClone(firstEnd);
    secondEnd.instanceId = "node-end-second-branch";
    secondEnd.position = { x: 660, y: 280 };
    secondEnd.paramValues.returnMode = "text";
    workflow.nodes = [start, condition, firstEnd, secondEnd];
    workflow.edges = [
      {
        id: "start-to-end-condition",
        sourceNodeId: start.instanceId,
        sourcePort: "input",
        targetNodeId: condition.instanceId,
        targetPort: "value",
      },
      {
        id: "condition-true-to-end",
        sourceNodeId: condition.instanceId,
        sourcePort: "true",
        targetNodeId: firstEnd.instanceId,
        targetPort: "result",
      },
      {
        id: "condition-false-to-end",
        sourceNodeId: condition.instanceId,
        sourcePort: "false",
        targetNodeId: secondEnd.instanceId,
        targetPort: "result",
      },
    ];

    const run = await new WorkflowRunner().run(
      createWorkflowRun(workflow, { route: "yes" }, { id: "run-one-end-branch" }),
    );

    expect(run.status).toBe("success");
    expect(run.result).toEqual({ route: "yes" });
    expect(run.nodeStates[firstEnd.instanceId].status).toBe("success");
    expect(run.nodeStates[secondEnd.instanceId].status).toBe("skipped");
  });
});

describe("workflow Template node", () => {
  it("defines missing, null, JSON, and literal interpolation behavior", async () => {
    const workflow = workflowWithEndMode();
    const [start, template, end] = workflow.nodes;
    template.meta = { id: "pipline.template", version: "1.0.0" };
    template.paramValues = {
      template:
        "missing={{absent}}; null={{presentNull}}; object={{profile}}; array={{items}}; literal={{markup}}; nested={{template}}",
    };
    template.portValues = {};
    workflow.edges = [
      {
        id: "start-template",
        sourceNodeId: start.instanceId,
        sourcePort: "input",
        targetNodeId: template.instanceId,
        targetPort: "values",
      },
      {
        id: "template-end",
        sourceNodeId: template.instanceId,
        sourcePort: "text",
        targetNodeId: end.instanceId,
        targetPort: "result",
      },
    ];

    const input = {
      presentNull: null,
      profile: { name: "Ada" },
      items: ["a", 2],
      markup: "<b>& literal",
      template: "{{nested}}",
      nested: "must not be expanded",
    };
    const run = createWorkflowRun(workflow, input);

    await expect(new WorkflowRunner().run(run)).resolves.toMatchObject({
      status: "success",
      result:
        'missing=; null=; object={"name":"Ada"}; array=["a",2]; literal=<b>& literal; nested={{nested}}',
    });
  });

  it("interpolates nested values whose object keys contain Unicode", async () => {
    const workflow = workflowWithEndMode();
    const [start, template, end] = workflow.nodes;
    template.meta = { id: "pipline.template", version: "1.0.0" };
    template.paramValues = { template: "你好，{{用户.姓名}}（{{标签.0}}）" };
    template.portValues = {};
    workflow.edges = [
      {
        id: "start-template",
        sourceNodeId: start.instanceId,
        sourcePort: "input",
        targetNodeId: template.instanceId,
        targetPort: "values",
      },
      {
        id: "template-end",
        sourceNodeId: template.instanceId,
        sourcePort: "text",
        targetNodeId: end.instanceId,
        targetPort: "result",
      },
    ];

    const run = createWorkflowRun(workflow, { 用户: { 姓名: "小明" }, 标签: ["工作流"] });
    const runner = new WorkflowRunner({ nodeMetas: BUILTIN_NODE_METAS });

    await expect(runner.run(run)).resolves.toMatchObject({
      status: "success",
      result: "你好，小明（工作流）",
    });
  });
});

describe("nested Start input schemas", () => {
  it("validates required nested object fields and array item types", () => {
    const workflow = workflowWithEndMode();
    workflow.nodes.find((node) => node.meta.id === "pipline.start").paramValues.inputSchema = {
      properties: {
        profile: {
          type: "object",
          properties: {
            name: "string",
            preferences: {
              type: "object",
              properties: { digest: "boolean" },
              required: ["digest"],
            },
          },
          required: ["name", "preferences"],
        },
        tags: { type: "array", items: "string" },
      },
      required: ["profile"],
    };

    expect(() =>
      createWorkflowRun(workflow, {
        profile: { name: "Pipline", preferences: { digest: true } },
        tags: ["workflow", "desktop"],
      }),
    ).not.toThrow();
    expect(() =>
      createWorkflowRun(workflow, {
        profile: { name: "Pipline", preferences: { digest: "yes" } },
        tags: ["workflow", 4],
      }),
    ).toThrow("Workflow input field profile.preferences.digest must be boolean");
    expect(() =>
      createWorkflowRun(workflow, {
        profile: { name: "Pipline", preferences: { digest: true } },
        tags: ["workflow", 4],
      }),
    ).toThrow("Workflow input field tags[1] must be string");
    expect(() =>
      createWorkflowRun(workflow, {
        profile: { name: "Pipline" },
        tags: [],
      }),
    ).toThrow("Workflow input field profile is missing required field preferences");
  });

  it("does not treat an explicitly null input schema as an omitted default", () => {
    const workflow = workflowWithEndMode();
    workflow.nodes.find((node) => node.meta.id === "pipline.start").paramValues.inputSchema = null;

    expect(() => createWorkflowRun(workflow, {})).toThrow("Start inputSchema must be an object");
  });
});

describe("workflow cancellation and retry", () => {
  it("persists skipped downstream nodes before the terminal failure event", async () => {
    const workflow = workflowWithEndMode();
    const [, piNode, end] = workflow.nodes;
    const key = nodeMetaKey(piNode.meta);
    const runner = new WorkflowRunner({
      executors: new Map([
        [
          key,
          async () => {
            throw new Error("temporary failure");
          },
        ],
      ]),
    });
    const eventSnapshots = [];
    const run = await runner.run(createWorkflowRun(workflow, {}, { id: "run-failure-events" }), {
      onEvent: (event, current) =>
        eventSnapshots.push({ type: event.type, status: current.status, error: current.error }),
    });

    expect(run.status).toBe("error");
    const skippedIndex = run.events.findIndex(
      (event) => event.type === "node_skipped" && event.nodeId === end.instanceId,
    );
    const failedIndex = run.events.findIndex((event) => event.type === "node_failed");
    const terminalIndex = run.events.findIndex((event) => event.type === "run_failed");
    expect(skippedIndex).toBeGreaterThan(failedIndex);
    expect(terminalIndex).toBeGreaterThan(skippedIndex);
    expect(eventSnapshots.find((event) => event.type === "node_skipped")).toMatchObject({
      status: "running",
      error: null,
    });
    expect(eventSnapshots[terminalIndex]).toMatchObject({ type: "run_failed", status: "error" });
  });

  it("marks the active node interrupted and remaining nodes skipped when cancelled", async () => {
    const workflow = workflowWithEndMode();
    const [start, piNode, end] = workflow.nodes;
    const piKey = nodeMetaKey(piNode.meta);
    const run = createWorkflowRun(workflow, {}, { id: "run-cancel" });
    const controller = new AbortController();
    let signalExecutorStarted;
    const executorStarted = new Promise((resolve) => {
      signalExecutorStarted = resolve;
    });
    const runner = new WorkflowRunner({
      executors: new Map([
        [
          piKey,
          async ({ signal }) => {
            signalExecutorStarted();
            await new Promise((resolve) =>
              signal.addEventListener("abort", resolve, { once: true }),
            );
            return { content: "late result" };
          },
        ],
      ]),
    });
    const events = [];
    const eventSnapshots = [];

    const resultPromise = runner.run(run, {
      signal: controller.signal,
      onEvent: (event, current) => {
        events.push(event);
        eventSnapshots.push({ type: event.type, status: current.status, error: current.error });
      },
    });
    await executorStarted;
    controller.abort();
    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
    expect(result.nodeStates[start.instanceId].status).toBe("success");
    expect(result.nodeStates[piNode.instanceId].status).toBe("interrupted");
    expect(result.nodeStates[end.instanceId].status).toBe("skipped");
    expect(events.at(-1).type).toBe("run_cancelled");
    expect(eventSnapshots.find((event) => event.type === "node_interrupted")).toMatchObject({
      status: "running",
      error: null,
    });
    expect(eventSnapshots.find((event) => event.type === "node_skipped")).toMatchObject({
      status: "running",
      error: null,
    });
    expect(eventSnapshots.at(-1)).toMatchObject({ type: "run_cancelled", status: "cancelled" });
  });

  it("resumes a failed node while preserving successful upstream output", async () => {
    const workflow = workflowWithEndMode();
    const [, piNode] = workflow.nodes;
    const piKey = nodeMetaKey(piNode.meta);
    const firstRunner = new WorkflowRunner({
      executors: new Map([
        [
          piKey,
          async () => {
            throw new Error("temporary failure");
          },
        ],
      ]),
    });
    const failedRun = await firstRunner.run(
      createWorkflowRun(workflow, { request: "keep this input" }, { id: "run-failed" }),
    );

    const retryRun = createWorkflowRetryRun(failedRun, piNode.instanceId, {
      id: "run-retry",
      createdAt: "2026-09-27T01:00:00.000Z",
    });

    expect(retryRun.retryOfRunId).toBe("run-failed");
    expect(retryRun.resumeFromNodeId).toBe(piNode.instanceId);
    expect(retryRun.nodeStates[workflow.nodes[0].instanceId].status).toBe("idle");
    expect(retryRun.retrySeedStates[workflow.nodes[0].instanceId]).toMatchObject({
      status: "success",
      output: { input: { request: "keep this input" } },
    });
    expect(retryRun.nodeStates[piNode.instanceId].status).toBe("idle");
    expect(retryRun.nodeStates[workflow.nodes[2].instanceId].status).toBe("idle");

    const retryEvents = [];
    const successfulRunner = new WorkflowRunner({
      executors: new Map([[piKey, async () => ({ content: "recovered" })]]),
    });
    const completedRun = await successfulRunner.run(retryRun, {
      onEvent: (event) => retryEvents.push(event),
    });

    expect(completedRun).toMatchObject({ status: "success", result: "recovered" });
    expect(retryEvents[0]).toMatchObject({
      type: "run_started",
      retryOfRunId: "run-failed",
      resumeFromNodeId: piNode.instanceId,
    });
    expect(retryEvents[1]).toMatchObject({
      type: "node_completed",
      nodeId: workflow.nodes[0].instanceId,
      reusedFromRunId: "run-failed",
    });
  });

  it("preserves an explicitly skipped alternate branch while retrying the failed branch", async () => {
    const workflow = workflowWithEndMode();
    const [start, , end] = workflow.nodes;
    const condition = {
      instanceId: "condition-branch",
      meta: { id: "pipline.condition", version: "1.0.0" },
      position: { x: 200, y: 100 },
      paramValues: { operator: "exists" },
      portValues: {},
    };
    const trueAssign = {
      instanceId: "assign-true",
      meta: { id: "pipline.assign", version: "2.0.0" },
      position: { x: 400, y: 40 },
      paramValues: { varName: "payload" },
      portValues: { value: { mode: "static", staticValue: { branch: "true" } } },
    };
    const piNode = {
      instanceId: "pi-retry-target",
      meta: { id: "pipline.pi-agent", version: "2.0.0" },
      position: { x: 620, y: 40 },
      paramValues: { prompt: "process the selected branch" },
      portValues: {},
    };
    const falseAssign = {
      instanceId: "assign-false",
      meta: { id: "pipline.assign", version: "2.0.0" },
      position: { x: 400, y: 180 },
      paramValues: { varName: "payload" },
      portValues: { value: { mode: "static", staticValue: { branch: "false" } } },
    };
    const merge = {
      instanceId: "merge-branches",
      meta: { id: "pipline.merge", version: "2.0.0" },
      position: { x: 840, y: 100 },
      paramValues: {},
      portValues: {},
    };
    workflow.nodes = [start, condition, trueAssign, piNode, falseAssign, merge, end];
    workflow.edges = [
      {
        id: "start-condition",
        sourceNodeId: start.instanceId,
        sourcePort: "input",
        targetNodeId: condition.instanceId,
        targetPort: "value",
      },
      {
        id: "condition-true",
        sourceNodeId: condition.instanceId,
        sourcePort: "true",
        targetNodeId: trueAssign.instanceId,
        targetPort: "value",
      },
      {
        id: "condition-false",
        sourceNodeId: condition.instanceId,
        sourcePort: "false",
        targetNodeId: falseAssign.instanceId,
        targetPort: "value",
      },
      {
        id: "true-assign-pi",
        sourceNodeId: trueAssign.instanceId,
        sourcePort: "output",
        targetNodeId: piNode.instanceId,
        targetPort: "context",
      },
      {
        id: "pi-merge",
        sourceNodeId: piNode.instanceId,
        sourcePort: "content",
        targetNodeId: merge.instanceId,
        targetPort: "in0",
      },
      {
        id: "false-merge",
        sourceNodeId: falseAssign.instanceId,
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
    const piKey = nodeMetaKey(piNode.meta);
    const failingRunner = new WorkflowRunner({
      executors: new Map([
        [
          piKey,
          async () => {
            throw new Error("temporary failure");
          },
        ],
      ]),
    });
    const failedRun = await failingRunner.run(
      createWorkflowRun(workflow, {}, { id: "run-branch-failed" }),
    );

    expect(failedRun.status).toBe("error");
    expect(failedRun.nodeStates[falseAssign.instanceId].status).toBe("skipped");
    expect(failedRun.events).toContainEqual(
      expect.objectContaining({ type: "node_skipped", nodeId: falseAssign.instanceId }),
    );

    const retryRun = createWorkflowRetryRun(failedRun, piNode.instanceId, {
      id: "run-branch-retry",
    });
    expect(retryRun.nodeStates[falseAssign.instanceId].status).toBe("idle");
    expect(retryRun.retrySeedStates[falseAssign.instanceId]).toEqual({ status: "skipped" });

    const retriedEvents = [];
    const successfulRunner = new WorkflowRunner({
      executors: new Map([[piKey, async () => ({ content: "recovered" })]]),
    });
    const retried = await successfulRunner.run(retryRun, {
      onEvent: (event) => retriedEvents.push(event),
    });
    expect(retried.status).toBe("success");
    expect(retried.result).toEqual(["recovered"]);
    expect(retried.nodeStates[falseAssign.instanceId].status).toBe("skipped");
    expect(retriedEvents).not.toContainEqual(
      expect.objectContaining({ type: "node_started", nodeId: falseAssign.instanceId }),
    );
  });
});

describe("Condition branch merging", () => {
  it.each([
    { route: "yes", selected: "yes", skipped: "no" },
    { route: "no", selected: "no", skipped: "yes" },
  ])(
    "runs only the $selected branch and merges its value",
    async ({ route, selected, skipped }) => {
      const workflow = workflowWithEndMode();
      const [start, , end] = workflow.nodes;
      const condition = {
        instanceId: "condition-route",
        meta: { id: "pipline.condition", version: "1.0.0" },
        position: { x: 200, y: 140 },
        paramValues: { operator: "equals", expected: { route: "yes" } },
        portValues: {},
      };
      const yes = {
        instanceId: "branch-yes",
        meta: { id: "pipline.assign", version: "2.0.0" },
        position: { x: 420, y: 80 },
        paramValues: { varName: "branch" },
        portValues: { value: { mode: "static", staticValue: "yes" } },
      };
      const no = {
        ...structuredClone(yes),
        instanceId: "branch-no",
        position: { x: 420, y: 200 },
        portValues: { value: { mode: "static", staticValue: "no" } },
      };
      const merge = {
        instanceId: "merge-routed-values",
        meta: { id: "pipline.merge", version: "2.0.0" },
        position: { x: 660, y: 140 },
        paramValues: {},
        portValues: {},
      };
      workflow.nodes = [start, condition, yes, no, merge, end];
      workflow.edges = [
        {
          id: "start-condition",
          sourceNodeId: start.instanceId,
          sourcePort: "input",
          targetNodeId: condition.instanceId,
          targetPort: "value",
        },
        {
          id: "condition-yes",
          sourceNodeId: condition.instanceId,
          sourcePort: "true",
          targetNodeId: yes.instanceId,
          targetPort: "value",
        },
        {
          id: "condition-no",
          sourceNodeId: condition.instanceId,
          sourcePort: "false",
          targetNodeId: no.instanceId,
          targetPort: "value",
        },
        {
          id: "yes-merge",
          sourceNodeId: yes.instanceId,
          sourcePort: "output",
          targetNodeId: merge.instanceId,
          targetPort: "in0",
        },
        {
          id: "no-merge",
          sourceNodeId: no.instanceId,
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

      const run = await new WorkflowRunner().run(
        createWorkflowRun(workflow, { route }, { id: `condition-${route}` }),
      );

      expect(run.status).toBe("success");
      expect(run.result).toEqual([{ branch: { route: selected } }]);
      expect(run.nodeStates[`branch-${selected}`].status).toBe("success");
      expect(run.nodeStates[`branch-${skipped}`].status).toBe("skipped");
      expect(run.nodeStates[merge.instanceId].output).toEqual({
        list: [{ branch: { route: selected } }],
      });
    },
  );
});

describe("Condition nested field paths", () => {
  it.each([
    { input: { profile: { enabled: false } }, expectedBranch: "true" },
    { input: { profile: { enabled: null } }, expectedBranch: "true" },
    { input: { profile: { enabled: 0 } }, expectedBranch: "true" },
    { input: { profile: { enabled: "" } }, expectedBranch: "true" },
    { input: { profile: {} }, expectedBranch: "false" },
  ])(
    "routes exists for $expectedBranch when path is present or missing",
    async ({ input, expectedBranch }) => {
      const workflow = workflowWithEndMode();
      const [start, condition, end] = workflow.nodes;
      condition.meta = { id: "pipline.condition", version: "2.0.0" };
      condition.paramValues = { path: "profile.enabled", operator: "exists" };
      const alternateEnd = {
        ...structuredClone(end),
        instanceId: "end-false",
        position: { x: 660, y: 280 },
      };
      end.instanceId = "end-true";
      workflow.nodes = [start, condition, end, alternateEnd];
      workflow.edges = [
        {
          id: "start-condition",
          sourceNodeId: start.instanceId,
          sourcePort: "input",
          targetNodeId: condition.instanceId,
          targetPort: "value",
        },
        {
          id: "condition-true",
          sourceNodeId: condition.instanceId,
          sourcePort: "true",
          targetNodeId: end.instanceId,
          targetPort: "result",
        },
        {
          id: "condition-false",
          sourceNodeId: condition.instanceId,
          sourcePort: "false",
          targetNodeId: alternateEnd.instanceId,
          targetPort: "result",
        },
      ];

      const run = await new WorkflowRunner().run(
        createWorkflowRun(workflow, input, { id: "condition-exists-path" }),
      );

      expect(run.status).toBe("success");
      expect(run.nodeStates[end.instanceId].status).toBe(
        expectedBranch === "true" ? "success" : "skipped",
      );
      expect(run.nodeStates[alternateEnd.instanceId].status).toBe(
        expectedBranch === "false" ? "success" : "skipped",
      );
    },
  );
});
