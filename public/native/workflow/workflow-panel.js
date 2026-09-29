// ABOUTME: Lazily loaded workflow-mode shell. Ordinary Pi sessions never load
// this module, React, React Flow, or canvas styles.

import { getLocale, onLocaleChange, t } from "../../i18n.js";
import { randomId } from "../utils/random-id.js";
import { BUILTIN_NODE_METAS, createStarterWorkflow, nodeMetaKey } from "./builtin-node-registry.js";
import { nodeMetaApprovalPreview } from "./node-meta-approval-preview.js";
import { localizeNodeMeta, localizeNodeMetaMap } from "./node-meta-localization.js";
import { searchNodeTemplateMetas } from "./node-template-search.js";
import { createPiAgentExecutor } from "./pi-agent-executor.js";
import { PiSubtaskObserver } from "./pi-subtask-observer.js";
import { refreshWorkflowCatalogForAgent } from "./workflow-agent-catalog.js";
import { loadWorkflowSnapshotForAgentRead } from "./workflow-agent-read-snapshot.js";
import { summarizeWorkflowChanges } from "./workflow-change-summary.js";
import { createWorkflowCodeExecutor } from "./workflow-code-executor.js";
import { applyWorkflowCommand } from "./workflow-commands.js";
import { validateNodeMeta, validateWorkflow } from "./workflow-contracts.js";
import { workflowErrorMessage } from "./workflow-error-message.js";
import { WorkflowHistory } from "./workflow-history.js";
import {
  createWorkflowHostEventHandler,
  loadWorkflowRevisionIfCurrent,
} from "./workflow-host-events.js";
import { workflowInputCommand } from "./workflow-input-command.js";
import {
  createInspectorDescription,
  createInspectorError,
  resolveInspectorBooleanParamValue,
  resolveInspectorInputValue,
  resolveInspectorParamLabel,
  resolveInspectorParamValue,
} from "./workflow-inspector.js";
import { layoutWorkflowNodes } from "./workflow-layout.js";
import { createWorkflowModeTargetSynchronizer } from "./workflow-mode-target.js";
import { createWorkflowNodeCatalogLoader } from "./workflow-node-catalog-loader.js";
import { validateWorkflowReadPageRequest } from "./workflow-read-pagination.js";
import { missingRequiredInputs, missingRequiredParams } from "./workflow-required-params.js";
import { boundedAgentValue, workflowRunContextSummary } from "./workflow-run-context.js";
import { createWorkflowRunControls } from "./workflow-run-controls.js";
import { createHostWorkflowRepository, WorkflowService } from "./workflow-service.js";
import { displayWorkflowName } from "./workflow-title.js";
import { shouldBlockWorkflowWindowNavigation } from "./workflow-window-navigation.js";

let currentWorkspaceId = null;
let workflowService = null;
let workflowControl = null;
const loadWorkflowNodeCatalog = createWorkflowNodeCatalogLoader({
  getWorkspaceId: () => currentWorkspaceId,
  listCatalog: (workspaceId) => workflowControl.listWorkflowNodeTemplates(workspaceId),
});
let activeNodeMetas = new Map(BUILTIN_NODE_METAS);
let activeNodeMetaCatalogRevision = null;
let activeRecord = null;
let canvas = null;
let selectedNodeId = null;
let commandQueue = Promise.resolve();
let commandQueuePending = 0;
let activeRun = null;
let refreshWorkflowRun = async () => {};
let workflowRuntime = null;
let getWorkflowTarget = () => null;
let getCurrentModel = () => null;
let isPiSessionBusy = () => false;
let workflowTargetForRun = null;
let workflowCodeExecutor = null;
let setPiRunning = () => {};
let setWorkflowToolsEnabled = async () => {};
let approveWorkflowProposal = async () => false;
let cancelWorkflowRun = () => {};
let workflowRunInFlight = false;
let workflowRunSettled = Promise.resolve();
let resolveWorkflowRunSettled = null;
let workflowPanelGeneration = 0;
let standaloneWorkflowWindow = false;
let subtaskObserver = new PiSubtaskObserver();
let viewMode = "workflow";
let selectedObservedNodeId = null;
let unsubscribePiObserver = null;
const workflowHistory = new WorkflowHistory();
const workflowModeTargetSynchronizer = createWorkflowModeTargetSynchronizer({
  getTarget: () => getWorkflowTarget(),
  getWorkspaceId: () => currentWorkspaceId,
  isOpen: () => {
    const panel = document.getElementById("workflow-panel");
    return Boolean(panel && !panel.classList.contains("hidden") && !standaloneWorkflowWindow);
  },
  setToolsEnabled: (enabled, target) => setWorkflowToolsEnabled(enabled, target),
});

onLocaleChange(() => {
  const panel = document.getElementById("workflow-panel");
  if (!panel || panel.classList.contains("hidden")) return;
  populateNodeSelector(document.getElementById("workflow-add-node"));
  canvas?.update(canvasProps());
  updateWorkflowHeader();
  renderWorkflowDetails();
});

const handleWorkflowHostEvent = createWorkflowHostEventHandler({
  getState: () => ({
    workspaceId: currentWorkspaceId,
    activeRecord,
    activeRun,
    workflowControl,
  }),
  enqueue: (operation) => {
    commandQueue = commandQueue.catch(() => {}).then(operation);
    return commandQueue;
  },
  reloadNodeMetaRegistry,
  loadRemoteWorkflowRevision,
  refreshWorkflowRun: (...args) => refreshWorkflowRun(...args),
  onError: (error) => showSaveStatus(workflowErrorMessage(error), true),
});
window.addEventListener("pipline:workflow-host-event", handleWorkflowHostEvent);

