// ABOUTME: Localizes known Pipline workflow errors while preserving external errors.

import { t } from "../../i18n.js";

const exactErrorKeys = new Map([
  ["Workflow connections cannot contain a cycle.", "cycle"],
  ["A workflow proposal must contain at least one operation.", "emptyProposal"],
  ["Only an empty workflow can use the starter graph.", "starterRequiresEmpty"],
  ["Node template is unavailable.", "nodeTemplateUnavailable"],
  ["This node template is retired and cannot be added.", "retiredNodeTemplate"],
  ["Node instance id already exists.", "duplicateNodeInstance"],
  ["Node position is invalid.", "invalidNodePosition"],
  ["Connection refers to an unknown port.", "unknownPort"],
  ["Port types are incompatible.", "incompatiblePorts"],
  ["This input port only accepts one connection.", "singleConnection"],
  ["Connection id already exists.", "duplicateConnection"],
  ["The Start node cannot be removed.", "startNotRemovable"],
  ["A workflow must keep at least one End node.", "endRequired"],
  ["Unknown node parameter.", "unknownParameter"],
  ["This input does not allow a static value.", "staticInputForbidden"],
  ["Remove the input connection before setting a static value.", "removeConnectionFirst"],
  ["Cannot lay out a workflow with dangling edges.", "danglingEdges"],
  ["Cannot lay out a workflow containing a cycle.", "cycle"],
  ["Merge values input must be an array", "mergeArrayRequired"],
  ["Merge concatenation accepts only arrays", "mergeConcatenationArrays"],
  ["Merge accepts only objects", "mergeObjectsRequired"],
  ["Filter items input must be an array", "filterArrayRequired"],
  ["Workflow graph contains a cycle", "cycle"],
  ["No End node completed; all result branches were skipped.", "noEndCompleted"],
  ["Workflow scheduler could not resolve pending node dependencies.", "schedulerDependencies"],
  ["Run event persistence failed; the durable outcome may be incomplete.", "runPersistenceFailed"],
  ["Workflow changed after this Run snapshot was prepared", "runStaleRevision"],
  ["Run snapshot does not match the saved workflow revision", "runSnapshotMismatch"],
]);

export function workflowErrorMessage(error) {
  const message = error?.message || String(error);
  const key = exactErrorKeys.get(message);
  if (key) return t(`workflow.errors.${key}`);
  if (message.includes("Start inputSchema")) {
    if (/exceeds the maximum|maximum schema depth|maximum total field count/.test(message))
      return t("workflow.errors.startSchemaLimit");
    if (/unsupported/.test(message)) return t("workflow.errors.startSchemaUnsupported");
    return t("workflow.errors.startSchemaInvalid");
  }
  const executorMatch = /^No trusted executor is registered for: (.+)$/.exec(message);
  if (executorMatch) return t("workflow.executorUnavailable", { nodes: executorMatch[1] });
  const missingMatch = /^Workflow input is missing required field: (.+)$/.exec(message);
  if (missingMatch) return t("workflow.errors.startInputMissing", { field: missingMatch[1] });
  const nestedMissingMatch = /^Workflow input field (.+) is missing required field (.+)$/.exec(
    message,
  );
  if (nestedMissingMatch)
    return t("workflow.errors.startInputNestedMissing", {
      parent: nestedMissingMatch[1],
      field: nestedMissingMatch[2],
    });
  const typeMatch =
    /^Workflow input field (.+) must be (string|number|boolean|object|array|any)$/.exec(message);
  if (typeMatch) {
    const type = t(`workflow.inputTypes.${typeMatch[2]}`);
    return t("workflow.errors.startInputType", { field: typeMatch[1], type });
  }
  const extractMatch = /^Extract path not found: (.*)$/.exec(message);
  if (extractMatch) return t("workflow.errors.extractPathNotFound", { path: extractMatch[1] });
  const mergeMatch = /^Merge key conflict: (.*)$/.exec(message);
  if (mergeMatch) return t("workflow.errors.mergeKeyConflict", { key: mergeMatch[1] });
  return message;
}
