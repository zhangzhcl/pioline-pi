export function missingRequiredParams(meta, node) {
  return (meta?.params ?? []).filter(
    (param) =>
      param.required &&
      node?.paramValues?.[param.name] === undefined &&
      param.defaultValue === undefined,
  );
}

export function missingRequiredInputs(meta, node, edges = []) {
  return (meta?.inputs ?? []).filter(
    (port) =>
      port.required &&
      node?.portValues?.[port.name]?.mode !== "static" &&
      !edges.some(
        (edge) => edge.targetNodeId === node?.instanceId && edge.targetPort === port.name,
      ),
  );
}
