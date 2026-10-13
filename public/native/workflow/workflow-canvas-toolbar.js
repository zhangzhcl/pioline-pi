// 工作流面板：画布顶部工具栏构建、视图模式控件状态同步、头部修订信息与初始工作流装载。

import { t } from "../../i18n.js";
import { randomId } from "../utils/random-id.js";
import { BUILTIN_NODE_METAS, createStarterWorkflow, nodeMetaKey } from "./builtin-node-registry.js";
import { localizeNodeMetaMap } from "./node-meta-localization.js";
import { createPiAgentExecutor } from "./pi-agent-executor.js";
import { applyWorkflowCommand } from "./workflow-commands.js";
import { addableNodeTemplates, validateNodeMetaCandidate } from "./workflow-context-summary.js";
import { validateWorkflow } from "./workflow-contracts.js";
import { createWorkflowRunControls } from "./workflow-run-controls.js";
import { displayWorkflowName } from "./workflow-title.js";

export function createWorkflowPanelRunControls({
  getActiveRecord,
  workflowService,
  workflowControl,
  activeNodeMetas,
  workflowExecutors,
  isPiSessionBusy,
  setPiRunning,
  onBeginRunFlight,
  onEndRunFlight,
  isRunInFlight,
  onSyncLoadedRevision,
  onActiveRunUpdated,
}) {
  return createWorkflowRunControls({
    workflow: () => getActiveRecord().workflow,
    control: workflowControl,
    nodeMetas: activeNodeMetas,
    onRunStart: async (run) => {
      const usesPiAgent = run.snapshot.nodes.some(
        (node) => activeNodeMetas.get(nodeMetaKey(node.meta))?.execution?.kind === "pi-agent",
      );
      if (usesPiAgent && isPiSessionBusy()) throw new Error(t("workflow.piSessionBusy"));
      if (usesPiAgent) await setPiRunning(true);
      onBeginRunFlight();
    },
    onRunEnd: async () => {
      await setPiRunning(false);
      onEndRunFlight();
    },
    onWorkflowSnapshotConflict: async () => {
      const activeRecord = getActiveRecord();
      if (!activeRecord || !workflowService) return false;
      const latest = await workflowService.load(
        activeRecord.workflow.id,
        activeRecord.workflow.workspaceId,
      );
      if (!latest) throw new Error(t("workflow.loadError"));
      onSyncLoadedRevision(latest);
      return true;
    },
    executors: workflowExecutors,
    onRunChange: (run) => {
      const activeRecord = getActiveRecord();
      if (!activeRecord) return;
      if (run) {
        if (
          run.workflowId !== activeRecord.workflow.id ||
          run.workspaceId !== activeRecord.workflow.workspaceId
        )
          return;
      } else if (isRunInFlight()) return;
      onActiveRunUpdated(run);
    },
  });
}

export function buildWorkflowCanvasProps({
  activeRecord,
  activeNodeMetas,
  activeRun,
  viewMode,
  subtaskObserver,
  hasActiveWorkflowRun,
  commandQueueController,
  onSelectNode,
}) {
  return {
    workflow: activeRecord.workflow,
    nodeMetas: localizeNodeMetaMap(activeNodeMetas),
    run: activeRun,
    viewMode,
    observation: subtaskObserver.snapshot(),
    translate: t,
    addableNodes: addableNodeTemplates(activeNodeMetas),
    canAddNodes: viewMode === "workflow" && !hasActiveWorkflowRun(),
    onAddNodeAt: (metaKey, position) => commandQueueController.addWorkflowNode(metaKey, position),
    onMoveNode: (instanceId, position) =>
      commandQueueController.submitCommand({ type: "move_node", instanceId, position }),
    onConnect: (edge) =>
      commandQueueController.submitCommand({ type: "connect", edge: { ...edge, id: randomId() } }),
    onRemoveNode: (instanceId) =>
      commandQueueController.submitCommand({ type: "remove_node", instanceId }),
    onRemoveEdge: (edgeId) => commandQueueController.submitCommand({ type: "remove_edge", edgeId }),
    onSelectNode,
  };
}

export function buildWorkflowExecutors({
  workflowRuntime,
  getTarget,
  getCurrentModel,
  workflowCodeExecutor,
  activeNodeMetas,
}) {
  const piAgentExecutor = createPiAgentExecutor({
    runtime: workflowRuntime,
    getTarget,
    getModel: getCurrentModel,
    onPiRunningChange: () => {},
  });
  const workflowExecutors = new Map([
    ["pipline.pi-agent@1.0.0", piAgentExecutor],
    ["pipline.pi-agent@2.0.0", piAgentExecutor],
  ]);
  if (workflowCodeExecutor) {
    for (const meta of activeNodeMetas.values()) {
      if (meta.execution?.kind === "user-code") {
        workflowExecutors.set(nodeMetaKey(meta), workflowCodeExecutor);
      }
    }
  }
  return workflowExecutors;
}

