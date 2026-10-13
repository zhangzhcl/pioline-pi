// 工作流面板：处理 Pi Agent 对工作流图谱与节点目录的读取、搜索与变更提案请求。

import { getLocale, t } from "../../i18n.js";
import { nodeMetaKey } from "./builtin-node-registry.js";
import { nodeMetaApprovalPreview } from "./node-meta-approval-preview.js";
import { localizeNodeMeta } from "./node-meta-localization.js";
import { searchNodeTemplateMetas } from "./node-template-search.js";
import { refreshWorkflowCatalogForAgent } from "./workflow-agent-catalog.js";
import { loadWorkflowSnapshotForAgentRead } from "./workflow-agent-read-snapshot.js";
import { applyWorkflowCommand } from "./workflow-commands.js";
import {
  normalizeAgentOperations,
  validateNodeMetaCandidate,
  workflowNodeTemplateSearchSummary,
} from "./workflow-context-summary.js";
import { validateWorkflow } from "./workflow-contracts.js";
import { validateWorkflowReadPageRequest } from "./workflow-read-pagination.js";
import { workflowRunContextSummary } from "./workflow-run-context.js";

export async function executeAgentWorkflowRequest(
  request,
  {
    dismissSignal,
    getState,
    setActiveRecord,
    setActiveCatalogRevision,
    reloadNodeMetaRegistry,
    waitForPendingWrites,
    hasActiveWorkflowRun,
    workflowContextSummary,
    approveWorkflowProposal,
    onRevisionSynced,
    onNodeMetaSaved,
    enqueueAgentProposalApply,
  },
) {
  const initial = getState();
  if (
    !initial.activeRecord ||
    !initial.workflowService ||
    initial.currentWorkspaceId !== initial.activeRecord.workflow.workspaceId
  ) {
    return { ok: false, error: "Open workflow mode before asking Pi to access a workflow." };
  }

  if (request?.operation === "read") {
    const currentRecord = initial.activeRecord;
    const workflowId = currentRecord.workflow.id;
    const generation = initial.workflowPanelGeneration;
    let latestRecord;
    try {
      latestRecord = await loadWorkflowSnapshotForAgentRead({
        workflowService: initial.workflowService,
        currentRecord,
        workspaceId: initial.currentWorkspaceId,
        waitForPendingWrites,
        refreshNodeMetaCatalog: reloadNodeMetaRegistry,
      });
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
    const afterLoad = getState();
    if (
      generation !== afterLoad.workflowPanelGeneration ||
      !afterLoad.activeRecord ||
      afterLoad.activeRecord.workflow.id !== workflowId ||
      !afterLoad.workflowService
    ) {
      return {
        ok: false,
        cancelled: true,
        error: "Workflow mode changed before the read completed.",
      };
    }
    if (latestRecord.workflow.revision < afterLoad.activeRecord.workflow.revision) {
      return {
        ok: false,
        error:
          "Workflow changed while the read was in flight. Read the current workflow and retry.",
      };
    }
    const revisionChanged =
      latestRecord.workflow.revision !== afterLoad.activeRecord.workflow.revision;
    setActiveRecord(latestRecord);
    if (revisionChanged) {
      onRevisionSynced();
    }
    const currentState = getState();
    const paginationError = validateWorkflowReadPageRequest(request, {
      workflowRevision: currentState.activeRecord.workflow.revision,
      catalogRevision: currentState.activeNodeMetaCatalogRevision,
      nodeCount: currentState.activeRecord.workflow.nodes.length,
      edgeCount: currentState.activeRecord.workflow.edges.length,
      catalogCount: [...currentState.activeNodeMetas.values()].filter(
        (meta) => meta.catalogHidden !== true,
      ).length,
    });
    if (paginationError) return { ok: false, error: paginationError };
    return {
      ok: true,
      workflow: workflowContextSummary({
        catalogOffset: request.catalogOffset ?? 0,
        catalogLimit: request.catalogLimit ?? 12,
        workflowNodeOffset: request.workflowNodeOffset ?? 0,
        workflowEdgeOffset: request.workflowEdgeOffset ?? 0,
        workflowItemLimit: request.workflowItemLimit ?? 25,
      }),
      run: workflowRunContextSummary({
        run: currentState.activeRun,
        activeNodeMetas: currentState.activeNodeMetas,
        localizeNodeMeta,
        nodeMetaKey,
      }),
    };
  }

  if (request?.operation === "search_node_templates") {
    const query = typeof request.query === "string" ? request.query.trim() : "";
    const limit = request.searchLimit ?? 6;
    if (query.length < 2 || query.length > 200)
      return { ok: false, error: "query must contain between 2 and 200 characters." };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8)
      return { ok: false, error: "searchLimit must be an integer from 1 to 8." };
    const catalogRefresh = await refreshWorkflowCatalogForAgent(reloadNodeMetaRegistry);
    if (!catalogRefresh.ok) return catalogRefresh;
    const state = getState();
    const search = searchNodeTemplateMetas(state.activeNodeMetas, query, { limit });
    return {
      ok: true,
      query,
      catalogRevision: state.activeNodeMetaCatalogRevision,
      totalMatches: search.totalMatches,
      matches: search.matches.map(workflowNodeTemplateSearchSummary),
      truncated: search.totalMatches > search.matches.length,
    };
  }

  if (["propose", "propose_node_meta"].includes(request?.operation)) {
    const catalogRefresh = await refreshWorkflowCatalogForAgent(reloadNodeMetaRegistry);
    if (!catalogRefresh.ok) return catalogRefresh;
  }
  const stateAfterRefresh = getState();
  if (
    ["propose", "propose_node_meta"].includes(request?.operation) &&
    (typeof request.expectedCatalogRevision !== "string" ||
      request.expectedCatalogRevision !== stateAfterRefresh.activeNodeMetaCatalogRevision)
  ) {
    return {
      ok: false,
      error:
        "The node catalog changed or was not read. Search or read the current catalog and retry.",
    };
  }
  if (hasActiveWorkflowRun()) {
    return {
      ok: false,
      error: "The workflow and node catalog are read-only while a run is active.",
    };
  }

  if (request?.operation === "propose_node_meta") {
    const candidate = structuredClone(request.meta);
    if (candidate?.implementationDraft) {
      delete candidate.implementationDraft.compilerVersion;
      delete candidate.implementationDraft.compiledSource;
      try {
        const { compileWorkflowCode } = await import("./workflow-code-compiler.js");
        const compiled = await compileWorkflowCode(
          candidate.implementationDraft.source,
          candidate.implementationDraft.entryFn,
        );
        candidate.implementationDraft.compilerVersion = compiled.compilerVersion;
        candidate.implementationDraft.compiledSource = compiled.compiledSource;
      } catch (error) {
        return {
          ok: false,
          error: `The NodeMeta TypeScript implementation could not be compiled: ${error?.message || String(error)}`,
        };
      }
    }
    const errors = validateNodeMetaCandidate(candidate, { requireI18n: true });
    if (errors.length) return { ok: false, error: errors.join("; ") };
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > 180_000)
      return { ok: false, error: "NodeMeta candidate exceeds the 180 KB limit." };
    if (stateAfterRefresh.activeNodeMetas.has(nodeMetaKey(candidate)))
      return { ok: false, error: "This NodeMeta id and version already exists." };
    const generation = stateAfterRefresh.workflowPanelGeneration;
    const preview = nodeMetaApprovalPreview(candidate, getLocale());
    const approved = await approveWorkflowProposal({
      workflow: workflowContextSummary(),
      preview: stateAfterRefresh.activeRecord.workflow,
      operations: [{ type: "save_node_template", meta: candidate }],
      title: t("workflow.nodeMetaProposalTitle"),
      message: t("workflow.nodeMetaProposalMessage", {
        label: preview.label,
        id: candidate.id,
        version: candidate.version,
        definition: JSON.stringify(preview, null, 2),
      }),
      dismissSignal,
    });
    const afterApproval = getState();
    if (generation !== afterApproval.workflowPanelGeneration || !afterApproval.activeRecord) {
      return {
        ok: false,
        cancelled: true,
        error: "Workflow mode closed before approval completed.",
      };
    }
    if (!approved)
      return { ok: false, cancelled: true, error: "The user declined the NodeMeta candidate." };
    if (request.expectedCatalogRevision !== afterApproval.activeNodeMetaCatalogRevision) {
      return {
        ok: false,
        error:
          "The node catalog changed during review. Search or read the current catalog and retry.",
      };
    }
    if (hasActiveWorkflowRun()) {
      return {
        ok: false,
        error: "A workflow run started while approval was pending; no NodeMeta was saved.",
      };
    }
    const saved = await afterApproval.workflowControl.createWorkflowNodeTemplate(
      afterApproval.currentWorkspaceId,
      candidate,
      request.expectedCatalogRevision,
    );
    if (!saved.created)
      return { ok: false, error: "This NodeMeta version already exists or could not be saved." };
    afterApproval.activeNodeMetas.set(nodeMetaKey(candidate), structuredClone(candidate));
    setActiveCatalogRevision(saved.catalogRevision);
    onNodeMetaSaved();
    const catalogSummary = workflowContextSummary();
    return {
      ok: true,
      meta: {
        id: candidate.id,
        version: candidate.version,
        label: candidate.label,
        type: candidate.type,
        implementation: candidate.implementationDraft
          ? {
              compilerVersion: candidate.implementationDraft.compilerVersion,
              compiled: true,
              executable: false,
            }
          : undefined,
      },
      nodeCatalog: catalogSummary.nodeCatalog,
      availableNodeTypes: catalogSummary.availableNodeTypes,
      nextStep:
        "The template is saved in the node catalog but is not yet on the canvas. Unless the user asked only to save a reusable template, read the latest workflow and propose a separately approved graph change to add and configure an instance.",
    };
  }

  if (request?.operation !== "propose")
    return { ok: false, error: "Unsupported Pipline workflow operation." };
  const workflow = stateAfterRefresh.activeRecord.workflow;
  const generation = stateAfterRefresh.workflowPanelGeneration;
  if (request.baseRevision !== workflow.revision) {
    return {
      ok: false,
      error: `Revision conflict: proposal is based on r${request.baseRevision}; current workflow is r${workflow.revision}. Read the current workflow and propose again.`,
    };
  }
  let operations;
  let preview;
  try {
    operations = normalizeAgentOperations(request.operations, stateAfterRefresh.activeNodeMetas);
    preview = structuredClone(workflow);
    for (const operation of operations) {
      applyWorkflowCommand(preview, operation, stateAfterRefresh.activeNodeMetas);
    }
    const errors = validateWorkflow(preview, stateAfterRefresh.activeNodeMetas);
    if (errors.length) throw new TypeError(errors.join("; "));
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
  const approved = await approveWorkflowProposal({
    workflow: workflowContextSummary(),
    preview,
    operations,
    dismissSignal,
  });
  const afterProposeApproval = getState();
  if (
    generation !== afterProposeApproval.workflowPanelGeneration ||
    afterProposeApproval.activeRecord?.workflow.id !== workflow.id
  ) {
    return {
      ok: false,
      cancelled: true,
      error: "Workflow mode closed before the proposal was applied.",
    };
  }
  if (!approved) return { ok: false, cancelled: true, error: "The user declined the proposal." };
  if (request.expectedCatalogRevision !== afterProposeApproval.activeNodeMetaCatalogRevision) {
    return {
      ok: false,
      error:
        "The node catalog changed during review. Search or read the current catalog and retry.",
    };
  }
  if (hasActiveWorkflowRun()) {
    return {
      ok: false,
      error: "A workflow run started while approval was pending. The graph was not changed.",
    };
  }
  if (afterProposeApproval.activeRecord.workflow.revision !== request.baseRevision) {
    return {
      ok: false,
      error: `Workflow changed to r${afterProposeApproval.activeRecord.workflow.revision} while approval was pending. Read the latest workflow and propose again.`,
    };
  }
  return enqueueAgentProposalApply({
    workflow,
    baseRevision: request.baseRevision,
    expectedCatalogRevision: request.expectedCatalogRevision,
    operations,
  });
}
