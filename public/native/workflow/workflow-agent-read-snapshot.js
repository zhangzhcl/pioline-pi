// ABOUTME: Reloads the Host-authoritative workflow before exposing it to Pi.

export async function loadWorkflowSnapshotForAgentRead({
  workflowService,
  currentRecord,
  workspaceId,
  waitForPendingWrites,
  refreshNodeMetaCatalog,
}) {
  if (typeof waitForPendingWrites === "function") await waitForPendingWrites();
  if (typeof refreshNodeMetaCatalog === "function") await refreshNodeMetaCatalog();
  const workflowId = currentRecord.workflow.id;
  const latest = await workflowService.load(workflowId, workspaceId);
  if (!latest) throw new Error("The active workflow no longer exists in Pipline storage.");
  if (latest.workflow?.id !== workflowId || latest.workflow?.workspaceId !== workspaceId)
    throw new Error("The Host returned a different workflow or workspace.");
  if (latest.workflow.revision < currentRecord.workflow.revision)
    throw new Error("The Host workflow revision is older than the active editor state.");
  return latest;
}
