// ABOUTME: Lazily loaded workflow-mode shell. Ordinary Pi sessions never load
// this module, React, React Flow, or canvas styles.

import { onLocaleChange, t } from "../../i18n.js";
import { BUILTIN_NODE_METAS } from "./builtin-node-registry.js";
import { PiSubtaskObserver } from "./pi-subtask-observer.js";
import { executeAgentWorkflowRequest } from "./workflow-agent-requests.js";
import {
  buildWorkflowCanvasProps,
  buildWorkflowExecutors,
  buildWorkflowToolbar,
  createInitialNodeMetas,
  createWorkflowPanelRunControls,
  ensureWorkflowCanvasStyles,
  loadOrSeedActiveWorkflowRecord,
  populateCustomNodeMetas,
  renderWorkflowHeaderState,
  renderWorkflowSaveStatus,
  subscribePiSubtaskObserver,
  syncWorkflowCanvasViewControls,
} from "./workflow-canvas-toolbar.js";
import { createWorkflowCodeExecutor } from "./workflow-code-executor.js";
import { createWorkflowCommandQueueController } from "./workflow-command-queue.js";
import { buildWorkflowContextSummary } from "./workflow-context-summary.js";
import { workflowErrorMessage } from "./workflow-error-message.js";
import { WorkflowHistory } from "./workflow-history.js";
import { createWorkflowHostEventHandler } from "./workflow-host-events.js";
import { renderWorkflowInspectorDetails } from "./workflow-inspector-panel.js";
import { createWorkflowModeTargetSynchronizer } from "./workflow-mode-target.js";
import { createWorkflowNodeCatalogLoader } from "./workflow-node-catalog-loader.js";
import { createHostWorkflowRepository, WorkflowService } from "./workflow-service.js";
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
let destroyWorkflowRunControls = () => {};
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

function hasActiveWorkflowRun() {
  return ["queued", "running"].includes(activeRun?.status);
}

function workflowContextSummary(options = {}) {
  return buildWorkflowContextSummary({
    activeRecord,
    activeNodeMetas,
    activeNodeMetaCatalogRevision,
    ...options,
  });
}

function onAfterWorkflowChanged() {
  updateWorkflowHeader();
  canvas?.update(canvasProps());
  renderWorkflowDetails();
  updateCanvasViewControls();
}

function syncLoadedRevision() {
  workflowHistory.clear();
  document.getElementById("workflow-sync-latest")?.classList.add("hidden");
  onAfterWorkflowChanged();
}

const commandQueueController = createWorkflowCommandQueueController({
  workflowHistory,
  getState: () => ({
    currentWorkspaceId,
    workflowService,
    activeNodeMetas,
    activeNodeMetaCatalogRevision,
    activeRecord,
    viewMode,
  }),
  setActiveRecord: (nextRecord) => {
    activeRecord = nextRecord;
  },
  hasActiveWorkflowRun,
  onAfterWorkflowChanged,
  updateCanvasViewControls,
  updateCanvasOnly: () => canvas?.update(canvasProps()),
  showSaveStatus,
  workflowContextSummary,
});
commandQueueController.bindKeyboardShortcuts();

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
  enqueue: (operation) => commandQueueController.enqueue(operation),
  reloadNodeMetaRegistry,
  loadRemoteWorkflowRevision: (expectedRevision) =>
    commandQueueController.loadRemoteWorkflowRevision(expectedRevision),
  refreshWorkflowRun: (...args) => refreshWorkflowRun(...args),
  onError: (error) => showSaveStatus(workflowErrorMessage(error), true),
});
window.addEventListener("pipline:workflow-host-event", handleWorkflowHostEvent);

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

  if (!panel.classList.contains("hidden")) {
    const sameWorkspace = currentWorkspaceId === workspaceId;
    closeWorkflowPanel();
    if (sameWorkspace) return;
  }
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
  activeNodeMetas = createInitialNodeMetas(templateCatalog.templates);
  activeNodeMetaCatalogRevision = templateCatalog.catalogRevision;
  workflowService = new WorkflowService(createHostWorkflowRepository(control), {
    nodeMetas: activeNodeMetas,
  });
  workflowRuntime = runtime;
  if (!unsubscribePiObserver) {
    unsubscribePiObserver = subscribePiSubtaskObserver({
      runtime,
      getWorkspaceId: () => currentWorkspaceId,
      getWorkflowTarget: () => getWorkflowTarget(),
      subtaskObserver,
      onConsumed: () => {
        updateCanvasViewControls();
        canvas?.update(canvasProps());
        if (viewMode === "pi-subtasks") renderWorkflowDetails();
      },
    });
  }
  getWorkflowTarget = getTarget ?? (() => null);
  isPiSessionBusy = getPiBusy ?? (() => false);
  getCurrentModel = getModel ?? (() => null);
  setPiRunning = onPiRunningChange ?? (() => {});
  setWorkflowToolsEnabled = setAgentToolsEnabled ?? (async () => {});
  approveWorkflowProposal = requestAgentApproval ?? (async () => false);
  activeRecord = await loadOrSeedActiveWorkflowRecord({
    workflowService,
    preferences,
    workspaceId,
    requestedWorkflowId,
    activeNodeMetas,
    workflowHistory,
  });
  await showCanvas();
  if (!standalone) await workflowModeTargetSynchronizer.sync();
}

