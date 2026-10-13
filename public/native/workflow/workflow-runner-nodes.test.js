import { describe, expect, it } from "vitest";
import { BUILTIN_NODE_METAS, createStarterWorkflow, nodeMetaKey } from "./builtin-node-registry.js";
import { createWorkflowRun, WorkflowRunner } from "./workflow-runner.js";

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