function portTypeName(type) {
  return typeof type === "string" ? type : type?.kind;
}

function portNeedsJsonEditor(type) {
  return typeof type === "object" || ["object", "array", "any"].includes(portTypeName(type));
}

function hasActiveWorkflowRun() {
  return ["queued", "running"].includes(activeRun?.status);
}

export function requestStandaloneWorkflowNavigation(nextWorkflowId) {
  if (!standaloneWorkflowWindow || typeof nextWorkflowId !== "string") return false;
  if (
    shouldBlockWorkflowWindowNavigation({
      currentWorkflowId: activeRecord?.workflow.id,
      nextWorkflowId,
      runStatus: activeRun?.status,
      runInFlight: workflowRunInFlight,
    })
  ) {
    showSaveStatus(t("workflow.navigationBlocked"), true);
    return false;
  }
  return true;
}

export async function toggleWorkflowPanel({
  control,
  preferences,
  workspaceId,
  runtime,
  getTarget,
  getPiBusy,
  getModel,
  onPiRunningChange,
  setAgentToolsEnabled,
  requestAgentApproval,
  standalone = false,
  requestedWorkflowId = null,
}) {
  standaloneWorkflowWindow = standalone;
  if (!workspaceId) throw new Error("Open a project before starting workflow mode.");
  const panel = document.getElementById("workflow-panel");
  const button = document.getElementById("workflow-mode-toggle");
  if (!panel || !button) throw new Error("Workflow panel is unavailable.");

  if (!panel.classList.contains("hidden") && currentWorkspaceId === workspaceId) {
    closeWorkflowPanel();
    return;
  }
  if (!panel.classList.contains("hidden") && currentWorkspaceId !== workspaceId)
    closeWorkflowPanel();
  if (workflowRunInFlight) await workflowRunSettled;
  if (currentWorkspaceId !== workspaceId) {
    workflowHistory.clear();
    subtaskObserver = new PiSubtaskObserver();
    viewMode = "workflow";
    selectedObservedNodeId = null;
    unsubscribePiObserver?.();
    unsubscribePiObserver = null;
  }

  panel.classList.remove("hidden");
  button.setAttribute("aria-expanded", "true");
  currentWorkspaceId = workspaceId;
  workflowPanelGeneration += 1;
  const body = document.getElementById("workflow-panel-body");
  body.textContent = t("workflow.loading");

  workflowControl = control;
  workflowCodeExecutor = null;
  try {
    const capabilities = await control.getWorkflowExecutionCapabilities();
    if (capabilities.codeExecution) workflowCodeExecutor = createWorkflowCodeExecutor(control);
  } catch (error) {
    console.warn("[Workflow] Isolated code execution is unavailable", error);
  }
  const templateCatalog = await control.listWorkflowNodeTemplates(workspaceId);
  const savedTemplates = templateCatalog.templates;
  activeNodeMetas = new Map(BUILTIN_NODE_METAS);
  for (const meta of savedTemplates) {
    const errors = validateNodeMetaCandidate(meta);
    if (!errors.length && meta.id.startsWith("custom."))
      activeNodeMetas.set(nodeMetaKey(meta), meta);
    else console.warn("[Workflow] Ignoring invalid stored NodeMeta:", errors);
  }
  activeNodeMetaCatalogRevision = templateCatalog.catalogRevision;
  workflowService = new WorkflowService(createHostWorkflowRepository(control), {
    nodeMetas: activeNodeMetas,
  });
  workflowRuntime = runtime;
  if (!unsubscribePiObserver && typeof runtime?.subscribe === "function") {
    unsubscribePiObserver = runtime.subscribe((frame) => {
      if (
        frame?.type !== "runtime_event" ||
        frame.event?.type?.startsWith("tool_execution_") !== true
      )
        return;
      if (frame.target?.workspaceId !== currentWorkspaceId) return;
      const activeTarget = getWorkflowTarget();
      if (activeTarget?.sessionId && frame.target?.sessionId !== activeTarget.sessionId) return;
      if (!subtaskObserver.consume(frame.event)) return;
      updateCanvasViewControls();
      canvas?.update(canvasProps());
      if (viewMode === "pi-subtasks") renderWorkflowDetails();
    });
  }
  getWorkflowTarget = getTarget ?? (() => null);
  isPiSessionBusy = getPiBusy ?? (() => false);
  getCurrentModel = getModel ?? (() => null);
  setPiRunning = onPiRunningChange ?? (() => {});
  setWorkflowToolsEnabled = setAgentToolsEnabled ?? (async () => {});
  approveWorkflowProposal = requestAgentApproval ?? (async () => false);
  const activeKey = `ui.workflow.active.${workspaceId}`;
  const workflowId = requestedWorkflowId ?? (await preferences.get(activeKey));
  activeRecord = workflowId ? await workflowService.load(workflowId, workspaceId) : null;
  if (!activeRecord) {
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
    activeRecord = { workflow, events: [] };
  } else if (activeRecord.workflow.nodes.length === 0) {
    const starter = createStarterWorkflow({
      id: activeRecord.workflow.id,
      workspaceId,
      makeId: randomId,
      timestamp: new Date().toISOString(),
      workflowName: t("workflow.defaultName"),
      initialPiTask: t("workflow.defaultPiTask"),
    });
    const result = await workflowService.apply({
      workflowId: activeRecord.workflow.id,
      workspaceId,
      baseRevision: activeRecord.workflow.revision,
      actor: "system",
      command: {
        type: "seed_starter",
        idempotencyKey: randomId(),
        nodes: starter.nodes,
        edges: starter.edges,
      },
      applyCommand: (current, command) => applyWorkflowCommand(current, command, activeNodeMetas),
    });
    activeRecord = { workflow: result.workflow, events: [...activeRecord.events, result.event] };
    workflowHistory.clear();
  }
  await showCanvas();
  if (!standalone) await workflowModeTargetSynchronizer.sync();
}

