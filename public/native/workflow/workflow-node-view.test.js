import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_NODE_METAS } from "./builtin-node-registry.js";
import { workflowCanvasInputPorts } from "./workflow-canvas-ports.js";
import { WorkflowNodeView } from "./workflow-node-view.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    Handle: ({ id, type, position }) =>
      React.createElement("span", {
        "data-handle-id": id,
        "data-handle-type": type,
        "data-handle-position": position,
      }),
    Position: { Left: "left", Right: "right" },
  };
});

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

describe("workflow node canvas view", () => {
  it("renders all named Merge by Port labels and distinct target handles", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    const meta = BUILTIN_NODE_METAS.get("pipline.merge-by-port@1.0.0");

    act(() =>
      root.render(
        createElement(WorkflowNodeView, {
          data: {
            label: "按端口合并",
            inputs: workflowCanvasInputPorts(meta),
            outputs: [],
            status: "idle",
          },
        }),
      ),
    );

    expect(
      [...container.querySelectorAll('[data-handle-type="target"]')].map((handle) =>
        handle.getAttribute("data-handle-id"),
      ),
    ).toEqual(["in:input0", "in:input1", "in:input2", "in:input3"]);
    expect(
      [
        ...container.querySelectorAll(".pipline-flow-node__port--input span:not([data-handle-id])"),
      ].map((label) => label.textContent),
    ).toEqual(["Input 1", "Input 2", "Input 3", "Input 4"]);
  });
});
