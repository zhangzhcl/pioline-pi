// ABOUTME: Builds accessible workflow inspector help text.

export function createInspectorDescription(text, documentRef = document) {
  if (typeof text !== "string" || text.length === 0) return null;
  const description = documentRef.createElement("p");
  description.className = "workflow-inspector__field-description";
  description.textContent = text;
  return description;
}

export function resolveInspectorParamLabel(param, translate) {
  return param?.labelKey ? translate(param.labelKey) : (param?.label ?? "");
}

export function resolveInspectorParamValue(node, param) {
  const values = node?.paramValues ?? {};
  if (Object.hasOwn(values, param.name)) return values[param.name];
  if (param.defaultValue !== undefined) return param.defaultValue;
  if (param.type === "object") return {};
  if (param.type === "array") return [];
  if (param.type === "json") return null;
  return "";
}

export function resolveInspectorBooleanParamValue(node, param) {
  return resolveInspectorParamValue(node, param) === true;
}

export function resolveInspectorInputValue(node, port) {
  const binding = node?.portValues?.[port.name];
  if (binding?.mode === "static") return binding.staticValue;
  if (port.multi === true || port.type === "array" || port.type?.kind === "array") return [];
  const type = typeof port.type === "string" ? port.type : port.type?.kind;
  if (type === "object") return {};
  if (type === "boolean") return false;
  if (type === "number") return 0;
  return "";
}

export function createInspectorError(text, documentRef = document) {
  const error = documentRef.createElement("span");
  error.className = "workflow-inspector__field-error";
  error.textContent = String(text);
  return error;
}
