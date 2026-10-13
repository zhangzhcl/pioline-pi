import { describe, expect, it } from "vitest";
import { createStarterWorkflow, nodeMetaKey } from "./builtin-node-registry.js";
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
