// ABOUTME: Filters and applies workflow Host broadcasts to the active editor.

const WORKFLOW_EVENT_TYPES = new Set([
  "workflow_changed",
  "workflow_node_templates_changed",
  "workflow_run_changed",
  "workflow_resync_required",
]);
const TERMINAL_RUN_EVENT_TYPES = new Set([
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
]);

export async function loadWorkflowRevisionIfCurrent({
  getState,
  expectedRevision,
  loadWorkflow,
  applyWorkflow,
}) {
  const initialState = getState();
  const workflow = initialState.activeRecord?.workflow;
  if (!workflow || !initialState.workspaceId) return false;
  if (Number.isSafeInteger(expectedRevision) && expectedRevision <= workflow.revision) return false;

  const workspaceId = initialState.workspaceId;
  const workflowId = workflow.id;
  const latest = await loadWorkflow(workflowId, workspaceId);
  const currentState = getState();
  const currentWorkflow = currentState.activeRecord?.workflow;
  if (
    currentState.workspaceId !== workspaceId ||
    currentWorkflow?.id !== workflowId ||
    !latest?.workflow ||
    latest.workflow.revision <= currentWorkflow.revision
  )
    return false;

  await applyWorkflow(latest);
  return true;
}

function matchesActiveWorkflow(detail, state, expected) {
  const workflowId = state.activeRecord?.workflow?.id;
  return (
    Boolean(state.workflowControl && workflowId) &&
    state.workspaceId === expected.workspaceId &&
    workflowId === expected.workflowId &&
    (!detail.workspaceId || detail.workspaceId === state.workspaceId) &&
    (!["workflow_changed", "workflow_run_changed"].includes(detail.type) ||
      detail.workflowId === workflowId)
  );
}

export function createWorkflowHostEventHandler({
  getState,
  enqueue,
  reloadNodeMetaRegistry,
  loadRemoteWorkflowRevision,
  refreshWorkflowRun,
  onError,
}) {
  return (event) => {
    const detail = event?.detail;
    if (!detail || !WORKFLOW_EVENT_TYPES.has(detail.type)) return;
    const initialState = getState();
    const expected = {
      workspaceId: initialState.workspaceId,
      workflowId: initialState.activeRecord?.workflow?.id,
    };
    if (!matchesActiveWorkflow(detail, initialState, expected)) return;

    const operation = async () => {
      const currentState = getState();
      if (!matchesActiveWorkflow(detail, currentState, expected)) return;
      if (
        detail.type === "workflow_node_templates_changed" ||
        detail.type === "workflow_resync_required"
      )
        await reloadNodeMetaRegistry();
      if (detail.type === "workflow_changed" || detail.type === "workflow_resync_required")
        await loadRemoteWorkflowRevision(detail.revision);
      if (detail.type === "workflow_run_changed") {
        const activeRun = getState().activeRun;
        const currentSequence =
          activeRun?.id === detail.runId ? (activeRun.events?.length ?? 0) : -1;
        if (
          currentSequence < (detail.eventSequence ?? 0) ||
          TERMINAL_RUN_EVENT_TYPES.has(detail.eventType)
        )
          await refreshWorkflowRun(detail.runId);
      }
      if (detail.type === "workflow_resync_required") await refreshWorkflowRun();
    };
    Promise.resolve(enqueue(operation)).catch(onError);
  };
}
