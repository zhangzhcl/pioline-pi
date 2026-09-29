// ABOUTME: Bridges trusted DAG executor calls to the Host's isolated code helper.

export function createWorkflowCodeExecutor(control) {
  if (typeof control?.executeWorkflowCode !== "function")
    throw new TypeError("Workflow code execution is unavailable from the Host");
  return async ({ node, workflow, runId, inputs, signal, log }) => {
    if (signal?.aborted)
      throw new DOMException("Workflow code execution was cancelled", "AbortError");
    const result = await control.executeWorkflowCode({
      runId,
      workspaceId: workflow.workspaceId,
      nodeId: node.instanceId,
      inputs,
      signal,
    });
    if (signal?.aborted)
      throw new DOMException("Workflow code execution was cancelled", "AbortError");
    for (const line of result.logs ?? []) log(line);
    if (!result.output || typeof result.output !== "object" || Array.isArray(result.output))
      throw new TypeError("Workflow code must return an object whose keys match its output ports");
    return result.output;
  };
}