// Keep the Pi tool enabled only in the currently foreground session while the
// workflow canvas is open. Serialize transitions so rapid session changes
// cannot leave the tool enabled in an old session or disabled in the new one.
export function syncWorkflowModeTarget() {
  return workflowModeTargetSynchronizer.sync();
}

async function showCanvas() {
  const body = document.getElementById("workflow-panel-body");
  body.replaceChildren();
  const toolbar = document.createElement("div");
  toolbar.className = "workflow-panel__toolbar";
  const actions = document.createElement("div");
  actions.className = "workflow-panel__actions";
  const addNode = document.createElement("select");
  addNode.className = "ui-select workflow-panel__add-node";
  addNode.setAttribute("aria-label", t("workflow.addNode"));
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = t("workflow.addNode");
  addNode.append(placeholder);
  populateNodeSelector(addNode);
  const workflowView = document.createElement("button");
  workflowView.type = "button";
  workflowView.id = "workflow-view-workflow";
  workflowView.className =
    "ui-button ui-button--sm ui-button--ghost workflow-view-toggle is-active";
  workflowView.textContent = t("workflow.workflowCanvas");
  workflowView.addEventListener("click", () => setViewMode("workflow"));
  const piSubtaskView = document.createElement("button");
  piSubtaskView.type = "button";
  piSubtaskView.id = "workflow-view-pi-subtasks";
  piSubtaskView.className = "ui-button ui-button--sm ui-button--ghost workflow-view-toggle";
  piSubtaskView.textContent = t("workflow.piSubtasks");
  piSubtaskView.disabled = subtaskObserver.snapshot().nodes.length === 0;
  piSubtaskView.addEventListener("click", () => setViewMode("pi-subtasks"));
  addNode.addEventListener("change", () => {
    const selected = addNode.value;
    addNode.value = "";
    if (selected) addWorkflowNode(selected);
  });
  addNode.id = "workflow-add-node";
  const sendContext = document.createElement("button");
  sendContext.type = "button";
  sendContext.className = "ui-button ui-button--sm ui-button--secondary";
  sendContext.textContent = t("workflow.sendContext");
  sendContext.addEventListener("click", () => sendWorkflowContext());
  const syncLatest = document.createElement("button");
  syncLatest.type = "button";
  syncLatest.className = "ui-button ui-button--sm ui-button--ghost workflow-panel__sync hidden";
  syncLatest.textContent = t("workflow.syncLatest");
  syncLatest.id = "workflow-sync-latest";
  syncLatest.addEventListener("click", () => syncLatestWorkflow());
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "ui-button ui-button--sm ui-button--ghost";
  undo.id = "workflow-undo";
  undo.textContent = t("workflow.undo");
  undo.title = "Ctrl+Z";
  undo.addEventListener("click", () => undoWorkflow());
  const redo = document.createElement("button");
  redo.type = "button";
  redo.className = "ui-button ui-button--sm ui-button--ghost";
  redo.id = "workflow-redo";
  redo.textContent = t("workflow.redo");
  redo.title = "Ctrl+Y";
  redo.addEventListener("click", () => redoWorkflow());
  const autoLayout = document.createElement("button");
  autoLayout.type = "button";
  autoLayout.className = "ui-button ui-button--sm ui-button--ghost";
  autoLayout.id = "workflow-auto-layout";
  autoLayout.textContent = t("workflow.autoLayout");
  autoLayout.addEventListener("click", () => autoLayoutWorkflow());
  const saveStatus = document.createElement("span");
  saveStatus.className = "workflow-panel__save-status";
  saveStatus.id = "workflow-save-status";
  actions.append(
    addNode,
    workflowView,
    piSubtaskView,
    autoLayout,
    undo,
    redo,
    sendContext,
    syncLatest,
  );
  toolbar.append(actions, saveStatus);

  const stage = document.createElement("div");
  stage.className = "workflow-canvas";
  stage.id = "workflow-canvas";
  const inspector = document.createElement("section");
  inspector.className = "workflow-inspector";
  inspector.id = "workflow-inspector";
  const piAgentExecutor = createPiAgentExecutor({
    runtime: workflowRuntime,
    getTarget: () => workflowTargetForRun ?? getWorkflowTarget(),
    getModel: getCurrentModel,
    // The whole Run owns the composer lock; individual Pi nodes must not
    // release it between sequential agent steps.
    onPiRunningChange: () => {},
  });
  const workflowExecutors = new Map([
    ["pipline.pi-agent@1.0.0", piAgentExecutor],
    ["pipline.pi-agent@2.0.0", piAgentExecutor],
  ]);
  if (workflowCodeExecutor) {
    for (const meta of activeNodeMetas.values()) {
      if (meta.execution?.kind === "user-code")
        workflowExecutors.set(nodeMetaKey(meta), workflowCodeExecutor);
    }
  }
  const runControls = createWorkflowRunControls({
    workflow: () => activeRecord.workflow,
    control: workflowControl,
    nodeMetas: activeNodeMetas,
    onRunStart: async (run) => {
      const usesPiAgent = run.snapshot.nodes.some(
        (node) => activeNodeMetas.get(nodeMetaKey(node.meta))?.execution?.kind === "pi-agent",
      );
      if (usesPiAgent && isPiSessionBusy()) throw new Error(t("workflow.piSessionBusy"));
      if (usesPiAgent) await setPiRunning(true);
      workflowTargetForRun = getWorkflowTarget();
      workflowRunInFlight = true;
      workflowRunSettled = new Promise((resolve) => {
        resolveWorkflowRunSettled = resolve;
      });
    },
    onRunEnd: async () => {
      workflowTargetForRun = null;
      await setPiRunning(false);
      workflowRunInFlight = false;
      resolveWorkflowRunSettled?.();
      resolveWorkflowRunSettled = null;
      workflowRunSettled = Promise.resolve();
    },
    onWorkflowSnapshotConflict: async () => {
      if (!activeRecord || !workflowService) return false;
      const latest = await workflowService.load(
        activeRecord.workflow.id,
        activeRecord.workflow.workspaceId,
      );
      if (!latest) throw new Error(t("workflow.loadError"));
      activeRecord = latest;
      workflowHistory.clear();
      document.getElementById("workflow-sync-latest")?.classList.add("hidden");
      updateWorkflowHeader();
      canvas?.update(canvasProps());
      renderWorkflowDetails();
      updateCanvasViewControls();
      return true;
    },
    executors: workflowExecutors,
    onRunChange: (run) => {
      if (!activeRecord) return;
      if (run) {
        if (
          run.workflowId !== activeRecord.workflow.id ||
          run.workspaceId !== activeRecord.workflow.workspaceId
        )
          return;
      } else if (workflowRunInFlight) return;
      activeRun = run;
      applyRunReadOnlyState();
      canvas?.update(canvasProps());
      renderWorkflowDetails();
    },
  });
  refreshWorkflowRun = runControls.refreshRemoteRun ?? (async () => {});
  cancelWorkflowRun = () => runControls.cancelRun?.();
  body.append(toolbar, stage, inspector, runControls);

  await loadCanvasStyles();
  const { mountWorkflowCanvas } = await import("../../vendor/workflow-canvas.js");
  canvas = mountWorkflowCanvas(stage, canvasProps());
  renderWorkflowDetails();
  updateWorkflowHeader();
}