export function syncWorkflowModeTarget() {
  return workflowModeTargetSynchronizer.sync();
}

async function showCanvas() {
  destroyWorkflowRunControls();
  destroyWorkflowRunControls = () => {};
  const body = document.getElementById("workflow-panel-body");
  body.replaceChildren();
  const toolbar = buildWorkflowToolbar({
    hasObservedSubtasks: subtaskObserver.snapshot().nodes.length > 0,
    onSelectViewMode: setViewMode,
    onAutoLayout: () => commandQueueController.autoLayoutWorkflow(),
    onUndo: () => commandQueueController.undoWorkflow(),
    onRedo: () => commandQueueController.redoWorkflow(),
    onSendContext: sendWorkflowContext,
    onSyncLatest: () => commandQueueController.syncLatestWorkflow(),
  });
  const stage = document.createElement("div");
  stage.className = "workflow-canvas";
  stage.id = "workflow-canvas";
  const inspector = document.createElement("section");
  inspector.className = "workflow-inspector";
  inspector.id = "workflow-inspector";
  const workflowExecutors = buildWorkflowExecutors({
    workflowRuntime,
    getTarget: () => workflowTargetForRun ?? getWorkflowTarget(),
    getCurrentModel,
    workflowCodeExecutor,
    activeNodeMetas,
  });
  const runControls = createWorkflowPanelRunControls({
    getActiveRecord: () => activeRecord,
    workflowService,
    workflowControl,
    activeNodeMetas,
    workflowExecutors,
    isPiSessionBusy,
    setPiRunning,
    onBeginRunFlight: () => {
      workflowTargetForRun = getWorkflowTarget();
      workflowRunInFlight = true;
      workflowRunSettled = new Promise((resolve) => {
        resolveWorkflowRunSettled = resolve;
      });
    },
    onEndRunFlight: () => {
      workflowTargetForRun = null;
      workflowRunInFlight = false;
      resolveWorkflowRunSettled?.();
      resolveWorkflowRunSettled = null;
      workflowRunSettled = Promise.resolve();
    },
    isRunInFlight: () => workflowRunInFlight,
    onSyncLoadedRevision: (latest) => {
      activeRecord = latest;
      syncLoadedRevision();
    },
    onActiveRunUpdated: (run) => {
      activeRun = run;
      applyRunReadOnlyState();
      canvas?.update(canvasProps());
      renderWorkflowDetails();
    },
  });
  refreshWorkflowRun = runControls.refreshRemoteRun ?? (async () => {});
  cancelWorkflowRun = () => runControls.cancelRun?.();
  destroyWorkflowRunControls = () => runControls.destroy?.();
  body.append(toolbar, stage, inspector, runControls);

  await ensureWorkflowCanvasStyles();
  const { mountWorkflowCanvas } = await import("../../vendor/workflow-canvas.js");
  canvas = mountWorkflowCanvas(stage, canvasProps());
  renderWorkflowDetails();
  updateWorkflowHeader();
}

