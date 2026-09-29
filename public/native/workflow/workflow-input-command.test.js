import { describe, expect, it } from "vitest";
import { BUILTIN_NODE_METAS } from "./builtin-node-registry.js";
import { workflowInputCommand } from "./workflow-input-command.js";

describe("workflow input editor commands", () => {
  it("clears an empty number instead of silently saving zero", () => {
    expect(workflowInputCommand({ type: "number" }, { value: "  ", checked: false })).toEqual({
      type: "clear_input",
    });
  });

  it("converts populated scalar and structured values to their port types", () => {
    expect(workflowInputCommand({ type: "number" }, { value: "3.5" })).toEqual({
      type: "set_input",
      value: 3.5,
    });
    expect(workflowInputCommand({ type: "boolean" }, { checked: false })).toEqual({
      type: "set_input",
      value: false,
    });
    expect(workflowInputCommand({ type: "object" }, { value: '{"ok":true}' })).toEqual({
      type: "set_input",
      value: { ok: true },
    });
  });

  it("saves an array value entered for a multi-value Merge input", () => {
    const mergeByPort = BUILTIN_NODE_METAS.get("pipline.merge-by-port@1.0.0");
    const input2 = mergeByPort.inputs.find((port) => port.name === "input2");

    expect(workflowInputCommand(input2, { value: '["manual", {"ready": true}]' })).toEqual({
      type: "set_input",
      value: ["manual", { ready: true }],
    });
  });

  it("preserves explicit JSON null, false, and zero values", () => {
    expect(workflowInputCommand({ type: "any" }, { value: "null" })).toEqual({
      type: "set_input",
      value: null,
    });
    expect(workflowInputCommand({ type: "any" }, { value: "false" })).toEqual({
      type: "set_input",
      value: false,
    });
    expect(workflowInputCommand({ type: "number" }, { value: "0" })).toEqual({
      type: "set_input",
      value: 0,
    });
  });
});
