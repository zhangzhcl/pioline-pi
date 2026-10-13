import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n.js";
import { BUILTIN_NODE_METAS, nodeMetaKey } from "./builtin-node-registry.js";
import { createWorkflowRunControls } from "./workflow-run-controls.js";
import { createWorkflowRun, WorkflowRunner } from "./workflow-runner.js";

function workflowFixture() {
  return {
    schemaVersion: 1,
    id: "workflow-history-rerun",
    workspaceId: "workspace-history-rerun",
    name: "History rerun",
    revision: 7,
    nodes: [
      {
        instanceId: "start",
        meta: { id: "pipline.start", version: "1.0.0" },
        position: { x: 0, y: 0 },
        paramValues: {},
        portValues: {},
      },
      {
        instanceId: "assign",
        meta: { id: "pipline.assign", version: "2.0.0" },
        position: { x: 200, y: 0 },
        paramValues: { varName: "request" },
        portValues: {},
      },
      {
        instanceId: "end",
        meta: { id: "pipline.end", version: "1.0.0" },
        position: { x: 400, y: 0 },
        paramValues: {},
        portValues: {},
      },
    ],
    edges: [
      {
        id: "start-assign",
        sourceNodeId: "start",
        sourcePort: "input",
        targetNodeId: "assign",
        targetPort: "value",
      },
      {
        id: "assign-end",
        sourceNodeId: "assign",
        sourcePort: "output",
        targetNodeId: "end",
        targetPort: "result",
      },
    ],
  };
}

