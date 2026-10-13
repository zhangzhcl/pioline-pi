// 工作流面板：上下文摘要序列化、自定义 NodeMeta 校验、模板搜索摘要与 Agent 操作归一化。

import { nodeMetaKey } from "./builtin-node-registry.js";
import { localizeNodeMeta } from "./node-meta-localization.js";
import { summarizeWorkflowChanges } from "./workflow-change-summary.js";
import { validateNodeMeta } from "./workflow-contracts.js";
import { boundedAgentValue } from "./workflow-run-context.js";

export function validateNodeMetaCandidate(meta, { requireI18n = false } = {}) {
  const errors = validateNodeMeta(meta);
  if (requireI18n && !meta?.i18n)
    errors.push("custom NodeMeta must include complete en/zh/es/ja i18n display text");
  if (meta?.execution?.kind !== "user-code")
    errors.push("custom nodes must use user-code execution kind");
  if (typeof meta?.id !== "string" || !/^custom\.[a-z0-9][a-z0-9._-]{0,120}$/.test(meta.id))
    errors.push("custom NodeMeta id must use the custom.<slug> namespace");
  if (meta?.type !== "custom") errors.push("custom NodeMeta type must be custom");
  if (meta?.implementationDraft !== undefined) {
    const draft = meta.implementationDraft;
    if (
      draft?.language !== "typescript" ||
      typeof draft.source !== "string" ||
      new TextEncoder().encode(draft.source).byteLength > 50_000 ||
      typeof draft.entryFn !== "string" ||
      !/^[A-Za-z_$][\w$]*$/.test(draft.entryFn)
    )
      errors.push("implementationDraft must be bounded, inert TypeScript source metadata");
    if (
      draft.compilerVersion !== undefined &&
      (typeof draft.compilerVersion !== "string" || draft.compilerVersion !== "esbuild-wasm@0.28.0")
    )
      errors.push("implementationDraft compilerVersion is unsupported");
    if (
      draft.compiledSource !== undefined &&
      (typeof draft.compiledSource !== "string" ||
        new TextEncoder().encode(draft.compiledSource).byteLength > 50_000)
    )
      errors.push("implementationDraft compiledSource is invalid");
    if ((draft.compilerVersion === undefined) !== (draft.compiledSource === undefined))
      errors.push(
        "implementationDraft compiledSource and compilerVersion must be provided together",
      );
  }
  return errors;
}

export function addableNodeTemplates(activeNodeMetas) {
  const templates = [];
  for (const meta of activeNodeMetas.values()) {
    if (meta.catalogHidden === true || meta.type === "start" || meta.type === "end") continue;
    templates.push({ key: nodeMetaKey(meta), label: localizeNodeMeta(meta).label });
  }
  return templates;
}

export function workflowTypeSummary(type, depth = 0) {
  if (typeof type === "string") return type;
  if (!type || typeof type !== "object" || depth >= 3)
    return { kind: type?.kind ?? "unknown", truncated: true };
  if (type.kind === "array")
    return { kind: "array", items: workflowTypeSummary(type.items, depth + 1) };
  if (type.kind !== "object" || !type.schema) return { kind: type.kind ?? "unknown" };
  const entries = Object.entries(type.schema.properties ?? {});
  const properties = Object.fromEntries(
    entries
      .slice(0, 16)
      .map(([name, itemType]) => [name, workflowTypeSummary(itemType, depth + 1)]),
  );
  return {
    kind: "object",
    schema: {
      properties,
      ...(Array.isArray(type.schema.required)
        ? { required: type.schema.required.slice(0, 16) }
        : {}),
      ...(entries.length > 16 ? { omittedPropertyCount: entries.length - 16 } : {}),
    },
  };
}

