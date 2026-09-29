import { describe, expect, it } from "vitest";
import { BUILTIN_NODE_METAS } from "./builtin-node-registry.js";
import { workflowCanvasInputPorts } from "./workflow-canvas-ports.js";

describe("workflow canvas input ports", () => {
  it("exposes every Merge by Port input as a distinct named target handle", () => {
    const meta = BUILTIN_NODE_METAS.get("pipline.merge-by-port@1.0.0");

    expect(workflowCanvasInputPorts(meta)).toEqual([
      { id: "in:input0", name: "input0", label: "Input 1", multi: true },
      { id: "in:input1", name: "input1", label: "Input 2", multi: true },
      { id: "in:input2", name: "input2", label: "Input 3", multi: true },
      { id: "in:input3", name: "input3", label: "Input 4", multi: true },
    ]);
  });

  it("returns no handles when observing Pi subtasks without node metadata", () => {
    expect(workflowCanvasInputPorts(undefined)).toEqual([]);
  });
});