export function subscribePiSubtaskObserver({
  runtime,
  getWorkspaceId,
  getWorkflowTarget,
  subtaskObserver,
  onConsumed,
}) {
  if (typeof runtime?.subscribe !== "function") return null;
  return runtime.subscribe((frame) => {
    if (
      frame?.type !== "runtime_event" ||
      frame.event?.type?.startsWith("tool_execution_") !== true
    )
      return;
    if (frame.target?.workspaceId !== getWorkspaceId()) return;
    const activeTarget = getWorkflowTarget();
    if (activeTarget?.sessionId && frame.target?.sessionId !== activeTarget.sessionId) return;
    if (!subtaskObserver.consume(frame.event)) return;
    onConsumed();
  });
}

export function populateCustomNodeMetas(targetMap, savedTemplates) {
  for (const key of targetMap.keys()) {
    if (key.startsWith("custom.")) targetMap.delete(key);
  }
  for (const meta of savedTemplates ?? []) {
    const errors = validateNodeMetaCandidate(meta);
    if (!errors.length && meta.id.startsWith("custom.")) {
      targetMap.set(nodeMetaKey(meta), meta);
    } else {
      console.warn("[Workflow] Ignoring invalid stored NodeMeta:", errors);
    }
  }
}

export function createInitialNodeMetas(savedTemplates) {
  const map = new Map(BUILTIN_NODE_METAS);
  populateCustomNodeMetas(map, savedTemplates);
  return map;
}

export async function loadOrSeedActiveWorkflowRecord({
  workflowService,
  preferences,
  workspaceId,
  requestedWorkflowId,
  activeNodeMetas,
  workflowHistory,
}) {
  const activeKey = `ui.workflow.active.${workspaceId}`;
  const workflowId = requestedWorkflowId ?? (await preferences.get(activeKey));
  let record = workflowId ? await workflowService.load(workflowId, workspaceId) : null;
  if (!record) {
    const workflow = createStarterWorkflow({
      id: randomId(),
      workspaceId,
      makeId: randomId,
      timestamp: new Date().toISOString(),
      workflowName: t("workflow.defaultName"),
      initialPiTask: t("workflow.defaultPiTask"),
    });
    await workflowService.create(workflow);
    workflowHistory.clear();
    await preferences.set(activeKey, workflow.id);
    record = { workflow, events: [] };
  } else if (record.workflow.nodes.length === 0) {
    const starter = createStarterWorkflow({
      id: record.workflow.id,
      workspaceId,
      makeId: randomId,
      timestamp: new Date().toISOString(),
      workflowName: t("workflow.defaultName"),
      initialPiTask: t("workflow.defaultPiTask"),
    });
    const result = await workflowService.apply({
      workflowId: record.workflow.id,
      workspaceId,
      baseRevision: record.workflow.revision,
      actor: "system",
      command: {
        type: "seed_starter",
        idempotencyKey: randomId(),
        nodes: starter.nodes,
        edges: starter.edges,
      },
      applyCommand: (current, command) => applyWorkflowCommand(current, command, activeNodeMetas),
    });
    record = { workflow: result.workflow, events: [...record.events, result.event] };
    workflowHistory.clear();
  }
  return record;
}

