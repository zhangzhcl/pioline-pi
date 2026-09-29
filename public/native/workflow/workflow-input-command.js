function inputType(port) {
  return typeof port.type === "string" ? port.type : port.type?.kind;
}

export function workflowInputCommand(port, control) {
  const type = inputType(port);
  if (type === "number" && control.value.trim() === "") return { type: "clear_input" };

  let value = type === "boolean" ? control.checked : control.value;
  if (
    port.multi === true ||
    typeof port.type === "object" ||
    ["object", "array", "any"].includes(type)
  )
    value = JSON.parse(value);
  if (type === "number") value = Number(value);
  return { type: "set_input", value };
}
