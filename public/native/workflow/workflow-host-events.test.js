import { describe, expect, it } from "vitest";
import {
  createWorkflowHostEventHandler,
  loadWorkflowRevisionIfCurrent,
} from "./workflow-host-events.js";

function createHarness() {
  let state = {
    workspaceId: "workspace-a",
    activeRecord: { workflow: { id: "workflow-a", revision: 0 } },
    workflowControl: {},
    activeRun: null,
  };
  const queued = [];
  const calls = [];
  const handler = createWorkflowHostEventHandler({
    getState: () => state,
    enqueue: (task) => queued.push(task),
    reloadNodeMetaRegistry: async () => calls.push("reload-catalog"),
    loadRemoteWorkflowRevision: async (revision) => calls.push(["load-workflow", revision]),
    refreshWorkflowRun: async (runId) => calls.push(["refresh-run", runId]),
    onError: (error) => calls.push(["error", error.message]),
  });
  return {
    calls,
    handler,
    queued,
    setState(next) {
      state = next;
    },
  };
}

describe("workflow Host event synchronization", () => {
  it("does not apply a loaded workflow after the user switches workflows", async () => {
    let state = {
      workspaceId: "workspace-a",
      activeRecord: { workflow: { id: "workflow-a", revision: 0 } },
    };
    let finishLoad;
    const applied = [];
    const pending = loadWorkflowRevisionIfCurrent({
      getState: () => state,
      expectedRevision: 1,
      loadWorkflow: () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        }),
      applyWorkflow: (record) => applied.push(record),
    });

    state = {
      workspaceId: "workspace-a",
      activeRecord: { workflow: { id: "workflow-b", revision: 0 } },
    };
    finishLoad({ workflow: { id: "workflow-a", revision: 1 } });

    await expect(pending).resolves.toBe(false);
    expect(applied).toEqual([]);
  });

  it("applies a newer load only while the same workflow is still active", async () => {
    const state = {
      workspaceId: "workspace-a",
      activeRecord: { workflow: { id: "workflow-a", revision: 0 } },
    };
    const applied = [];
    const result = await loadWorkflowRevisionIfCurrent({
      getState: () => state,
      expectedRevision: 1,
      loadWorkflow: async () => ({ workflow: { id: "workflow-a", revision: 1 } }),
      applyWorkflow: (record) => applied.push(record),
    });

    expect(result).toBe(true);
    expect(applied).toHaveLength(1);
  });

  it("drops a queued event after the active workflow changes", async () => {
    const harness = createHarness();
    harness.handler({
      detail: {
        type: "workflow_changed",
        workspaceId: "workspace-a",
        workflowId: "workflow-a",
        revision: 1,
      },
    });
    expect(harness.queued).toHaveLength(1);

    harness.setState({
      workspaceId: "workspace-a",
      activeRecord: { workflow: { id: "workflow-b", revision: 0 } },
      workflowControl: {},
      activeRun: null,
    });
    await harness.queued[0]();

    expect(harness.calls).toEqual([]);
  });

  it("refreshes the current workflow and only loads a newer run event", async () => {
    const harness = createHarness();
    harness.handler({
      detail: {
        type: "workflow_changed",
        workspaceId: "workspace-a",
        workflowId: "workflow-a",
        revision: 1,
      },
    });
    harness.handler({
      detail: {
        type: "workflow_run_changed",
        workspaceId: "workspace-a",
        workflowId: "workflow-a",
        runId: "run-a",
        eventSequence: 2,
      },
    });
    harness.setState({
      workspaceId: "workspace-a",
      activeRecord: { workflow: { id: "workflow-a", revision: 0 } },
      workflowControl: {},
      activeRun: { id: "run-a", events: [{}, {}] },
    });

    await harness.queued[0]();
    await harness.queued[1]();

    expect(harness.calls).toEqual([["load-workflow", 1]]);
  });

  it("refreshes history for a terminal event when its sequence is already loaded", async () => {
    const harness = createHarness();
    harness.setState({
      workspaceId: "workspace-a",
      activeRecord: { workflow: { id: "workflow-a", revision: 0 } },
      workflowControl: {},
      activeRun: { id: "run-a", status: "running", events: [{}, {}, {}] },
    });
    harness.handler({
      detail: {
        type: "workflow_run_changed",
        workspaceId: "workspace-a",
        workflowId: "workflow-a",
        runId: "run-a",
        status: "error",
        eventSequence: 3,
        eventType: "run_failed",
      },
    });

    await harness.queued[0]();

    expect(harness.calls).toEqual([["refresh-run", "run-a"]]);
  });

  it("reloads the trusted NodeMeta catalog when another editor saves a template", async () => {
    const harness = createHarness();
    harness.handler({
      detail: {
        type: "workflow_node_templates_changed",
        workspaceId: "workspace-a",
      },
    });

    expect(harness.queued).toHaveLength(1);
    await harness.queued[0]();

    expect(harness.calls).toEqual(["reload-catalog"]);
  });

  it("does not reload the catalog for a different workspace", () => {
    const harness = createHarness();
    harness.handler({
      detail: {
        type: "workflow_node_templates_changed",
        workspaceId: "workspace-b",
      },
    });

    expect(harness.queued).toHaveLength(0);
    expect(harness.calls).toEqual([]);
  });

  it("resynchronizes catalog, workflow, and run state after a Host gap", async () => {
    const harness = createHarness();
    harness.handler({ detail: { type: "workflow_resync_required" } });
    await harness.queued[0]();

    expect(harness.calls).toEqual([
      "reload-catalog",
      ["load-workflow", undefined],
      ["refresh-run", undefined],
    ]);
  });
});