function canvasProps() {
  return buildWorkflowCanvasProps({
    activeRecord,
    activeNodeMetas,
    activeRun,
    viewMode,
    subtaskObserver,
    hasActiveWorkflowRun,
    commandQueueController,
    onSelectNode: (instanceId) => {
      if (viewMode === "pi-subtasks") selectedObservedNodeId = instanceId;
      else selectedNodeId = instanceId;
      renderWorkflowDetails();
    },
  });
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
  syncWorkflowCanvasViewControls({
    viewMode,
    hasObservedSubtasks: subtaskObserver.snapshot().nodes.length > 0,
    hasActiveRun: hasActiveWorkflowRun(),
    pendingCount: commandQueueController?.getPendingCount?.() ?? 0,
    canUndo: workflowHistory.canUndo(),
    canRedo: workflowHistory.canRedo(),
    hasNodes: Boolean(activeRecord?.workflow.nodes.length),
  });
}

async function reloadNodeMetaRegistry() {
  const templateCatalog = await loadWorkflowNodeCatalog();
  populateCustomNodeMetas(activeNodeMetas, templateCatalog.templates);
  activeNodeMetaCatalogRevision = templateCatalog.catalogRevision;
  canvas?.update(canvasProps());
  updateWorkflowHeader();
}

function sendWorkflowContext() {
  const summary = workflowContextSummary();
  window.dispatchEvent(
    new CustomEvent("pipline:workflow-context-request", {
      detail: { summary, workspaceId: currentWorkspaceId },
    }),
  );
}

export async function handleAgentWorkflowRequest(request, { dismissSignal } = {}) {
  return executeAgentWorkflowRequest(request, {
    dismissSignal,
    getState: () => ({
      currentWorkspaceId,
      workflowService,
      workflowControl,
      activeRecord,
      activeNodeMetas,
      activeNodeMetaCatalogRevision,
      activeRun,
      workflowPanelGeneration,
    }),
    setActiveRecord: (nextRecord) => {
      activeRecord = nextRecord;
    },
    setCatalogRevision: (nextRevision) => {
      activeNodeMetaCatalogRevision = nextRevision;
    },
    reloadNodeMetaRegistry,
    waitForPendingWrites: () => commandQueueController.waitForPendingWrites(),
    hasActiveWorkflowRun,
    approveWorkflowProposal,
    onRevisionSynced: syncLoadedRevision,
    onNodeMetaSaved: () => {
      canvas?.update(canvasProps());
      renderWorkflowDetails();
      showSaveStatus(t("workflow.nodeMetaSaved"));
    },
    enqueueProposalApply: (params) => commandQueueController.enqueueAgentProposalApply(params),
  });
}

function updateWorkflowHeader() {
  renderWorkflowHeaderState(activeRecord?.workflow, activeNodeMetas);
}
function showSaveStatus(message, isError = false) {
  renderWorkflowSaveStatus(message, isError);
}
function renderWorkflowDetails() {
  renderWorkflowInspectorDetails({
    inspector: document.getElementById("workflow-inspector"),
    activeRecord,
    activeNodeMetas,
    activeRun,
    viewMode,
    selectedNodeId,
    selectedObservedNodeId,
    onSelectObservedNodeId: (nextId) => {
      selectedObservedNodeId = nextId;
    },
    subtaskObserver,
    submitCommand: (command) => commandQueueController.submitCommand(command),
    showSaveStatus,
  });
}
function applyRunReadOnlyState() {
  updateCanvasViewControls();
  document
    .getElementById("workflow-panel")
    ?.classList.toggle("is-run-active", hasActiveWorkflowRun());
}

function closeWorkflowPanel() {
  workflowPanelGeneration += 1;
  cancelWorkflowRun();
  cancelWorkflowRun = () => {};
  destroyWorkflowRunControls();
  destroyWorkflowRunControls = () => {};
  refreshWorkflowRun = async () => {};
  const closingTarget = getWorkflowTarget();
  getWorkflowTarget = () => closingTarget;
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
