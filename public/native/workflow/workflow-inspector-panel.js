// 工作流面板：节点属性检查器（Inspector）与 Pi 子任务只读观测详情渲染。

import { t } from "../../i18n.js";
import { enhanceSelect } from "../../ui/select-menu.js";
import { randomId } from "../utils/random-id.js";
import { nodeMetaKey } from "./builtin-node-registry.js";
import { localizeNodeMeta } from "./node-meta-localization.js";
import { validateWorkflow } from "./workflow-contracts.js";
import { workflowErrorMessage } from "./workflow-error-message.js";
import { workflowInputCommand } from "./workflow-input-command.js";
import {
  createInspectorDescription,
  createInspectorError,
  resolveInspectorBooleanParamValue,
  resolveInspectorInputValue,
  resolveInspectorParamLabel,
  resolveInspectorParamValue,
} from "./workflow-inspector.js";
import { missingRequiredInputs, missingRequiredParams } from "./workflow-required-params.js";

export function portTypeName(type) {
  return typeof type === "string" ? type : type?.kind;
}

export function portNeedsJsonEditor(type) {
  return typeof type === "object" || ["object", "array", "any"].includes(portTypeName(type));
}

function appendRequiredParamError(field, label) {
  return appendInspectorFieldError(field, t("workflow.requiredParamMissing", { label }));
}

function appendInspectorFieldError(field, message) {
  const error = createInspectorError(message);
  error.id = `workflow-required-${randomId()}`;
  field.append(error);
  return error.id;
}

export function renderPiSubtaskInspector({
  inspector,
  subtaskObserver,
  selectedObservedNodeId,
  onSelectObservedNodeId,
}) {
  const graph = subtaskObserver.snapshot();
  const heading = document.createElement("h3");
  heading.textContent = t("workflow.piSubtasks");
  inspector.append(heading);
  if (!graph.nodes.length) {
    inspector.append(document.createTextNode(t("workflow.piSubtasksEmpty")));
    return;
  }
  const selected =
    graph.nodes.find((node) => node.id === selectedObservedNodeId) ??
    [...graph.nodes].reverse().find((node) => node.kind === "subtask") ??
    graph.nodes.at(-1);
  if (!selected) return;
  onSelectObservedNodeId(selected.id);
  const label = document.createElement("h4");
  label.textContent = selected.label;
  inspector.append(label);
  const status = document.createElement("p");
  status.className = `workflow-inspector__runtime workflow-inspector__runtime--${selected.status}`;
  status.textContent = `${t(`workflow.nodeStatus.${selected.status}`)} · ${t("workflow.observedReadOnly")}`;
  inspector.append(status);
  if (selected.description) {
    const description = document.createElement("pre");
    description.className = "workflow-inspector__output";
    description.textContent = selected.description;
    inspector.append(description);
  }
  if (selected.summary) {
    const summary = document.createElement("pre");
    summary.className = "workflow-inspector__output";
    summary.textContent = selected.summary;
    inspector.append(summary);
  }
}