export function buildWorkflowContextSummary({
  activeRecord,
  activeNodeMetas,
  activeNodeMetaCatalogRevision,
  catalogOffset = 0,
  catalogLimit = 12,
  workflowNodeOffset = 0,
  workflowEdgeOffset = 0,
  workflowItemLimit = 25,
}) {
  const MAX_CATALOG_PAGE_BYTES = 128_000;
  const workflow = activeRecord.workflow;
  const templates = [...activeNodeMetas.values()].filter((meta) => meta.catalogHidden !== true);
  const templateRevision = activeNodeMetaCatalogRevision;
  const catalogPage = [];
  let catalogPageBytes = 0;
  for (
    let index = catalogOffset;
    index < templates.length && catalogPage.length < catalogLimit;
    index += 1
  ) {
    const meta = templates[index];
    const display = localizeNodeMeta(meta);
    const summary = {
      id: meta.id,
      version: meta.version,
      type: meta.type,
      label: display.label,
      description: display.description,
      inputs: display.inputs,
      outputs: display.outputs,
      params: display.params,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(summary)).byteLength;
    if (catalogPage.length > 0 && catalogPageBytes + bytes > MAX_CATALOG_PAGE_BYTES) break;
    catalogPage.push(summary);
    catalogPageBytes += bytes;
  }
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    workspaceId: workflow.workspaceId,
    revision: workflow.revision,
    recentChanges: summarizeWorkflowChanges(activeRecord.events),
    nodes: workflow.nodes
      .slice(workflowNodeOffset, workflowNodeOffset + workflowItemLimit)
      .map((node) => {
        const meta = activeNodeMetas.get(nodeMetaKey(node.meta));
        const display = localizeNodeMeta(meta);
        return {
          instanceId: node.instanceId,
          meta: node.meta,
          label: display?.label ?? node.meta.id,
          description: display?.description?.slice(0, 500) ?? "",
          inputs: (display?.inputs ?? []).map((port) => ({
            name: port.name,
            label: port.label,
            type: workflowTypeSummary(port.type),
            required: port.required,
            multi: port.multi ?? false,
          })),
          outputs: (display?.outputs ?? []).map((port) => ({
            name: port.name,
            label: port.label,
            type: workflowTypeSummary(port.type),
            required: port.required,
          })),
          paramSchema: (display?.params ?? []).map((param) => ({
            name: param.name,
            label: param.label,
            type: param.type,
            required: param.required,
            ...(param.type === "select"
              ? {
                  options: param.options?.slice(0, 32) ?? [],
                  ...(param.options?.length > 32
                    ? { omittedOptionCount: param.options.length - 32 }
                    : {}),
                }
              : {}),
          })),
          params: boundedAgentValue(node.paramValues, 4_000),
          portValues: boundedAgentValue(node.portValues, 4_000),
          position: node.position,
        };
      }),
    edges: workflow.edges.slice(workflowEdgeOffset, workflowEdgeOffset + workflowItemLimit),
    graph: {
      revision: workflow.revision,
      totalNodes: workflow.nodes.length,
      totalEdges: workflow.edges.length,
      nodeOffset: workflowNodeOffset,
      edgeOffset: workflowEdgeOffset,
      itemLimit: workflowItemLimit,
      nextNodeOffset:
        workflowNodeOffset + workflowItemLimit < workflow.nodes.length
          ? workflowNodeOffset + workflowItemLimit
          : null,
      nextEdgeOffset:
        workflowEdgeOffset + workflowItemLimit < workflow.edges.length
          ? workflowEdgeOffset + workflowItemLimit
          : null,
    },
    nodeCatalog: {
      revision: templateRevision,
      total: templates.length,
      offset: catalogOffset,
      limit: catalogLimit,
      serializedBytes: catalogPageBytes,
      nextOffset:
        catalogOffset + catalogPage.length < templates.length
          ? catalogOffset + catalogPage.length
          : null,
    },
    availableNodeTypes: catalogPage.map((meta) => {
      const display = localizeNodeMeta(meta);
      return {
        id: meta.id,
        version: meta.version,
        type: meta.type,
        label: display.label,
        description: display.description,
        inputs: display.inputs,
        outputs: display.outputs,
        params: display.params,
      };
    }),
  };
}

