export function shouldBlockWorkflowWindowNavigation({
  currentWorkflowId,
  nextWorkflowId,
  runStatus,
  runInFlight,
}) {
  if (!nextWorkflowId || currentWorkflowId === nextWorkflowId) return false;
  return runInFlight || ["queued", "running"].includes(runStatus);
}
