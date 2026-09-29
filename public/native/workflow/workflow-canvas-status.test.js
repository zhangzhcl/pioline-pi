import { describe, expect, it } from "vitest";
import {
  workflowCanvasAccessibilityLabels,
  workflowCanvasStatusLabel,
} from "./workflow-canvas-status.js";

describe("workflow canvas status labels", () => {
  it("uses the host window's current locale translator for run statuses", () => {
    const translated = [];
    const translate = (key) => {
      translated.push(key);
      return `translated:${key}`;
    };

    expect(workflowCanvasStatusLabel("success", translate)).toBe(
      "translated:workflow.nodeStatus.success",
    );
    expect(translated).toEqual(["workflow.nodeStatus.success"]);
  });

  it("uses run status labels for cancelled states", () => {
    expect(workflowCanvasStatusLabel("cancelled", (key) => key)).toBe(
      "workflow.runStatus.cancelled",
    );
  });

  it("builds React Flow accessibility labels from the host translator", () => {
    const labels = workflowCanvasAccessibilityLabels((key) => `translated:${key}`);

    expect(labels["controls.zoomIn.ariaLabel"]).toBe("translated:workflow.canvasA11y.zoomIn");
    expect(labels["node.a11yDescription.default"]).toBe(
      "translated:workflow.canvasA11y.nodeSelectDescription",
    );
  });
});
