import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n.js";
import { BUILTIN_NODE_METAS, nodeMetaKey } from "./builtin-node-registry.js";
import { createWorkflowRunControls } from "./workflow-run-controls.js";

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

describe("workflow run controls history", () => {
  let dom;

  afterEach(() => {
    dom?.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.Event;
  });

  it("keeps the latest selected Run when older history loads finish later", async () => {
    dom = new JSDOM("<!doctype html><body></body>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;

    const pendingLoads = new Map();
    const observedRuns = [];
    const control = {
      async listWorkflowRuns() {
        return [];
      },
      loadWorkflowRun(runId) {
        return new Promise((resolve) => pendingLoads.set(runId, resolve));
      },
    };
    const controls = createWorkflowRunControls({
      workflow: workflowFixture,
      control,
      nodeMetas: BUILTIN_NODE_METAS,
      onRunChange: (run) => observedRuns.push(run.id),
    });
    document.body.append(controls);
    await controls.initialize();

    const history = controls.querySelector(".workflow-run-controls__history");
    for (const id of ["run-a", "run-b"]) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      history.append(option);
    }
    const runRecord = (id) => ({
      run: {
        id,
        workspaceId: "workspace-history-rerun",
        workflowId: "workflow-history-rerun",
        workflowRevision: 7,
        status: "success",
        snapshot: { nodes: [] },
        nodeStates: {},
        input: { selected: id },
      },
      events: [{ timestamp: id, type: "run_completed", message: id }],
    });

    history.value = "run-a";
    history.dispatchEvent(new Event("change"));
    history.value = "run-b";
    history.dispatchEvent(new Event("change"));
    pendingLoads.get("run-b")(runRecord("run-b"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    pendingLoads.get("run-a")(runRecord("run-a"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(history.value).toBe("run-b");
    expect(controls.querySelector(".workflow-run-controls__input").value).toContain('"run-b"');
    expect(controls.querySelector(".workflow-run-controls__log").textContent).toContain("run-b");
    expect(controls.querySelector(".workflow-run-controls__log").textContent).not.toContain(
      "run-a",
    );
    expect(observedRuns).toEqual(["run-b"]);
  });

  it("clears stale Run details when the selected history record is missing", async () => {
    dom = new JSDOM("<!doctype html><body></body>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;

    const existingRun = {
      id: "run-existing",
      workspaceId: "workspace-history-rerun",
      workflowId: "workflow-history-rerun",
      workflowRevision: 7,
      status: "success",
      input: { selected: "existing" },
      snapshot: { nodes: [] },
      nodeStates: {},
      events: [{ timestamp: "now", type: "run_completed", message: "old result" }],
    };
    const control = {
      async listWorkflowRuns() {
        return [
          { id: "run-existing", status: "success", workflowRevision: 7, updatedAt: "now" },
          { id: "run-missing", status: "success", workflowRevision: 7, updatedAt: "later" },
          { id: "run-error", status: "error", workflowRevision: 7, updatedAt: "latest" },
        ];
      },
      async loadWorkflowRun(runId) {
        if (runId === existingRun.id) return { run: existingRun, events: existingRun.events };
        if (runId === "run-error") throw new Error("Host is unavailable");
        return null;
      },
    };
    const observedRuns = [];
    const controls = createWorkflowRunControls({
      workflow: workflowFixture,
      control,
      nodeMetas: BUILTIN_NODE_METAS,
      onRunChange: (run) => observedRuns.push(run?.id ?? null),
    });
    document.body.append(controls);
    await controls.initialize();

    const history = controls.querySelector(".workflow-run-controls__history");
    history.value = "run-missing";
    history.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(history.value).toBe("run-missing");
    expect(controls.querySelector(".workflow-run-controls__input").value).toBe("");
    expect(controls.querySelector(".workflow-run-controls__log").textContent).toBe("");
    expect(controls.querySelector(".workflow-run-controls__status").textContent).toBe(
      t("workflow.runLoadError"),
    );
    expect(observedRuns).toEqual(["run-existing", null]);

    history.value = "run-error";
    history.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controls.querySelector(".workflow-run-controls__input").value).toBe("");
    expect(controls.querySelector(".workflow-run-controls__log").textContent).toBe("");
    expect(controls.querySelector(".workflow-run-controls__status").textContent).toBe(
      "Host is unavailable",
    );
    expect(observedRuns).toEqual(["run-existing", null, null]);

    history.value = "";
    history.dispatchEvent(new Event("change"));

    expect(controls.querySelector(".workflow-run-controls__input").value).toBe("");
    expect(controls.querySelector(".workflow-run-controls__log").textContent).toBe("");
    expect(controls.querySelector(".workflow-run-controls__status").textContent).toBe("");
    expect(observedRuns).toEqual(["run-existing", null, null, null]);
  });

  it("rejects Run details returned for a different workspace", async () => {
    dom = new JSDOM("<!doctype html><body></body>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;

    const foreignRun = {
      id: "run-foreign",
      workspaceId: "another-workspace",
      workflowId: "workflow-history-rerun",
      workflowRevision: 7,
      status: "success",
      input: { private: "other workspace" },
      snapshot: { nodes: [] },
      nodeStates: {},
      events: [{ timestamp: "now", type: "run_completed", message: "foreign data" }],
    };
    const control = {
      async listWorkflowRuns() {
        return [{ id: foreignRun.id, status: "success", workflowRevision: 7, updatedAt: "now" }];
      },
      async loadWorkflowRun() {
        return { run: foreignRun, events: foreignRun.events };
      },
    };
    let observedRun = "not-called";
    const controls = createWorkflowRunControls({
      workflow: workflowFixture,
      control,
      nodeMetas: BUILTIN_NODE_METAS,
      onRunChange: (run) => {
        observedRun = run;
      },
    });
    document.body.append(controls);
    await controls.initialize();

    expect(observedRun).toBeNull();
    expect(controls.querySelector(".workflow-run-controls__input").value).toBe("");
    expect(controls.querySelector(".workflow-run-controls__log").textContent).toBe("");
    expect(controls.querySelector(".workflow-run-controls__status").textContent).toBe(
      t("workflow.runLoadError"),
    );
  });

  it("does not persist a Run when the graph contains an untrusted custom node", async () => {
    dom = new JSDOM("<!doctype html><body></body>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;

    const customMeta = {
      schemaVersion: 1,
      id: "custom.generated",
      version: "1.0.0",
      type: "custom",
      label: "Generated step",
      description: "Untrusted candidate",
      inputs: [
        {
          name: "value",
          label: "Value",
          type: "any",
          required: true,
          allowStaticValue: true,
        },
      ],
      outputs: [
        {
          name: "output",
          label: "Output",
          type: "object",
          required: false,
          allowStaticValue: false,
        },
      ],
      params: [{ name: "varName", label: "Field", type: "string", required: true }],
      execution: { kind: "user-code" },
      permissions: { filesystem: "none", network: "none", shell: "none" },
    };
    const nodeMetas = new Map([...BUILTIN_NODE_METAS, [nodeMetaKey(customMeta), customMeta]]);
    const workflow = workflowFixture();
    workflow.nodes[1].meta = { id: customMeta.id, version: customMeta.version };
    workflow.nodes[1].paramValues = { varName: "request" };
    let createCalls = 0;
    let runEnded;
    const executionFinished = new Promise((resolve) => {
      runEnded = resolve;
    });
    const controls = createWorkflowRunControls({
      workflow: () => workflow,
      nodeMetas,
      control: {
        async listWorkflowRuns() {
          return [];
        },
        async createWorkflowRun() {
          createCalls += 1;
          return true;
        },
      },
      onRunEnd: runEnded,
    });
    document.body.append(controls);
    await controls.initialize();

    controls.querySelector(".ui-button--primary").click();
    await executionFinished;

    expect(createCalls).toBe(0);
    expect(controls.querySelector(".workflow-run-controls__status").textContent).toBe(
      t("workflow.executorUnavailable", { nodes: customMeta.label }),
    );
  });

  it("waits for the running node event to persist before invoking its user-code executor", async () => {
    dom = new JSDOM("<!doctype html><body></body>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;

    const customMeta = {
      schemaVersion: 1,
      id: "custom.persist-gate",
      version: "1.0.0",
      type: "custom",
      label: "Persist gate",
      description: "",
      inputs: [
        { name: "value", label: "Value", type: "any", required: true, allowStaticValue: true },
      ],
      outputs: [
        {
          name: "output",
          label: "Output",
          type: "object",
          required: false,
          allowStaticValue: false,
        },
      ],
      params: [{ name: "varName", label: "Field", type: "string", required: true }],
      execution: { kind: "user-code" },
      permissions: { filesystem: "none", network: "none", shell: "none" },
    };
    const nodeMetas = new Map([...BUILTIN_NODE_METAS, [nodeMetaKey(customMeta), customMeta]]);
    const workflow = workflowFixture();
    workflow.nodes[1].meta = { id: customMeta.id, version: customMeta.version };
    workflow.nodes[1].paramValues = { varName: "request" };
    let releaseNodeStart;
    let nodeStartPersisting;
    const nodeStartPending = new Promise((resolve) => {
      nodeStartPersisting = resolve;
    });
    const nodeStartWrite = new Promise((resolve) => {
      releaseNodeStart = resolve;
    });
    let executorCalled = false;
    let finishExecution;
    const executionFinished = new Promise((resolve) => {
      finishExecution = resolve;
    });
    const controls = createWorkflowRunControls({
      workflow: () => workflow,
      nodeMetas,
      executors: new Map([
        [
          nodeMetaKey(customMeta),
          async () => {
            executorCalled = true;
            return { output: { value: "done" } };
          },
        ],
      ]),
      control: {
        async listWorkflowRuns() {
          return [];
        },
        async createWorkflowRun() {
          return true;
        },
        async appendWorkflowRunEvent({ event }) {
          if (event.type === "node_started" && event.nodeId === "assign") {
            nodeStartPersisting();
            await nodeStartWrite;
          }
          return true;
        },
      },
      onRunEnd: finishExecution,
    });
    document.body.append(controls);
    await controls.initialize();

    controls.querySelector(".ui-button--primary").click();
    await nodeStartPending;
    expect(executorCalled).toBe(false);
    releaseNodeStart();
    await executionFinished;
    expect(executorCalled).toBe(true);
  });

  it("restores the latest interrupted Run so the workflow and Pi can explain its outcome", async () => {
    dom = new JSDOM("<!doctype html><body></body>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;

    const interruptedRun = {
      id: "interrupted-history-run",
      workspaceId: "workspace-history-rerun",
      workflowId: "workflow-history-rerun",
      workflowRevision: 7,
      status: "interrupted",
      error: "Host restarted while Pi Agent was running.",
      snapshot: { nodes: [] },
      nodeStates: {},
      events: [{ type: "run_interrupted", error: "Host restarted" }],
    };
    let loadedRunId = null;
    let observedRun = null;
    const control = {
      async listWorkflowRuns() {
        return [
          {
            id: interruptedRun.id,
            status: interruptedRun.status,
            workflowRevision: interruptedRun.workflowRevision,
            updatedAt: "2026-09-27T10:00:00.000Z",
          },
        ];
      },
      async loadWorkflowRun(runId) {
        loadedRunId = runId;
        return { run: interruptedRun, events: interruptedRun.events };
      },
    };
    const controls = createWorkflowRunControls({
      workflow: workflowFixture,
      control,
      nodeMetas: BUILTIN_NODE_METAS,
      onRunChange: (run) => {
        observedRun = run;
      },
    });
    document.body.append(controls);

    await controls.initialize();

    expect(loadedRunId).toBe(interruptedRun.id);
    expect(observedRun).toMatchObject({
      id: interruptedRun.id,
      status: "interrupted",
      error: interruptedRun.error,
      events: interruptedRun.events,
    });
    expect(controls.querySelector(".workflow-run-controls__status").textContent).toBe(
      t("workflow.runStatus.interrupted"),
    );
  });
});
