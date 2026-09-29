import { describe, expect, it } from "vitest";
import { missingRequiredInputs, missingRequiredParams } from "./workflow-required-params.js";

describe("missingRequiredParams", () => {
  it("reports only required parameters without an instance value or default", () => {
    const meta = {
      params: [
        { name: "name", required: true },
        { name: "mode", required: true, defaultValue: "safe" },
        { name: "optional", required: false },
      ],
    };
    expect(missingRequiredParams(meta, { paramValues: { mode: "fast" } })).toEqual([
      meta.params[0],
    ]);
  });

  it("treats a saved false or zero as a provided value", () => {
    const meta = {
      params: [
        { name: "enabled", required: true },
        { name: "count", required: true },
      ],
    };
    expect(missingRequiredParams(meta, { paramValues: { enabled: false, count: 0 } })).toEqual([]);
  });

  it("reports required ports without a static value or graph edge", () => {
    const meta = {
      inputs: [
        { name: "prompt", required: true },
        { name: "context", required: true },
        { name: "optional", required: false },
      ],
    };
    const node = {
      instanceId: "node-1",
      portValues: { prompt: { mode: "static", staticValue: "hello" } },
    };
    const edges = [{ targetNodeId: "node-1", targetPort: "context" }];
    expect(missingRequiredInputs(meta, node, edges)).toEqual([]);
    expect(missingRequiredInputs(meta, node)).toEqual([meta.inputs[1]]);
  });
});
