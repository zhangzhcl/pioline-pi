// ABOUTME: Drops stale catalog responses when the active workspace or request changes.

export function createWorkflowNodeCatalogLoader({ getWorkspaceId, listCatalog }) {
  let requestSequence = 0;

  return async function loadWorkflowNodeCatalog() {
    const workspaceId = getWorkspaceId();
    const sequence = ++requestSequence;
    const catalog = await listCatalog(workspaceId);
    if (sequence !== requestSequence || workspaceId !== getWorkspaceId())
      throw new Error("The workflow context changed while loading the node catalog.");
    return catalog;
  };
}
