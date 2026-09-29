// ABOUTME: Projects NodeMeta input ports into stable React Flow target handles.

export function workflowCanvasInputPorts(meta) {
  return (meta?.inputs ?? []).map((port) => ({
    id: `in:${port.name}`,
    name: port.name,
    label: port.label,
    multi: port.multi === true,
  }));
}
