export function workflowCanvasStatusLabel(status, translate) {
  const statusKind = status === "cancelled" ? "runStatus" : "nodeStatus";
  return translate(`workflow.${statusKind}.${status}`);
}

export function workflowCanvasAccessibilityLabels(translate) {
  return {
    "node.a11yDescription.default": translate("workflow.canvasA11y.nodeSelectDescription"),
    "node.a11yDescription.keyboardDisabled": translate("workflow.canvasA11y.nodeMoveDescription"),
    "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }) =>
      translate("workflow.canvasA11y.nodeMoved", { direction, x, y }),
    "edge.a11yDescription.default": translate("workflow.canvasA11y.edgeSelectDescription"),
    "controls.ariaLabel": translate("workflow.canvasA11y.controls"),
    "controls.zoomIn.ariaLabel": translate("workflow.canvasA11y.zoomIn"),
    "controls.zoomOut.ariaLabel": translate("workflow.canvasA11y.zoomOut"),
    "controls.fitView.ariaLabel": translate("workflow.canvasA11y.fitView"),
    "controls.interactive.ariaLabel": translate("workflow.canvasA11y.interactive"),
    "minimap.ariaLabel": translate("workflow.canvasA11y.minimap"),
    "handle.ariaLabel": translate("workflow.canvasA11y.handle"),
  };
}