async function loadCanvasStyles() {
  if (document.getElementById("workflow-canvas-styles")) return;
  const link = document.createElement("link");
  link.id = "workflow-canvas-styles";
  link.rel = "stylesheet";
  link.href = new URL("/vendor/workflow-canvas.css", window.location.href).href;
  document.head.append(link);
}

function canvasProps() {
  return {
    workflow: activeRecord.workflow,
    nodeMetas: localizeNodeMetaMap(activeNodeMetas),
    run: activeRun,
    viewMode,
    observation: subtaskObserver.snapshot(),
    translate: t,
    onMoveNode: (instanceId, position) =>
      submitCommand({ type: "move_node", instanceId, position }),
    onConnect: (edge) => submitCommand({ type: "connect", edge: { ...edge, id: randomId() } }),
    onRemoveNode: (instanceId) => submitCommand({ type: "remove_node", instanceId }),
    onRemoveEdge: (edgeId) => submitCommand({ type: "remove_edge", edgeId }),
    onSelectNode: (instanceId) => {
      if (viewMode === "pi-subtasks") selectedObservedNodeId = instanceId;
      else selectedNodeId = instanceId;
      renderWorkflowDetails();
    },
  };
}

function setViewMode(nextMode) {
  if (nextMode !== "workflow" && nextMode !== "pi-subtasks") return;
  if (nextMode === "pi-subtasks" && subtaskObserver.snapshot().nodes.length === 0) return;
  viewMode = nextMode;
  updateCanvasViewControls();
  canvas?.update(canvasProps());
  renderWorkflowDetails();
}

function updateCanvasViewControls() {
  const workflowView = document.getElementById("workflow-view-workflow");
  const piSubtaskView = document.getElementById("workflow-view-pi-subtasks");
  workflowView?.classList.toggle("is-active", viewMode === "workflow");
  workflowView?.setAttribute("aria-pressed", String(viewMode === "workflow"));
  piSubtaskView?.classList.toggle("is-active", viewMode === "pi-subtasks");
  piSubtaskView?.setAttribute("aria-pressed", String(viewMode === "pi-subtasks"));
  if (piSubtaskView) piSubtaskView.disabled = subtaskObserver.snapshot().nodes.length === 0;
  const editLocked = viewMode !== "workflow" || hasActiveWorkflowRun();
  const undo = document.getElementById("workflow-undo");
  const redo = document.getElementById("workflow-redo");
  const autoLayout = document.getElementById("workflow-auto-layout");
  if (undo) undo.disabled = editLocked || commandQueuePending > 0 || !workflowHistory.canUndo();
  if (redo) redo.disabled = editLocked || commandQueuePending > 0 || !workflowHistory.canRedo();
  if (autoLayout)
    autoLayout.disabled =
      editLocked || commandQueuePending > 0 || !activeRecord?.workflow.nodes.length;
  const addNode = document.getElementById("workflow-add-node");
  if (addNode) addNode.disabled = viewMode !== "workflow" || hasActiveWorkflowRun();
  document
    .querySelector(".workflow-run-controls")
    ?.classList.toggle("hidden", viewMode !== "workflow");
}

