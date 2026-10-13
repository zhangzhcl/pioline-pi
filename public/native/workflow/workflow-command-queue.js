// 工作流面板：命令串行队列、撤销/重做历史恢复、自动布局、快捷键绑定与快照同步。

import { t } from "../../i18n.js";
import { randomId } from "../utils/random-id.js";
import { applyWorkflowCommand } from "./workflow-commands.js";
import { workflowErrorMessage } from "./workflow-error-message.js";
import { loadWorkflowRevisionIfCurrent } from "./workflow-host-events.js";
import { layoutWorkflowNodes } from "./workflow-layout.js";

export function createWorkflowCommandQueueController({
  workflowHistory,
  getState,
  setActiveRecord,
  hasActiveWorkflowRun,
  onAfterWorkflowChanged,
  updateCanvasViewControls,
  updateCanvasOnly,
  showSaveStatus,
  workflowContextSummary,
}) {
  let commandQueue = Promise.resolve();
  let commandQueuePending = 0;

  function enqueue(operation) {
    commandQueue = commandQueue.catch(() => {}).then(operation);
    return commandQueue;
  }

  function waitForPendingWrites() {
    return commandQueue.catch(() => {});
  }

  function getPendingCount() {
    return commandQueuePending;
  }

  function commandQueueSettled() {
    return commandQueuePending === 0;
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
        const { activeRecord, workflowService, activeNodeMetas } = getState();
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
        setActiveRecord({
          workflow: result.workflow,
          events: [...activeRecord.events, result.event],
        });
        onAfterWorkflowChanged();
        showSaveStatus(t("workflow.saved"));
      })
      .catch((error) => {
        showSaveStatus(workflowErrorMessage(error), true);
        document.getElementById("workflow-sync-latest")?.classList.remove("hidden");
        updateCanvasOnly();
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
        const { activeRecord, workflowService } = getState();
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
        setActiveRecord({
          workflow: result.workflow,
          events: [...activeRecord.events, result.event],
        });
        if (direction === "undo") workflowHistory.commitUndo(historyEntry);
        else workflowHistory.commitRedo(historyEntry);
        onAfterWorkflowChanged();
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
    const { activeRecord, viewMode } = getState();
    if (
      !activeRecord ||
      hasActiveWorkflowRun() ||
      viewMode !== "workflow" ||
      !commandQueueSettled()
    )
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
    const { activeRecord, viewMode } = getState();
    if (
      !activeRecord ||
      hasActiveWorkflowRun() ||
      viewMode !== "workflow" ||
      !commandQueueSettled()
    )
      return;
    const prepared = workflowHistory.prepareRedo(activeRecord.workflow);
    if (!prepared) {
      workflowHistory.clear();
      updateCanvasViewControls();
      return;
    }
    restoreWorkflowSnapshot(prepared.target, prepared.entry, "redo");
  }

  function autoLayoutWorkflow() {
    const { activeRecord, viewMode } = getState();
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

  function addWorkflowNode(metaKey, position) {
    const { activeRecord, activeNodeMetas } = getState();
    const meta = activeNodeMetas.get(metaKey);
    if (!meta) return;
    const offset = activeRecord.workflow.nodes.length * 36;
    submitCommand({
      type: "add_node",
      node: {
        instanceId: randomId(),
        meta: { id: meta.id, version: meta.version },
        position: position ?? { x: 220 + offset, y: 280 + offset },
        paramValues: Object.fromEntries(
          meta.params
            .filter((param) => param.defaultValue !== undefined)
            .map((param) => [param.name, structuredClone(param.defaultValue)]),
        ),
        portValues: {},
      },
    });
  }

  async function loadRemoteWorkflowRevision(expectedRevision) {
    const { workflowService } = getState();
    if (!workflowService) return false;
    return loadWorkflowRevisionIfCurrent({
      getState: () => {
        const state = getState();
        return { workspaceId: state.currentWorkspaceId, activeRecord: state.activeRecord };
      },
      expectedRevision,
      loadWorkflow: (workflowId, workspaceId) => workflowService.load(workflowId, workspaceId),
      applyWorkflow: (latest) => {
        workflowHistory.clear();
        setActiveRecord(latest);
        document.getElementById("workflow-sync-latest")?.classList.add("hidden");
        onAfterWorkflowChanged();
        showSaveStatus(t("workflow.synced"));
      },
    });
  }

  function syncLatestWorkflow() {
    commandQueue = commandQueue
      .catch(() => {})
      .then(async () => {
        const { activeRecord, workflowService } = getState();
        if (!activeRecord || !workflowService) return;
        const latest = await workflowService.load(
          activeRecord.workflow.id,
          activeRecord.workflow.workspaceId,
        );
        if (!latest) throw new Error(t("workflow.loadError"));
        setActiveRecord(latest);
        workflowHistory.clear();
        document.getElementById("workflow-sync-latest")?.classList.add("hidden");
        onAfterWorkflowChanged();
        showSaveStatus(t("workflow.synced"));
      })
      .catch((error) => showSaveStatus(workflowErrorMessage(error), true));
    return commandQueue;
  }

  async function enqueueAgentProposalApply({
    workflow,
    baseRevision,
    expectedCatalogRevision,
    operations,
  }) {
    try {
      const before = structuredClone(workflow);
      commandQueuePending += 1;
      updateCanvasViewControls();
      const queued = commandQueue
        .catch(() => {})
        .then(async () => {
          const state = getState();
          if (hasActiveWorkflowRun())
            throw new Error("A workflow run started before the proposal was applied.");
          if (state.activeNodeMetaCatalogRevision !== expectedCatalogRevision) {
            throw new Error(
              "The node catalog changed before the proposal could be applied. Search or read the current catalog and retry.",
            );
          }
          if (state.activeRecord.workflow.revision !== baseRevision) {
            throw new Error(
              "Workflow changed before the proposal could be applied. Read the latest workflow and propose again.",
            );
          }
          const result = await state.workflowService.apply({
            workflowId: workflow.id,
            workspaceId: workflow.workspaceId,
            baseRevision: workflow.revision,
            actor: "agent",
            expectedCatalogRevision,
            command: { type: "apply_batch", operations, idempotencyKey: randomId() },
            applyCommand: (draft, command) =>
              applyWorkflowCommand(draft, command, state.activeNodeMetas),
          });
          workflowHistory.record(before, result.workflow);
          setActiveRecord({
            workflow: result.workflow,
            events: [...state.activeRecord.events, result.event],
          });
          onAfterWorkflowChanged();
          showSaveStatus(t("workflow.saved"));
          return {
            ok: true,
            revision: result.workflow.revision,
            workflow: workflowContextSummary(),
          };
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

  function bindKeyboardShortcuts() {
    document.addEventListener("keydown", (event) => {
      if (document.getElementById("workflow-panel")?.classList.contains("hidden")) return;
      if (event.altKey || event.metaKey || !(event.ctrlKey && event.key.toLowerCase() === "z"))
        return;
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
      if (event.altKey || event.metaKey || !(event.ctrlKey && event.key.toLowerCase() === "y"))
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      event.preventDefault();
      redoWorkflow();
    });
  }

  return {
    enqueue,
    waitForPendingWrites,
    getPendingCount,
    submitCommand,
    undoWorkflow,
    redoWorkflow,
    autoLayoutWorkflow,
    addWorkflowNode,
    loadRemoteWorkflowRevision,
    syncLatestWorkflow,
    enqueueAgentProposalApply,
    bindKeyboardShortcuts,
  };
}