export function buildWorkflowToolbar({
  hasObservedSubtasks,
  onSelectViewMode,
  onAutoLayout,
  onUndo,
  onRedo,
  onSendContext,
  onSyncLatest,
}) {
  const toolbar = document.createElement("div");
  toolbar.className = "workflow-panel__toolbar";
  const actions = document.createElement("div");
  actions.className = "workflow-panel__actions";
  const workflowView = document.createElement("button");
  workflowView.type = "button";
  workflowView.id = "workflow-view-workflow";
  workflowView.className =
    "ui-button ui-button--sm ui-button--ghost workflow-view-toggle is-active";
  workflowView.textContent = t("workflow.workflowCanvas");
  workflowView.addEventListener("click", () => onSelectViewMode("workflow"));
  const piSubtaskView = document.createElement("button");
  piSubtaskView.type = "button";
  piSubtaskView.id = "workflow-view-pi-subtasks";
  piSubtaskView.className = "ui-button ui-button--sm ui-button--ghost workflow-view-toggle";
  piSubtaskView.textContent = t("workflow.piSubtasks");
  piSubtaskView.disabled = !hasObservedSubtasks;
  piSubtaskView.addEventListener("click", () => onSelectViewMode("pi-subtasks"));
  const sendContext = document.createElement("button");
  sendContext.type = "button";
  sendContext.className = "ui-button ui-button--sm ui-button--secondary";
  sendContext.textContent = t("workflow.sendContext");
  sendContext.addEventListener("click", () => onSendContext());
  const syncLatest = document.createElement("button");
  syncLatest.type = "button";
  syncLatest.className = "ui-button ui-button--sm ui-button--ghost workflow-panel__sync hidden";
  syncLatest.textContent = t("workflow.syncLatest");
  syncLatest.id = "workflow-sync-latest";
  syncLatest.addEventListener("click", () => onSyncLatest());
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "ui-button ui-button--sm ui-button--ghost";
  undo.id = "workflow-undo";
  undo.textContent = t("workflow.undo");
  undo.title = "Ctrl+Z";
  undo.addEventListener("click", () => onUndo());
  const redo = document.createElement("button");
  redo.type = "button";
  redo.className = "ui-button ui-button--sm ui-button--ghost";
  redo.id = "workflow-redo";
  redo.textContent = t("workflow.redo");
  redo.title = "Ctrl+Y";
  redo.addEventListener("click", () => onRedo());
  const autoLayout = document.createElement("button");
  autoLayout.type = "button";
  autoLayout.className = "ui-button ui-button--sm ui-button--ghost";
  autoLayout.id = "workflow-auto-layout";
  autoLayout.textContent = t("workflow.autoLayout");
  autoLayout.addEventListener("click", () => onAutoLayout());
  const saveStatus = document.createElement("span");
  saveStatus.className = "workflow-panel__save-status";
  saveStatus.id = "workflow-save-status";
  actions.append(workflowView, piSubtaskView, autoLayout, undo, redo, sendContext, syncLatest);
  toolbar.append(actions, saveStatus);
  return toolbar;
}

export async function ensureWorkflowCanvasStyles() {
  if (document.getElementById("workflow-canvas-styles")) return;
  const link = document.createElement("link");
  link.id = "workflow-canvas-styles";
  link.rel = "stylesheet";
  link.href = new URL("/vendor/workflow-canvas.css", window.location.href).href;
  document.head.append(link);
}

export function syncWorkflowCanvasViewControls({
  viewMode,
  hasObservedSubtasks,
  hasActiveRun,
  pendingCount,
  canUndo,
  canRedo,
  hasNodes,
}) {
  const workflowView = document.getElementById("workflow-view-workflow");
  const piSubtaskView = document.getElementById("workflow-view-pi-subtasks");
  workflowView?.classList.toggle("is-active", viewMode === "workflow");
  workflowView?.setAttribute("aria-pressed", String(viewMode === "workflow"));
  piSubtaskView?.classList.toggle("is-active", viewMode === "pi-subtasks");
  piSubtaskView?.setAttribute("aria-pressed", String(viewMode === "pi-subtasks"));
  if (piSubtaskView) piSubtaskView.disabled = !hasObservedSubtasks;
  const editLocked = viewMode !== "workflow" || hasActiveRun;
  const undo = document.getElementById("workflow-undo");
  const redo = document.getElementById("workflow-redo");
  const autoLayout = document.getElementById("workflow-auto-layout");
  if (undo) undo.disabled = editLocked || pendingCount > 0 || !canUndo;
  if (redo) redo.disabled = editLocked || pendingCount > 0 || !canRedo;
  if (autoLayout) autoLayout.disabled = editLocked || pendingCount > 0 || !hasNodes;
  document
    .querySelector(".workflow-run-controls")
    ?.classList.toggle("hidden", viewMode !== "workflow");
}

export function renderWorkflowHeaderState(workflow, activeNodeMetas) {
  if (!workflow) return;
  const title = document.getElementById("workflow-panel-title");
  const revision = document.getElementById("workflow-revision");
  if (title) title.textContent = displayWorkflowName(workflow.name, t);
  const incomplete = validateWorkflow(workflow, activeNodeMetas, {
    requireComplete: true,
  }).length;
  if (revision) {
    revision.textContent = `${t("workflow.revision", { revision: workflow.revision, nodes: workflow.nodes.length, edges: workflow.edges.length })}${incomplete ? ` · ${t("workflow.issues", { count: incomplete })}` : ""}`;
    revision.classList.toggle("is-invalid", incomplete > 0);
  }
}

export function renderWorkflowSaveStatus(message, isError = false) {
  const status = document.getElementById("workflow-save-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}