function validateNodeMetaCandidate(meta, { requireI18n = false } = {}) {
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

async function reloadNodeMetaRegistry() {
  const templateCatalog = await loadWorkflowNodeCatalog();
  const savedTemplates = templateCatalog.templates;
  for (const key of activeNodeMetas.keys())
    if (key.startsWith("custom.")) activeNodeMetas.delete(key);
  for (const meta of savedTemplates) {
    const errors = validateNodeMetaCandidate(meta);
    if (!errors.length && meta.id.startsWith("custom."))
      activeNodeMetas.set(nodeMetaKey(meta), meta);
    else console.warn("[Workflow] Ignoring invalid stored NodeMeta:", errors);
  }
  activeNodeMetaCatalogRevision = templateCatalog.catalogRevision;
  populateNodeSelector(document.getElementById("workflow-add-node"));
  canvas?.update(canvasProps());
  updateWorkflowHeader();
}

async function loadRemoteWorkflowRevision(expectedRevision) {
  if (!workflowService) return false;
  return loadWorkflowRevisionIfCurrent({
    getState: () => ({ workspaceId: currentWorkspaceId, activeRecord }),
    expectedRevision,
    loadWorkflow: (workflowId, workspaceId) => workflowService.load(workflowId, workspaceId),
    applyWorkflow: (latest) => {
      workflowHistory.clear();
      activeRecord = latest;
      document.getElementById("workflow-sync-latest")?.classList.add("hidden");
      updateWorkflowHeader();
      canvas?.update(canvasProps());
      renderWorkflowDetails();
      updateCanvasViewControls();
      showSaveStatus(t("workflow.synced"));
    },
  });
}

function submitCommand(command) {
  if (hasActiveWorkflowRun()) {
    showSaveStatus(t("workflow.editLocked"), true);
    return Promise.resolve();
  }
  commandQueuePending += 1;
  updateCanvasViewControls();
  commandQueue = commandQueue
    .catch(() => {})
    .then(async () => {
      const workflow = activeRecord.workflow;
      const before = structuredClone(workflow);
      const result = await workflowService.apply({
        workflowId: workflow.id,
        workspaceId: workflow.workspaceId,
        baseRevision: workflow.revision,
        actor: "user",
        command: { ...command, idempotencyKey: randomId() },
        applyCommand: (draft, normalizedCommand) =>
          applyWorkflowCommand(draft, normalizedCommand, activeNodeMetas),
      });
      workflowHistory.record(before, result.workflow);
      activeRecord = { workflow: result.workflow, events: [...activeRecord.events, result.event] };
      updateWorkflowHeader();
      canvas?.update(canvasProps());
      renderWorkflowDetails();
      updateCanvasViewControls();
      showSaveStatus(t("workflow.saved"));
    })
    .catch((error) => {
      showSaveStatus(workflowErrorMessage(error), true);
      document.getElementById("workflow-sync-latest")?.classList.remove("hidden");
      canvas?.update(canvasProps());
    })
    .finally(() => {
      commandQueuePending = Math.max(0, commandQueuePending - 1);
      updateCanvasViewControls();
    });
  return commandQueue;
}

function restoreWorkflowSnapshot(target, historyEntry, direction) {
  commandQueuePending += 1;
  updateCanvasViewControls();
  commandQueue = commandQueue
    .catch(() => {})
    .then(async () => {
      if (!activeRecord || !workflowService || hasActiveWorkflowRun()) return;
      const current = activeRecord.workflow;
      const matches =
        direction === "undo"
          ? workflowHistory.matchesUndo(current, historyEntry)
          : workflowHistory.matchesRedo(current, historyEntry);
      if (!matches) {
        workflowHistory.clear();
        throw new Error(
          "Workflow changed while history action was queued; reload the latest workflow.",
        );
      }
      const command = {
        type: direction === "undo" ? "undo_snapshot" : "redo_snapshot",
        snapshot: {
          nodes: target.nodes,
          edges: target.edges,
        },
        idempotencyKey: randomId(),
      };
      const result = await workflowService.apply({
        workflowId: current.id,
        workspaceId: current.workspaceId,
        baseRevision: current.revision,
        actor: "user",
        command,
        applyCommand: (draft, normalizedCommand) => {
          if (
            !normalizedCommand.snapshot ||
            !Array.isArray(normalizedCommand.snapshot.nodes) ||
            !Array.isArray(normalizedCommand.snapshot.edges)
          )
            throw new TypeError("Workflow history snapshot is invalid.");
          draft.nodes = structuredClone(normalizedCommand.snapshot.nodes);
          draft.edges = structuredClone(normalizedCommand.snapshot.edges);
        },
      });
      // Commit the in-memory history only after Host CAS and graph validation succeed.
      activeRecord = { workflow: result.workflow, events: [...activeRecord.events, result.event] };
      if (direction === "undo") workflowHistory.commitUndo(historyEntry);
      else workflowHistory.commitRedo(historyEntry);
      canvas?.update(canvasProps());
      updateWorkflowHeader();
      updateCanvasViewControls();
      renderWorkflowDetails();
      showSaveStatus(t(direction === "undo" ? "workflow.undone" : "workflow.redone"));
    })
    .catch((error) => {
      if (error?.name === "WorkflowRevisionConflict") workflowHistory.clear();
      updateCanvasViewControls();
      showSaveStatus(workflowErrorMessage(error), true);
    })
    .finally(() => {
      commandQueuePending = Math.max(0, commandQueuePending - 1);
      updateCanvasViewControls();
    });
  return commandQueue;
}

function undoWorkflow() {
  if (!activeRecord || hasActiveWorkflowRun() || viewMode !== "workflow" || !commandQueueSettled())
    return;
  const prepared = workflowHistory.prepareUndo(activeRecord.workflow);
  if (!prepared) {
    workflowHistory.clear();
    updateCanvasViewControls();
    return;
  }
  restoreWorkflowSnapshot(prepared.target, prepared.entry, "undo");
}

function redoWorkflow() {
  if (!activeRecord || hasActiveWorkflowRun() || viewMode !== "workflow" || !commandQueueSettled())
    return;
  const prepared = workflowHistory.prepareRedo(activeRecord.workflow);
  if (!prepared) {
    workflowHistory.clear();
    updateCanvasViewControls();
    return;
  }
  restoreWorkflowSnapshot(prepared.target, prepared.entry, "redo");
}

function commandQueueSettled() {
  return commandQueuePending === 0;
}

function autoLayoutWorkflow() {
  if (!activeRecord || hasActiveWorkflowRun() || viewMode !== "workflow") return;
  try {
    const operations = layoutWorkflowNodes(activeRecord.workflow).filter((operation) => {
      const node = activeRecord.workflow.nodes.find(
        (item) => item.instanceId === operation.instanceId,
      );
      return (
        node &&
        (node.position.x !== operation.position.x || node.position.y !== operation.position.y)
      );
    });
    if (!operations.length) {
      showSaveStatus(t("workflow.layoutAlreadyApplied"));
      return;
    }
    submitCommand({ type: "apply_batch", operations });
  } catch (error) {
    showSaveStatus(workflowErrorMessage(error), true);
  }
}

document.addEventListener("keydown", (event) => {
  if (document.getElementById("workflow-panel")?.classList.contains("hidden")) return;
  if (event.altKey || event.metaKey || !(event.ctrlKey && event.key.toLowerCase() === "z")) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  )
    return;
  event.preventDefault();
  if (event.shiftKey) redoWorkflow();
  else undoWorkflow();
});