describe("workflow run controls rerun, conflict, and retry", () => {
  let dom;

  afterEach(() => {
    dom?.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.Event;
  });

  it("reruns the selected immutable snapshot with its original input", async () => {
    dom = new JSDOM("<!doctype html><body></body>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;

    let workflow = workflowFixture();
    const originalInput = { task: "preserve this" };
    const originalRun = await new WorkflowRunner().run(
      createWorkflowRun(workflow, originalInput, {
        id: "history-run",
        createdAt: "2026-09-27T00:00:00.000Z",
        maxConcurrency: 3,
      }),
    );
    workflow = { ...workflow, revision: 8, name: "Edited after the historical run" };
    const createdRuns = [];
    const appendedEvents = [];
    const control = {
      async listWorkflowRuns() {
        return [
          {
            id: originalRun.id,
            status: originalRun.status,
            workflowRevision: originalRun.workflowRevision,
            updatedAt: originalRun.updatedAt,
          },
        ];
      },
      async loadWorkflowRun() {
        return { run: originalRun, events: originalRun.events };
      },
      async createWorkflowRun(run) {
        createdRuns.push(structuredClone(run));
        return true;
      },
      async appendWorkflowRunEvent({ event }) {
        appendedEvents.push(event);
        return true;
      },
    };
    let finishExecution;
    const executionFinished = new Promise((resolve) => {
      finishExecution = resolve;
    });
    const controls = createWorkflowRunControls({
      workflow: () => workflow,
      control,
      nodeMetas: BUILTIN_NODE_METAS,
      onRunEnd: finishExecution,
    });
    document.body.append(controls);
    await controls.initialize();

    const history = controls.querySelector(".workflow-run-controls__history");
    history.value = originalRun.id;
    history.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rerun = controls.querySelectorAll(
      ".workflow-run-controls__actions .ui-button--secondary",
    )[0];
    expect(rerun.disabled).toBe(false);
    rerun.click();
    await executionFinished;

    expect(createdRuns).toHaveLength(1);
    expect(createdRuns[0].id).not.toBe(originalRun.id);
    expect(createdRuns[0]).toMatchObject({
      workflowId: originalRun.workflowId,
      workflowRevision: originalRun.workflowRevision,
      input: originalInput,
      maxConcurrency: 3,
      status: "queued",
    });
    expect(createdRuns[0].snapshot).toEqual(originalRun.snapshot);
    expect(createdRuns[0].nodeMetaSnapshot).toEqual(originalRun.nodeMetaSnapshot);
    expect(appendedEvents.at(-1).type).toBe("run_completed");
  });

  it("reloads a newer workflow after Host rejects a stale Run and asks for review", async () => {
    dom = new JSDOM("<!doctype html><body></body>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;

    const workflow = workflowFixture();
    let refreshed = false;
    let finishExecution;
    const executionFinished = new Promise((resolve) => {
      finishExecution = resolve;
    });
    const control = {
      async listWorkflowRuns() {
        return [];
      },
      async loadWorkflowRun() {
        return null;
      },
      async createWorkflowRun() {
        throw new Error("Workflow changed after this Run snapshot was prepared");
      },
    };
    const controls = createWorkflowRunControls({
      workflow: () => workflow,
      control,
      nodeMetas: BUILTIN_NODE_METAS,
      onWorkflowSnapshotConflict: async () => {
        refreshed = true;
        return true;
      },
      onRunEnd: finishExecution,
    });
    document.body.append(controls);
    await controls.initialize();

    controls.querySelector(".ui-button--primary").click();
    await executionFinished;

    expect(refreshed).toBe(true);
    expect(controls.querySelector(".workflow-run-controls__status").textContent).toBe(
      t("workflow.runSnapshotChanged"),
    );
  });

  it("disables cancel after a terminal event while the final Host write is pending", async () => {
    dom = new JSDOM("<!doctype html><body></body>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;

    let releaseTerminalWrite;
    const terminalWrite = new Promise((resolve) => {
      releaseTerminalWrite = resolve;
    });
    let terminalWriteStarted;
    const terminalWritePending = new Promise((resolve) => {
      terminalWriteStarted = resolve;
    });
    let finishExecution;
    const executionFinished = new Promise((resolve) => {
      finishExecution = resolve;
    });
    const control = {
      async listWorkflowRuns() {
        return [];
      },
      async createWorkflowRun() {
        return true;
      },
      async appendWorkflowRunEvent({ event }) {
        if (event.type === "run_completed") {
          terminalWriteStarted();
          await terminalWrite;
        }
        return true;
      },
    };
    const controls = createWorkflowRunControls({
      workflow: workflowFixture,
      control,
      nodeMetas: BUILTIN_NODE_METAS,
      onRunEnd: finishExecution,
    });
    document.body.append(controls);
    await controls.initialize();

    controls.querySelector(".ui-button--primary").click();
    await terminalWritePending;

    expect(controls.querySelector(".ui-button--danger").disabled).toBe(true);

    releaseTerminalWrite();
    await executionFinished;
  });

  it("resumes the selected failed node from the historical run", async () => {
    dom = new JSDOM("<!doctype html><body></body>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;

    let workflow = workflowFixture();
    const input = { task: "retry this" };
    const assignKey = nodeMetaKey({ id: "pipline.assign", version: "2.0.0" });
    const failedRun = await new WorkflowRunner({
      executors: new Map([
        [
          assignKey,
          async () => {
            throw new Error("temporary error");
          },
        ],
      ]),
    }).run(
      createWorkflowRun(workflow, input, {
        id: "failed-history-run",
        maxConcurrency: 2,
      }),
    );
    expect(failedRun.status).toBe("error");
    workflow = { ...workflow, revision: 8 };
    const createdRuns = [];
    const appendedEvents = [];
    const persistedSnapshots = [];
    const durableRuns = new Map([
      [
        failedRun.id,
        {
          run: structuredClone({ ...failedRun, events: [] }),
          events: structuredClone(failedRun.events),
        },
      ],
    ]);
    const control = {
      async listWorkflowRuns() {
        return [...durableRuns.values()].map(({ run }) => ({
          id: run.id,
          status: run.status,
          workflowRevision: run.workflowRevision,
          updatedAt: run.updatedAt,
        }));
      },
      async loadWorkflowRun(runId) {
        const record = durableRuns.get(runId);
        return record
          ? { run: structuredClone(record.run), events: structuredClone(record.events) }
          : null;
      },
      async createWorkflowRun(run) {
        createdRuns.push(structuredClone(run));
        if (
          [...durableRuns.values()].some(({ run: record }) =>
            ["queued", "running"].includes(record.status),
          )
        )
          return false;
        durableRuns.set(run.id, {
          run: structuredClone({ ...run, events: [] }),
          events: [],
        });
        return true;
      },
      async appendWorkflowRunEvent({ runId, expectedSequence, event, run }) {
        appendedEvents.push(event);
        persistedSnapshots.push(structuredClone(run));
        const record = durableRuns.get(runId);
        if (
          !record ||
          record.events.length !== expectedSequence ||
          event.sequence !== expectedSequence + 1
        )
          return false;
        record.run = structuredClone(run);
        record.events.push(structuredClone(event));
        return true;
      },
    };
    let finishExecution;
    const executionFinished = new Promise((resolve) => {
      finishExecution = resolve;
    });
    const controls = createWorkflowRunControls({
      workflow: () => workflow,
      control,
      nodeMetas: BUILTIN_NODE_METAS,
      onRunEnd: finishExecution,
    });
    document.body.append(controls);
    await controls.initialize();

    const history = controls.querySelector(".workflow-run-controls__history");
    history.value = failedRun.id;
    history.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retryTarget = controls.querySelector(".workflow-run-controls__retry-target");
    expect([...retryTarget.options].map((option) => option.value)).toContain("assign");
    retryTarget.value = "assign";
    retryTarget.dispatchEvent(new Event("change"));

    const retryButton = controls.querySelectorAll(
      ".workflow-run-controls__actions .ui-button--secondary",
    )[1];
    expect(retryButton.disabled).toBe(false);
    retryButton.click();
    await executionFinished;

    expect(createdRuns).toHaveLength(1);
    expect(createdRuns[0]).toMatchObject({
      status: "queued",
      retryOfRunId: failedRun.id,
      resumeFromNodeId: "assign",
      input,
      maxConcurrency: 2,
    });
    expect(createdRuns[0].nodeStates.start).toMatchObject({
      status: "idle",
      output: null,
    });
    expect(createdRuns[0].nodeStates.assign.status).toBe("idle");
    expect(createdRuns[0].nodeStates.end.status).toBe("idle");
    expect(appendedEvents).toContainEqual(
      expect.objectContaining({
        type: "node_completed",
        nodeId: "start",
        output: { input },
        reusedFromRunId: failedRun.id,
      }),
    );
    const startCompletionIndex = appendedEvents.findIndex(
      (event) => event.type === "node_completed" && event.nodeId === "start",
    );
    expect(persistedSnapshots[startCompletionIndex].nodeStates.start).toMatchObject({
      status: "success",
      output: { input },
    });
    expect(appendedEvents).toContainEqual(
      expect.objectContaining({
        type: "node_completed",
        nodeId: "end",
        output: { result: { request: input } },
      }),
    );
    const endCompletionIndex = appendedEvents.findIndex(
      (event) => event.type === "node_completed" && event.nodeId === "end",
    );
    expect(persistedSnapshots[endCompletionIndex].nodeStates.end).toMatchObject({
      status: "success",
      output: { result: { request: input } },
    });
    expect(appendedEvents.at(-1).type).toBe("run_completed");
    const reloadedRetry = await control.loadWorkflowRun(createdRuns[0].id, workflow.workspaceId);
    expect(reloadedRetry.run.status).toBe("success");
    expect(reloadedRetry.run.nodeStates.start).toMatchObject({
      status: "success",
      output: { input },
    });
    expect(reloadedRetry.run.nodeStates.end).toMatchObject({
      status: "success",
      output: { result: { request: input } },
    });
    expect(reloadedRetry.events.at(-1).type).toBe("run_completed");
  });

  it("records skipped node IDs when reconciling an interrupted Run", async () => {
    dom = new JSDOM("<!doctype html><body></body>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;

    const queuedRun = createWorkflowRun(
      workflowFixture(),
      { task: "recover" },
      { id: "queued-recovery" },
    );
    const appendedEvents = [];
    const control = {
      async listWorkflowRuns() {
        return [];
      },
      async createWorkflowRun() {
        return false;
      },
      async loadWorkflowRun() {
        return { run: queuedRun, events: [] };
      },
      async appendWorkflowRunEvent({ event }) {
        appendedEvents.push(event);
        return true;
      },
    };
    let finishExecution;
    const executionFinished = new Promise((resolve) => {
      finishExecution = resolve;
    });
    const controls = createWorkflowRunControls({
      workflow: workflowFixture,
      control,
      nodeMetas: BUILTIN_NODE_METAS,
      onRunEnd: finishExecution,
    });
    document.body.append(controls);
    await controls.initialize();

    controls.querySelector(".ui-button--primary").click();
    await executionFinished;

    expect(appendedEvents).toHaveLength(1);
    expect(appendedEvents[0]).toMatchObject({
      type: "run_interrupted",
      skippedNodeIds: ["start", "assign", "end"],
    });
  });
});
