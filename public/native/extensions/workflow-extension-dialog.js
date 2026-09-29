const WORKFLOW_INPUT_MARKER = "__PIPLINE_WORKFLOW_TOOL_V1__";
const WORKFLOW_INPUT_TITLE = "Pipline workflow bridge";

export function createWorkflowExtensionDialogHandler({ handleWorkflowRequest, showNativeDialog }) {
  return async (request, options) => {
    if (
      request?.method !== "input" ||
      request?.title !== WORKFLOW_INPUT_TITLE ||
      typeof request.placeholder !== "string" ||
      !request.placeholder.startsWith(WORKFLOW_INPUT_MARKER)
    ) {
      return showNativeDialog(request, undefined, options);
    }

    try {
      const toolRequest = JSON.parse(request.placeholder.slice(WORKFLOW_INPUT_MARKER.length));
      const result = await handleWorkflowRequest(toolRequest, {
        dismissSignal: options?.dismissSignal,
      });
      return { value: JSON.stringify(result) };
    } catch (error) {
      return {
        value: JSON.stringify({ ok: false, error: error?.message || String(error) }),
      };
    }
  };
}