document.addEventListener("keydown", (event) => {
  if (document.getElementById("workflow-panel")?.classList.contains("hidden")) return;
  if (event.altKey || event.metaKey || !(event.ctrlKey && event.key.toLowerCase() === "y")) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  )
    return;
  event.preventDefault();
  redoWorkflow();
});

function addWorkflowNode(metaKey) {
  const meta = activeNodeMetas.get(metaKey);
  if (!meta) return;
  const offset = activeRecord.workflow.nodes.length * 36;
  submitCommand({
    type: "add_node",
    node: {
      instanceId: randomId(),
      meta: { id: meta.id, version: meta.version },
      position: { x: 220 + offset, y: 280 + offset },
      paramValues: Object.fromEntries(
        meta.params
          .filter((param) => param.defaultValue !== undefined)
          .map((param) => [param.name, structuredClone(param.defaultValue)]),
      ),
      portValues: {},
    },
  });
}

function populateNodeSelector(select) {
  if (!select) return;
  const placeholder = select.options[0];
  select.replaceChildren(placeholder);
  for (const meta of activeNodeMetas.values()) {
    if (meta.catalogHidden === true || meta.type === "start" || meta.type === "end") continue;
    const option = document.createElement("option");
    option.value = nodeMetaKey(meta);
    option.textContent = localizeNodeMeta(meta).label;
    select.append(option);
  }
}

function sendWorkflowContext() {
  const summary = workflowContextSummary();
  window.dispatchEvent(
    new CustomEvent("pipline:workflow-context-request", {
      detail: { summary, workspaceId: currentWorkspaceId },
    }),
  );
}