export function workflowNodeTemplateSearchSummary(meta) {
  const display = localizeNodeMeta(meta);
  const boundedList = (items, limit, map) => ({
    items: items.slice(0, limit).map(map),
    ...(items.length > limit ? { omittedCount: items.length - limit } : {}),
  });
  return {
    id: meta.id,
    version: meta.version,
    type: meta.type,
    label: String(display.label ?? "").slice(0, 160),
    description: String(display.description ?? "").slice(0, 400),
    execution: meta.execution.kind,
    permissions: meta.permissions,
    inputs: boundedList(display.inputs ?? [], 8, (port) => ({
      name: port.name,
      label: String(port.label ?? "").slice(0, 120),
      type: workflowTypeSummary(port.type),
      required: port.required,
      multi: port.multi ?? false,
      allowStaticValue: port.allowStaticValue,
    })),
    outputs: boundedList(display.outputs ?? [], 8, (port) => ({
      name: port.name,
      label: String(port.label ?? "").slice(0, 120),
      type: workflowTypeSummary(port.type),
      required: port.required,
      multi: port.multi ?? false,
    })),
    params: boundedList(display.params ?? [], 8, (param) => ({
      name: param.name,
      label: String(param.label ?? "").slice(0, 120),
      ...(param.description ? { description: String(param.description).slice(0, 240) } : {}),
      type: param.type,
      required: param.required,
      ...(param.options
        ? {
            options: param.options.slice(0, 8).map((option) => ({
              label: String(option.label ?? "").slice(0, 100),
              value: option.value,
            })),
            ...(param.options.length > 8 ? { omittedOptionCount: param.options.length - 8 } : {}),
          }
        : {}),
    })),
  };
}

export function normalizeAgentOperations(operations, activeNodeMetas) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 100)
    throw new TypeError("A proposal must contain between 1 and 100 operations.");
  if (JSON.stringify(operations).length > 100_000)
    throw new TypeError("The workflow proposal is larger than the supported limit.");
  const allowed = new Set([
    "add_node",
    "move_node",
    "connect",
    "remove_edge",
    "remove_node",
    "set_param",
    "clear_param",
    "set_input",
    "clear_input",
  ]);
  return operations.map((operation) => {
    if (!operation || typeof operation !== "object" || !allowed.has(operation.type))
      throw new TypeError("The proposal contains an unsupported operation.");
    switch (operation.type) {
      case "add_node": {
        const node = operation.node;
        if (!node || typeof node !== "object") throw new TypeError("New node data is invalid.");
        const meta = { id: node.meta?.id, version: node.meta?.version };
        const known = activeNodeMetas.get(nodeMetaKey(meta));
        if (!known) throw new TypeError("Agent proposals may only add known trusted node types.");
        return {
          type: "add_node",
          node: {
            instanceId: node.instanceId,
            meta,
            position: { x: node.position?.x, y: node.position?.y },
            paramValues: {
              ...Object.fromEntries(
                known.params
                  .filter((param) => param.defaultValue !== undefined)
                  .map((param) => [param.name, structuredClone(param.defaultValue)]),
              ),
              ...(node.paramValues && typeof node.paramValues === "object" ? node.paramValues : {}),
            },
            portValues:
              node.portValues && typeof node.portValues === "object" ? node.portValues : {},
          },
        };
      }
      case "connect":
        return {
          type: "connect",
          edge: {
            id: operation.edge?.id,
            sourceNodeId: operation.edge?.sourceNodeId,
            sourcePort: operation.edge?.sourcePort,
            targetNodeId: operation.edge?.targetNodeId,
            targetPort: operation.edge?.targetPort,
          },
        };
      case "move_node":
        return {
          type: operation.type,
          instanceId: operation.instanceId,
          position: { x: operation.position?.x, y: operation.position?.y },
        };
      case "remove_edge":
        return { type: operation.type, edgeId: operation.edgeId };
      case "remove_node":
        return { type: operation.type, instanceId: operation.instanceId };
      case "set_param":
      case "set_input":
        return {
          type: operation.type,
          instanceId: operation.instanceId,
          name: operation.name,
          value: operation.value,
        };
      case "clear_param":
      case "clear_input":
        return {
          type: operation.type,
          instanceId: operation.instanceId,
          name: operation.name,
        };
      default:
        throw new TypeError("The proposal contains an unsupported operation.");
    }
  });
}
