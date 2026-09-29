// ABOUTME: Validates revision-pinned pages returned to the Pi workflow reader.

export function validateWorkflowReadPageRequest(
  request,
  { workflowRevision, catalogRevision, nodeCount, edgeCount, catalogCount },
) {
  const catalogOffset = request.catalogOffset ?? 0;
  const catalogLimit = request.catalogLimit ?? 12;
  const workflowNodeOffset = request.workflowNodeOffset ?? 0;
  const workflowEdgeOffset = request.workflowEdgeOffset ?? 0;
  const workflowItemLimit = request.workflowItemLimit ?? 25;

  if (!Number.isSafeInteger(catalogOffset) || catalogOffset < 0)
    return "catalogOffset must be a non-negative safe integer.";
  if (!Number.isSafeInteger(catalogLimit) || catalogLimit < 1 || catalogLimit > 25)
    return "catalogLimit must be an integer from 1 to 25.";
  if (catalogOffset > catalogCount) return "catalogOffset is beyond the end of the node catalog.";
  if (!Number.isSafeInteger(workflowNodeOffset) || workflowNodeOffset < 0)
    return "workflowNodeOffset must be a non-negative safe integer.";
  if (!Number.isSafeInteger(workflowEdgeOffset) || workflowEdgeOffset < 0)
    return "workflowEdgeOffset must be a non-negative safe integer.";
  if (!Number.isSafeInteger(workflowItemLimit) || workflowItemLimit < 1 || workflowItemLimit > 100)
    return "workflowItemLimit must be an integer from 1 to 100.";

  const continuation = catalogOffset > 0 || workflowNodeOffset > 0 || workflowEdgeOffset > 0;
  if (
    continuation &&
    (request.expectedWorkflowRevision === undefined ||
      request.expectedCatalogRevision === undefined)
  )
    return "Continuation pages require the workflow and node catalog revisions.";
  if (
    request.expectedWorkflowRevision !== undefined &&
    (!Number.isSafeInteger(request.expectedWorkflowRevision) ||
      request.expectedWorkflowRevision !== workflowRevision)
  )
    return "Workflow changed while paging. Restart the read at offset 0.";
  if (
    request.expectedCatalogRevision !== undefined &&
    (typeof request.expectedCatalogRevision !== "string" ||
      request.expectedCatalogRevision !== catalogRevision)
  )
    return "Node catalog changed while paging. Restart the read at offset 0.";
  if (workflowNodeOffset > nodeCount || workflowEdgeOffset > edgeCount)
    return "Workflow graph offset is beyond the end of the graph.";
  return null;
}