function workflowTypeSummary(type, depth = 0) {
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

function workflowContextSummary({
  catalogOffset = 0,
  catalogLimit = 12,
  workflowNodeOffset = 0,
  workflowEdgeOffset = 0,
  workflowItemLimit = 25,
} = {}) {
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

function workflowNodeTemplateSearchSummary(meta) {
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

function normalizeAgentOperations(operations) {
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

export async function handleAgentWorkflowRequest(request, { dismissSignal } = {}) {
  if (!activeRecord || !workflowService || currentWorkspaceId !== activeRecord.workflow.workspaceId)
    return { ok: false, error: "Open workflow mode before asking Pi to access a workflow." };
  if (request?.operation === "read") {
    const currentRecord = activeRecord;
    const workflowId = currentRecord.workflow.id;
    const generation = workflowPanelGeneration;
    let latestRecord;
    try {
      latestRecord = await loadWorkflowSnapshotForAgentRead({
        workflowService,
        currentRecord,
        workspaceId: currentWorkspaceId,
        waitForPendingWrites: () => commandQueue.catch(() => {}),
        refreshNodeMetaCatalog: reloadNodeMetaRegistry,
      });
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
    if (
      generation !== workflowPanelGeneration ||
      !activeRecord ||
      activeRecord.workflow.id !== workflowId ||
      !workflowService
    )
      return {
        ok: false,
        cancelled: true,
        error: "Workflow mode changed before the read completed.",
      };
    if (latestRecord.workflow.revision < activeRecord.workflow.revision)
      return {
        ok: false,
        error:
          "Workflow changed while the read was in flight. Read the current workflow and retry.",
      };
    const revisionChanged = latestRecord.workflow.revision !== activeRecord.workflow.revision;
    activeRecord = latestRecord;
    if (revisionChanged) {
      workflowHistory.clear();
      document.getElementById("workflow-sync-latest")?.classList.add("hidden");
      updateWorkflowHeader();
      canvas?.update(canvasProps());
      renderWorkflowDetails();
      updateCanvasViewControls();
    }
    const paginationError = validateWorkflowReadPageRequest(request, {
      workflowRevision: activeRecord.workflow.revision,
      catalogRevision: activeNodeMetaCatalogRevision,
      nodeCount: activeRecord.workflow.nodes.length,
      edgeCount: activeRecord.workflow.edges.length,
      catalogCount: [...activeNodeMetas.values()].filter((meta) => meta.catalogHidden !== true)
        .length,
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
        run: activeRun,
        activeNodeMetas,
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
    const search = searchNodeTemplateMetas(activeNodeMetas, query, { limit });
    return {
      ok: true,
      query,
      catalogRevision: activeNodeMetaCatalogRevision,
      totalMatches: search.totalMatches,
      matches: search.matches.map(workflowNodeTemplateSearchSummary),
      truncated: search.totalMatches > search.matches.length,
    };
  }
  if (["propose", "propose_node_meta"].includes(request?.operation)) {
    const catalogRefresh = await refreshWorkflowCatalogForAgent(reloadNodeMetaRegistry);
    if (!catalogRefresh.ok) return catalogRefresh;
  }
  if (
    ["propose", "propose_node_meta"].includes(request?.operation) &&
    (typeof request.expectedCatalogRevision !== "string" ||
      request.expectedCatalogRevision !== activeNodeMetaCatalogRevision)
  )
    return {
      ok: false,
      error:
        "The node catalog changed or was not read. Search or read the current catalog and retry.",
    };
  if (hasActiveWorkflowRun())
    return {
      ok: false,
      error: "The workflow and node catalog are read-only while a run is active.",
    };
  if (request?.operation === "propose_node_meta") {
    const candidate = structuredClone(request.meta);
    if (candidate?.implementationDraft) {
      // Never trust compiler artifacts supplied by Pi. Recreate them locally
      // from the bounded TS source; they remain inert metadata until a sandboxed
      // runtime is integrated and enabled in a later milestone.
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
    if (activeNodeMetas.has(nodeMetaKey(candidate)))
      return { ok: false, error: "This NodeMeta id and version already exists." };
    const generation = workflowPanelGeneration;
    const preview = nodeMetaApprovalPreview(candidate, getLocale());
    const approved = await approveWorkflowProposal({
      workflow: workflowContextSummary(),
      preview: activeRecord.workflow,
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
    if (generation !== workflowPanelGeneration || !activeRecord)
      return {
        ok: false,
        cancelled: true,
        error: "Workflow mode closed before approval completed.",
      };
    if (!approved)
      return { ok: false, cancelled: true, error: "The user declined the NodeMeta candidate." };
    if (request.expectedCatalogRevision !== activeNodeMetaCatalogRevision)
      return {
        ok: false,
        error:
          "The node catalog changed during review. Search or read the current catalog and retry.",
      };
    if (hasActiveWorkflowRun())
      return {
        ok: false,
        error: "A workflow run started while approval was pending; no NodeMeta was saved.",
      };
    const saved = await workflowControl.createWorkflowNodeTemplate(
      currentWorkspaceId,
      candidate,
      request.expectedCatalogRevision,
    );
    if (!saved.created)
      return { ok: false, error: "This NodeMeta version already exists or could not be saved." };
    activeNodeMetas.set(nodeMetaKey(candidate), structuredClone(candidate));
    activeNodeMetaCatalogRevision = saved.catalogRevision;
    populateNodeSelector(document.getElementById("workflow-add-node"));
    canvas?.update(canvasProps());
    renderWorkflowDetails();
    showSaveStatus(t("workflow.nodeMetaSaved"));
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
  const workflow = activeRecord.workflow;
  const generation = workflowPanelGeneration;
  if (request.baseRevision !== workflow.revision)
    return {
      ok: false,
      error: `Revision conflict: proposal is based on r${request.baseRevision}; current workflow is r${workflow.revision}. Read the current workflow and propose again.`,
    };
  let operations;
  let preview;
  try {
    operations = normalizeAgentOperations(request.operations);
    preview = structuredClone(workflow);
    for (const operation of operations) applyWorkflowCommand(preview, operation, activeNodeMetas);
    const errors = validateWorkflow(preview, activeNodeMetas);
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
  if (generation !== workflowPanelGeneration || activeRecord?.workflow.id !== workflow.id)
    return {
      ok: false,
      cancelled: true,
      error: "Workflow mode closed before the proposal was applied.",
    };
  if (!approved) return { ok: false, cancelled: true, error: "The user declined the proposal." };
  if (request.expectedCatalogRevision !== activeNodeMetaCatalogRevision)
    return {
      ok: false,
      error:
        "The node catalog changed during review. Search or read the current catalog and retry.",
    };
  if (hasActiveWorkflowRun())
    return {
      ok: false,
      error: "A workflow run started while approval was pending. The graph was not changed.",
    };
  if (activeRecord.workflow.revision !== request.baseRevision)
    return {
      ok: false,
      error: `Workflow changed to r${activeRecord.workflow.revision} while approval was pending. Read the latest workflow and propose again.`,
    };
  try {
    const before = structuredClone(workflow);
    commandQueuePending += 1;
    updateCanvasViewControls();
    const queued = commandQueue
      .catch(() => {})
      .then(async () => {
        if (hasActiveWorkflowRun())
          throw new Error("A workflow run started before the proposal was applied.");
        if (activeNodeMetaCatalogRevision !== request.expectedCatalogRevision)
          throw new Error(
            "The node catalog changed before the proposal could be applied. Search or read the current catalog and retry.",
          );
        if (activeRecord.workflow.revision !== request.baseRevision)
          throw new Error(
            "Workflow changed before the proposal could be applied. Read the latest workflow and propose again.",
          );
        const result = await workflowService.apply({
          workflowId: workflow.id,
          workspaceId: workflow.workspaceId,
          baseRevision: workflow.revision,
          actor: "agent",
          expectedCatalogRevision: request.expectedCatalogRevision,
          command: { type: "apply_batch", operations, idempotencyKey: randomId() },
          applyCommand: (draft, command) => applyWorkflowCommand(draft, command, activeNodeMetas),
        });
        workflowHistory.record(before, result.workflow);
        activeRecord = {
          workflow: result.workflow,
          events: [...activeRecord.events, result.event],
        };
        canvas?.update(canvasProps());
        updateWorkflowHeader();
        renderWorkflowDetails();
        updateCanvasViewControls();
        showSaveStatus(t("workflow.saved"));
        return { ok: true, revision: result.workflow.revision, workflow: workflowContextSummary() };
      });
    commandQueue = queued
      .finally(() => {
        commandQueuePending = Math.max(0, commandQueuePending - 1);
        updateCanvasViewControls();
      })
      .catch(() => {});
    return await queued;
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function syncLatestWorkflow() {
  commandQueue = commandQueue
    .catch(() => {})
    .then(async () => {
      if (!activeRecord || !workflowService) return;
      const latest = await workflowService.load(
        activeRecord.workflow.id,
        activeRecord.workflow.workspaceId,
      );
      if (!latest) throw new Error(t("workflow.loadError"));
      activeRecord = latest;
      workflowHistory.clear();
      document.getElementById("workflow-sync-latest")?.classList.add("hidden");
      updateWorkflowHeader();
      canvas?.update(canvasProps());
      renderWorkflowDetails();
      updateCanvasViewControls();
      showSaveStatus(t("workflow.synced"));
    })
    .catch((error) => showSaveStatus(workflowErrorMessage(error), true));
  return commandQueue;
}

function updateWorkflowHeader() {
  const workflow = activeRecord.workflow;
  const title = document.getElementById("workflow-panel-title");
  const revision = document.getElementById("workflow-revision");
  title.textContent = displayWorkflowName(workflow.name, t);
  const incomplete = validateWorkflow(workflow, activeNodeMetas, {
    requireComplete: true,
  }).length;
  revision.textContent = `${t("workflow.revision", { revision: workflow.revision, nodes: workflow.nodes.length, edges: workflow.edges.length })}${incomplete ? ` · ${t("workflow.issues", { count: incomplete })}` : ""}`;
  revision.classList.toggle("is-invalid", incomplete > 0);
}

function renderWorkflowDetails() {
  const inspector = document.getElementById("workflow-inspector");
  if (!inspector || !activeRecord) return;
  inspector.replaceChildren();
  if (viewMode === "pi-subtasks") {
    renderPiSubtaskDetails(inspector);
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
  for (const port of meta.inputs) {
    const missing = missingInputs.has(port.name);
    const label = document.createElement("label");
    label.className = "workflow-inspector__field";
    const caption = document.createElement("span");
    caption.textContent = `${port.label}${port.required ? " *" : ""}`;
    label.append(caption);
    const connected = activeRecord.workflow.edges.some(
      (edge) => edge.targetNodeId === node.instanceId && edge.targetPort === port.name,
    );
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

function appendRequiredParamError(field, label) {
  return appendInspectorFieldError(field, t("workflow.requiredParamMissing", { label }));
}

function appendInspectorFieldError(field, message) {
  const error = createInspectorError(message);
  error.id = `workflow-required-${randomId()}`;
  field.append(error);
  return error.id;
}

function renderPiSubtaskDetails(inspector) {
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
  selectedObservedNodeId = selected.id;
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

function applyRunReadOnlyState() {
  const readOnly = hasActiveWorkflowRun();
  updateCanvasViewControls();
  document.getElementById("workflow-panel")?.classList.toggle("is-run-active", readOnly);
}

function showSaveStatus(message, isError = false) {
  const status = document.getElementById("workflow-save-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

function closeWorkflowPanel() {
  workflowPanelGeneration += 1;
  cancelWorkflowRun();
  cancelWorkflowRun = () => {};
  refreshWorkflowRun = async () => {};
  const closingTarget = getWorkflowTarget();
  const closingWorkspaceId = currentWorkspaceId;
  getWorkflowTarget = () => closingTarget;
  currentWorkspaceId = closingWorkspaceId;
  document.getElementById("workflow-panel")?.classList.add("hidden");
  workflowModeTargetSynchronizer
    .close()
    .catch((error) => console.warn("[Workflow] Could not disable Pi workflow tools:", error));
  canvas?.unmount();
  canvas = null;
  activeRecord = null;
  activeRun = null;
  workflowHistory.clear();
  workflowRuntime = null;
  getCurrentModel = () => null;
  workflowTargetForRun = null;
  isPiSessionBusy = () => false;
  approveWorkflowProposal = async () => false;
  cancelWorkflowRun = () => {};
  selectedNodeId = null;
  document.getElementById("workflow-mode-toggle")?.setAttribute("aria-expanded", "false");
}

document.getElementById("workflow-close")?.addEventListener("click", () => {
  if (standaloneWorkflowWindow) {
    globalThis.__TAURI__?.core
      ?.invoke?.("close_workflow_window")
      .catch((error) => showSaveStatus(workflowErrorMessage(error), true));
    return;
  }
  closeWorkflowPanel();
});