export function renderWorkflowInspectorDetails({
  inspector,
  activeRecord,
  activeNodeMetas,
  activeRun,
  viewMode,
  selectedNodeId,
  selectedObservedNodeId,
  onSelectObservedNodeId,
  subtaskObserver,
  submitCommand,
  showSaveStatus,
}) {
  if (!inspector || !activeRecord) return;
  if (Array.isArray(inspector._enhancedSelects)) {
    for (const controller of inspector._enhancedSelects) {
      controller?.destroy?.();
    }
    inspector._enhancedSelects = [];
  }
  inspector.replaceChildren();
  if (viewMode === "pi-subtasks") {
    renderPiSubtaskInspector({
      inspector,
      subtaskObserver,
      selectedObservedNodeId,
      onSelectObservedNodeId,
    });
    return;
  }
  const node = activeRecord.workflow.nodes.find((item) => item.instanceId === selectedNodeId);
  if (!node) {
    inspector.textContent = t("workflow.selectNode");
    return;
  }
  const meta = localizeNodeMeta(activeNodeMetas.get(nodeMetaKey(node.meta)));
  if (!meta) return;
  const missingParams = new Set(missingRequiredParams(meta, node).map((param) => param.name));
  const missingInputs = new Set(
    missingRequiredInputs(meta, node, activeRecord.workflow.edges).map((port) => port.name),
  );
  const startSchemaError =
    meta.type === "start"
      ? validateWorkflow(activeRecord.workflow, activeNodeMetas).find((error) =>
          error.includes("Start inputSchema"),
        )
      : null;
  const readOnly = ["queued", "running"].includes(activeRun?.status);
  const heading = document.createElement("h3");
  heading.textContent = meta.label;
  inspector.append(heading);
  if (meta.description) {
    const description = document.createElement("p");
    description.className = "workflow-inspector__description";
    description.textContent = meta.description;
    inspector.append(description);
  }
  const runState = activeRun?.nodeStates?.[node.instanceId];
  if (runState) {
    const state = document.createElement("p");
    state.className = `workflow-inspector__runtime workflow-inspector__runtime--${runState.status}`;
    state.textContent = `${t(`workflow.nodeStatus.${runState.status}`)}${runState.error ? ` · ${workflowErrorMessage(runState.error)}` : ""}`;
    inspector.append(state);
    if (runState.output !== null && runState.output !== undefined) {
      const output = document.createElement("pre");
      output.className = "workflow-inspector__output";
      output.textContent = JSON.stringify(runState.output, null, 2);
      inspector.append(output);
    }
    if (runState.logs?.length) {
      const logs = document.createElement("pre");
      logs.className = "workflow-inspector__output";
      logs.textContent = runState.logs.join("\n");
      inspector.append(logs);
    }
  }
  const connectedTargetPorts = new Set();
  for (const edge of activeRecord.workflow.edges) {
    if (edge.targetNodeId === node.instanceId) {
      connectedTargetPorts.add(edge.targetPort);
    }
  }
  for (const port of meta.inputs) {
    const missing = missingInputs.has(port.name);
    const label = document.createElement("label");
    label.className = "workflow-inspector__field";
    const caption = document.createElement("span");
    caption.textContent = `${port.label}${port.required ? " *" : ""}`;
    label.append(caption);
    const connected = connectedTargetPorts.has(port.name);
    if (!port.allowStaticValue || connected) {
      const state = document.createElement("span");
      state.textContent = connected ? t("workflow.inputConnected") : t("workflow.inputLinkedOnly");
      label.append(state);
      if (missing) appendRequiredParamError(label, port.label);
    } else {
      const valueType = portTypeName(port.type);
      const jsonEditor = port.multi === true || portNeedsJsonEditor(port.type);
      const input = document.createElement(jsonEditor ? "textarea" : "input");
      if (valueType === "number") input.type = "number";
      if (valueType === "boolean") input.type = "checkbox";
      input.disabled = readOnly;
      const value = resolveInspectorInputValue(node, port);
      if (valueType === "boolean") input.checked = value === true;
      else {
        input.value = jsonEditor ? JSON.stringify(value, null, 2) : String(value);
      }
      input.setAttribute("aria-label", port.label);
      if (port.required) input.setAttribute("aria-required", "true");
      if (missing) input.setAttribute("aria-invalid", "true");
      input.addEventListener("change", () => {
        try {
          submitCommand({
            ...workflowInputCommand(port, input),
            instanceId: node.instanceId,
            name: port.name,
          });
        } catch {
          showSaveStatus(t("workflow.invalidJson"), true);
        }
      });
      label.append(input);
      if (missing)
        input.setAttribute("aria-describedby", appendRequiredParamError(label, port.label));
    }
    inspector.append(label);
  }
  for (const param of meta.params) {
    const label = document.createElement("label");
    label.className = "workflow-inspector__field";
    const missing = missingParams.has(param.name);
    const schemaError =
      meta.type === "start" && param.name === "inputSchema" ? startSchemaError : null;
    const caption = document.createElement("span");
    const paramLabel = resolveInspectorParamLabel(param, t);
    caption.textContent = `${paramLabel}${param.required ? " *" : ""}`;
    const structuredParam = ["json", "object", "array"].includes(param.type);
    const input =
      param.type === "string" || structuredParam
        ? document.createElement("textarea")
        : document.createElement("input");
    if (param.type === "select") {
      const select = document.createElement("select");
      for (const option of param.options ?? []) {
        const element = document.createElement("option");
        element.value = option.value;
        element.textContent = option.labelKey ? t(option.labelKey) : option.label;
        select.append(element);
      }
      select.value = String(node.paramValues[param.name] ?? param.defaultValue ?? "");
      select.disabled = readOnly;
      select.setAttribute("aria-label", paramLabel);
      if (param.required) select.setAttribute("aria-required", "true");
      if (missing) select.setAttribute("aria-invalid", "true");
      select.addEventListener("change", () =>
        submitCommand({
          type: "set_param",
          instanceId: node.instanceId,
          name: param.name,
          value: select.value,
        }),
      );
      label.append(caption, select);
      const enhancedController = enhanceSelect(select);
      if (enhancedController) {
        inspector._enhancedSelects ??= [];
        inspector._enhancedSelects.push(enhancedController);
      }
      const description = createInspectorDescription(param.description);
      if (description) label.append(description);
      if (missing)
        select.setAttribute("aria-describedby", appendRequiredParamError(label, paramLabel));
      inspector.append(label);
      continue;
    }
    if (param.type === "number") input.type = "number";
    if (param.type === "boolean") input.type = "checkbox";
    input.disabled = readOnly;
    if (param.type === "boolean") input.checked = resolveInspectorBooleanParamValue(node, param);
    else {
      const value = resolveInspectorParamValue(node, param);
      input.value = structuredParam ? JSON.stringify(value, null, 2) : String(value);
    }
    input.setAttribute("aria-label", paramLabel);
    if (param.required) input.setAttribute("aria-required", "true");
    if (missing || schemaError) input.setAttribute("aria-invalid", "true");
    input.addEventListener("change", () => {
      try {
        if (param.type === "number" && input.value.trim() === "") {
          submitCommand({ type: "clear_param", instanceId: node.instanceId, name: param.name });
          return;
        }
        const value =
          param.type === "boolean"
            ? input.checked
            : param.type === "number"
              ? Number(input.value)
              : structuredParam
                ? JSON.parse(input.value)
                : input.value;
        submitCommand({ type: "set_param", instanceId: node.instanceId, name: param.name, value });
      } catch {
        showSaveStatus(t("workflow.invalidJson"), true);
      }
    });
    label.append(caption, input);
    const description = createInspectorDescription(param.description);
    if (description) label.append(description);
    if (schemaError) {
      input.setAttribute(
        "aria-describedby",
        appendInspectorFieldError(label, workflowErrorMessage(schemaError)),
      );
    }
    if (missing)
      input.setAttribute("aria-describedby", appendRequiredParamError(label, paramLabel));
    inspector.append(label);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ui-button ui-button--sm ui-button--danger";
  remove.textContent = t("workflow.deleteNode");
  remove.disabled =
    readOnly ||
    meta.type === "start" ||
    (meta.type === "end" &&
      activeRecord.workflow.nodes.filter(
        (item) => activeNodeMetas.get(nodeMetaKey(item.meta))?.type === "end",
      ).length <= 1);
  remove.addEventListener("click", () =>
    submitCommand({ type: "remove_node", instanceId: node.instanceId }),
  );
  inspector.append(remove);
}
