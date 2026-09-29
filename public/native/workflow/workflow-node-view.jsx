import { Handle, Position } from "@xyflow/react";
import React from "react";

export function WorkflowNodeView({ data }) {
  return React.createElement(
    "article",
    {
      className: `pipline-flow-node pipline-flow-node--${data.status ?? "idle"}${data.observed ? " pipline-flow-node--observed" : ""}`,
      title: data.description || data.label,
    },
    ...data.inputs.map((port) =>
      React.createElement(
        "div",
        { className: "pipline-flow-node__port pipline-flow-node__port--input", key: port.name },
        React.createElement(Handle, { id: port.id, type: "target", position: Position.Left }),
        React.createElement("span", null, port.label),
      ),
    ),
    React.createElement("strong", { className: "pipline-flow-node__label" }, data.label),
    data.status && data.status !== "idle"
      ? React.createElement("span", { className: "pipline-flow-node__status" }, data.statusLabel)
      : null,
    ...data.outputs.map((port) =>
      React.createElement(
        "div",
        { className: "pipline-flow-node__port pipline-flow-node__port--output", key: port.name },
        React.createElement("span", null, port.label),
        React.createElement(Handle, {
          id: `out:${port.name}`,
          type: "source",
          position: Position.Right,
        }),
      ),
    ),
  );
}
