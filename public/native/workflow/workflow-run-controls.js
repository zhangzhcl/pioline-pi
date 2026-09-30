// ABOUTME: Creates the workflow run input, start/cancel controls, and run log view.

import { onLocaleChange, t } from "../../i18n.js";
import { enhanceSelect } from "../../ui/select-menu.js";
import { randomId } from "../utils/random-id.js";
import { nodeMetaKey } from "./builtin-node-registry.js";
import { localizeNodeMeta } from "./node-meta-localization.js";
import { workflowErrorMessage } from "./workflow-error-message.js";
import {
  createWorkflowRetryRun,
  createWorkflowRun,
  missingWorkflowExecutors,
  WorkflowRunner,
} from "./workflow-runner.js";

const WORKFLOW_SNAPSHOT_CONFLICTS = new Set([
  "Workflow changed after this Run snapshot was prepared",
  "Run snapshot does not match the saved workflow revision",
]);

export function createWorkflowRunControls({
  workflow,
  control,
  executors = new Map(),
  nodeMetas,
  onRunChange,
  onRunStart,
  onRunEnd,
  onWorkflowSnapshotConflict,
}) {
  const section = document.createElement("section");
  section.className = "workflow-run-controls";
  const input = document.createElement("textarea");
  input.className = "workflow-run-controls__input";
  input.setAttribute("aria-label", t("workflow.runInput"));
  input.placeholder = t("workflow.runInputPlaceholder");
  const actions = document.createElement("div");
  actions.className = "workflow-run-controls__actions";
  const start = document.createElement("button");
  start.type = "button";
  start.className = "ui-button ui-button--sm ui-button--primary";
  start.textContent = t("workflow.run");
  const concurrency = document.createElement("select");
  concurrency.className = "ui-select workflow-run-controls__concurrency";
  concurrency.setAttribute("aria-label", t("workflow.maxConcurrency"));
  for (const value of [1, 2, 3, 4]) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = `${t("workflow.maxConcurrency")}: ${value}`;
    concurrency.append(option);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ui-button ui-button--sm ui-button--danger";
  cancel.textContent = t("workflow.cancelRun");
  cancel.disabled = true;
  const status = document.createElement("span");
  status.className = "workflow-run-controls__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const history = document.createElement("select");
  history.className = "ui-select workflow-run-controls__history";
  history.setAttribute("aria-label", t("workflow.runHistory"));
  const historyPlaceholder = document.createElement("option");
  historyPlaceholder.value = "";
  historyPlaceholder.textContent = t("workflow.runHistory");
  history.append(historyPlaceholder);
  const refreshHistoryButton = document.createElement("button");
  refreshHistoryButton.type = "button";
  refreshHistoryButton.className = "ui-button ui-button--sm ui-button--ghost";
  refreshHistoryButton.textContent = t("workflow.refreshRunHistory");
  const rerun = document.createElement("button");
  rerun.type = "button";
  rerun.className = "ui-button ui-button--sm ui-button--secondary";
  rerun.textContent = t("workflow.rerunSnapshot");
  rerun.disabled = true;
  let rerunSource = null;
  let observedRunActive = false;
  let executingRunId = null;
  let historyLoadGeneration = 0;
  const retryTarget = document.createElement("select");
  retryTarget.className = "ui-select workflow-run-controls__retry-target";
  retryTarget.setAttribute("aria-label", t("workflow.retryFromNode"));
  const retryPlaceholder = document.createElement("option");
  retryPlaceholder.value = "";
  retryPlaceholder.textContent = t("workflow.retryFromNode");
  retryTarget.append(retryPlaceholder);
  retryTarget.disabled = true;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ui-button ui-button--sm ui-button--secondary";
  retry.textContent = t("workflow.retryFromNode");
  retry.disabled = true;
  let retrySource = null;
  let controller = null;
  let cancelRequested = false;
  const requestCancel = () => {
    if (controller) {
      if (controller.signal.aborted || !observedRunActive) return;
      cancel.disabled = true;
      controller.abort();
    } else if (executingRunId) cancelRequested = true;
  };
  const notifyRunChange = (run) => {
    observedRunActive = ["queued", "running"].includes(run?.status);
    cancel.disabled =
      !controller || controller.signal.aborted || !["queued", "running"].includes(run?.status);
    if (!controller) start.disabled = observedRunActive;
    history.disabled = observedRunActive || Boolean(controller);
    rerun.disabled = !rerunSource || observedRunActive || Boolean(controller);
    retryTarget.disabled = !retrySource || observedRunActive || Boolean(controller);
    retry.disabled = !retrySource || !retryTarget.value || observedRunActive || Boolean(controller);
    try {
      onRunChange?.(run);
    } catch (error) {
      console.error("[Workflow] Run view update failed:", error);
    }
  };
  function clearRunDetails(message = "") {
    rerunSource = null;
    retrySource = null;
    retryTarget.replaceChildren(retryPlaceholder);
    retryTarget.disabled = true;
    retry.disabled = true;
    rerun.disabled = true;
    status.textContent = message;
    input.value = "";
    log.textContent = "";
    notifyRunChange(null);
  }
  const log = document.createElement("pre");
  log.className = "workflow-run-controls__log";
  actions.append(
    start,
    cancel,
    status,
    concurrency,
    history,
    refreshHistoryButton,
    rerun,
    retryTarget,
    retry,
  );
  section.append(input, actions, log);
  // Native <select> popups are OS-drawn on Windows and ignore theme tokens, so
  // the option lists render as light blocks in dark themes. Enhanced here
  // while the section is still detached; the menus attach once the canvas
  // mounts this section, and programmatic value writes below call sync().
  const concurrencyMenu = enhanceSelect(concurrency);
  const historyMenu = enhanceSelect(history);
  enhanceSelect(retryTarget);

  async function refreshHistory() {
    const selected = history.value;
    const runs = await control?.listWorkflowRuns(workflow().id, workflow().workspaceId);
    history.replaceChildren(historyPlaceholder);
    for (const item of runs ?? []) {
      const option = document.createElement("option");
      option.value = item.id;
      const statusLabel = t(`workflow.runStatus.${item.status}`);
      option.textContent = `${statusLabel} · r${item.workflowRevision} · ${item.updatedAt}`;
      history.append(option);
    }
    if (runs?.some((item) => item.id === selected)) {
      history.value = selected;
      historyMenu?.sync();
    }
    return runs ?? [];
  }

  async function refreshHistorySelection(runId) {
    try {
      const runs = await refreshHistory();
      if (runs.some((item) => item.id === runId)) {
        history.value = runId;
        historyMenu?.sync();
      }
    } catch (error) {
      console.warn("[Workflow] Could not refresh run history after persistence recovery", error);
    }
  }

  async function reconcilePersistenceFailure(run, persistenceError) {
    const workspaceId = run.workspaceId;
    const error = "Run event persistence failed; the durable outcome may be incomplete.";
    try {
      let record = await control?.loadWorkflowRun(run.id, workspaceId);
      if (!record?.run) return null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const latest = record.run;
        const events = Array.isArray(record.events) ? record.events : [];
        if (!["queued", "running"].includes(latest.status)) return { ...latest, events };

        const interrupted = structuredClone(latest);
        interrupted.status = "interrupted";
        interrupted.error = error;
        interrupted.result = null;
        interrupted.updatedAt = new Date().toISOString();
        const skippedNodeIds = [];
        for (const [nodeId, state] of Object.entries(interrupted.nodeStates ?? {})) {
          if (state.status === "running") {
            state.status = "interrupted";
            state.error = error;
          } else if (state.status === "idle") {
            state.status = "skipped";
            skippedNodeIds.push(nodeId);
          }
        }
        const sequence = events.length + 1;
        const event = {
          id: `${run.id}:${sequence}`,
          runId: run.id,
          workflowId: interrupted.workflowId,
          revision: interrupted.workflowRevision,
          type: "run_interrupted",
          timestamp: interrupted.updatedAt,
          sequence,
          error,
          skippedNodeIds,
        };
        const saved = await control.appendWorkflowRunEvent({
          runId: run.id,
          workspaceId,
          expectedSequence: sequence - 1,
          run: interrupted,
          event,
        });
        if (saved) return { ...interrupted, events: [...events, event] };
        if (attempt === 0) {
          record = await control.loadWorkflowRun(run.id, workspaceId);
          if (!record?.run) return null;
        } else {
          console.warn("[Workflow] Host rejected interrupted-run reconciliation", {
            runId: run.id,
            sequence,
            persistenceError,
          });
          return { ...latest, error, events, persistenceUncertain: true };
        }
      }
      return null;
    } catch (error) {
      console.warn("[Workflow] Could not reconcile interrupted run", {
        runId: run.id,
        persistenceError,
        error,
      });
      return null;
    }
  }

  async function loadRun(runId) {
    const generation = ++historyLoadGeneration;
    if (!runId) {
      clearRunDetails();
      return;
    }
    const requestedWorkflow = workflow();
    let record;
    try {
      record = await control?.loadWorkflowRun(runId, requestedWorkflow.workspaceId);
    } catch (error) {
      if (generation !== historyLoadGeneration) return;
      const currentWorkflow = workflow();
      if (
        currentWorkflow.id !== requestedWorkflow.id ||
        currentWorkflow.workspaceId !== requestedWorkflow.workspaceId
      )
        return;
      clearRunDetails(workflowErrorMessage(error));
      return;
    }
    if (generation !== historyLoadGeneration) return;
    const currentWorkflow = workflow();
    if (
      currentWorkflow.id !== requestedWorkflow.id ||
      currentWorkflow.workspaceId !== requestedWorkflow.workspaceId
    )
      return;
    const run = record?.run;
    if (
      !run ||
      run.id !== runId ||
      run.workflowId !== requestedWorkflow.id ||
      run.workspaceId !== requestedWorkflow.workspaceId
    ) {
      clearRunDetails(t("workflow.runLoadError"));
      return;
    }
    const events = Array.isArray(record.events) ? record.events : (run.events ?? []);
    run.events = events;
    rerunSource =
      run.workflowId === workflow().id &&
      run.workspaceId === workflow().workspaceId &&
      run.snapshot &&
      typeof run.snapshot === "object"
        ? {
            snapshot: structuredClone(run.snapshot),
            nodeMetaSnapshot: structuredClone(run.nodeMetaSnapshot ?? {}),
            input: structuredClone(run.input ?? {}),
            maxConcurrency: run.maxConcurrency ?? 1,
          }
        : null;
    rerun.disabled = !rerunSource || observedRunActive || Boolean(controller);
    retrySource =
      run.workflowId === workflow().id &&
      run.workspaceId === workflow().workspaceId &&
      run.snapshot &&
      typeof run.snapshot === "object" &&
      new Set(["error", "cancelled", "interrupted"]).has(run.status)
        ? structuredClone(run)
        : null;
    retryTarget.replaceChildren(retryPlaceholder);
    if (retrySource) {
      for (const node of retrySource.snapshot.nodes) {
        const state = retrySource.nodeStates?.[node.instanceId];
        if (!new Set(["error", "interrupted"]).has(state?.status)) continue;
        const meta = localizeNodeMeta(nodeMetas?.get(nodeMetaKey(node.meta)));
        const option = document.createElement("option");
        option.value = node.instanceId;
        option.textContent = `${meta?.label ?? node.instanceId} · ${t(`workflow.runStatus.${state.status}`)}`;
        retryTarget.append(option);
      }
      if (!retryTarget.options.length || retryTarget.options.length === 1) retrySource = null;
    }
    retryTarget.disabled = !retrySource || observedRunActive || Boolean(controller);
    retry.disabled = !retrySource || !retryTarget.value || observedRunActive || Boolean(controller);
    retryTarget.onchange = () => {
      retry.disabled =
        !retrySource || !retryTarget.value || observedRunActive || Boolean(controller);
    };
    if (Number.isSafeInteger(rerunSource?.maxConcurrency)) {
      concurrency.value = String(rerunSource.maxConcurrency);
      concurrencyMenu?.sync();
    }
    status.textContent = t(`workflow.runStatus.${run.status}`);
    input.value = JSON.stringify(run.input ?? {}, null, 2);
    log.textContent = events
      .map(
        (event) =>
          `${event.timestamp}  ${event.type}${event.nodeId ? ` · ${event.nodeId}` : ""}${event.error ? ` · ${workflowErrorMessage(event.error)}` : ""}${event.message ? ` · ${event.message}` : ""}`,
      )
      .join("\n");
    notifyRunChange(run);
  }

  async function refreshHistoryAndSelection() {
    const runs = await refreshHistory();
    const selected = runs.find((item) => item.id === history.value) ?? runs[0];
    if (selected) {
      history.value = selected.id;
      historyMenu?.sync();
      await loadRun(selected.id);
    }
  }

  function updateLocalizedLabels() {
    input.setAttribute("aria-label", t("workflow.runInput"));
    input.placeholder = t("workflow.runInputPlaceholder");
    start.textContent = t("workflow.run");
    concurrency.setAttribute("aria-label", t("workflow.maxConcurrency"));
    for (const option of concurrency.options)
      option.textContent = `${t("workflow.maxConcurrency")}: ${option.value}`;
    cancel.textContent = t("workflow.cancelRun");
    history.setAttribute("aria-label", t("workflow.runHistory"));
    historyPlaceholder.textContent = t("workflow.runHistory");
    refreshHistoryButton.textContent = t("workflow.refreshRunHistory");
    rerun.textContent = t("workflow.rerunSnapshot");
    retryTarget.setAttribute("aria-label", t("workflow.retryFromNode"));
    retryPlaceholder.textContent = t("workflow.retryFromNode");
    retry.textContent = t("workflow.retryFromNode");
  }

  onLocaleChange(() => {
    updateLocalizedLabels();
    refreshHistoryAndSelection().catch((error) => {
      status.textContent = workflowErrorMessage(error);
    });
  });

  history.addEventListener("change", () => loadRun(history.value));
  refreshHistoryButton.addEventListener("click", () => {
    refreshHistoryAndSelection().catch((error) => {
      status.textContent = workflowErrorMessage(error);
    });
  });

  section.refreshRemoteRun = async (runId) => {
    const runs = await refreshHistory();
    if (controller && executingRunId === runId) return;
    const candidate = runId
      ? runs.find((item) => item.id === runId)
      : runs.find((item) => ["queued", "running"].includes(item.status));
    if (!candidate) {
      if (!runId && !runs.some((item) => ["queued", "running"].includes(item.status))) {
        observedRunActive = false;
        if (!controller) start.disabled = false;
      }
      return;
    }
    if (controller && executingRunId === candidate.id) return;
    history.value = candidate.id;
    historyMenu?.sync();
    await loadRun(candidate.id);
  };

  async function executeRun(run) {
    if (controller || executingRunId) return;
    try {
      const missingExecutors = missingWorkflowExecutors(
        run.snapshot,
        nodeMetas,
        executors,
        run.nodeMetaSnapshot,
      );
      if (missingExecutors.length)
        throw new Error(t("workflow.executorUnavailable", { nodes: missingExecutors.join(", ") }));
      cancelRequested = false;
      executingRunId = run.id;
      await onRunStart?.(run);
      start.disabled = true;
      rerun.disabled = true;
      retry.disabled = true;
      retryTarget.disabled = true;
      concurrency.disabled = true;
      history.disabled = true;
      let created = false;
      let createError = null;
      try {
        created = Boolean(control && (await control.createWorkflowRun(run)));
      } catch (error) {
        createError = error;
      }
      if (!created) {
        const reconciled = await reconcilePersistenceFailure(run, createError);
        if (reconciled) {
          notifyRunChange(reconciled);
          await refreshHistorySelection(run.id);
          status.textContent =
            reconciled.status === "interrupted"
              ? workflowErrorMessage(reconciled.error)
              : t(`workflow.runStatus.${reconciled.status}`);
          return;
        }
        const runs = (await control?.listWorkflowRuns(workflow().id, workflow().workspaceId)) ?? [];
        const active = runs.find((item) => ["queued", "running"].includes(item.status));
        if (active) {
          await section.refreshRemoteRun(active.id);
          throw new Error(t("workflow.alreadyRunning"));
        }
        if (createError) throw createError;
        throw new Error(t("workflow.runCreateFailed"));
      }
      controller = new AbortController();
      if (cancelRequested) {
        cancel.disabled = true;
        controller.abort();
      }
      let persistQueue = Promise.resolve();
      let persistenceError = null;
      const runExecutors = new Map(executors);
      for (const [key, executor] of runExecutors) {
        if (run.nodeMetaSnapshot?.[key]?.execution?.kind !== "user-code") continue;
        runExecutors.set(key, async (context) => {
          await persistQueue;
          if (persistenceError) throw persistenceError;
          return executor(context);
        });
      }
      cancel.disabled = false;
      log.textContent = "";
      const result = await new WorkflowRunner({ executors: runExecutors, nodeMetas }).run(run, {
        signal: controller.signal,
        onEvent: (event, current) => {
          status.textContent = t(`workflow.runStatus.${current.status}`);
          log.textContent += `${event.timestamp}  ${event.type}${event.nodeId ? ` · ${event.nodeId}` : ""}${event.error ? ` · ${workflowErrorMessage(event.error)}` : ""}\n`;
          const sequence = current.events.length;
          const persistedRun = structuredClone(current);
          delete persistedRun.events;
          const persistedEvent = { ...event, sequence };
          persistQueue = persistQueue
            .then(async () => {
              const saved = await control.appendWorkflowRunEvent({
                runId: current.id,
                workspaceId: current.workspaceId,
                expectedSequence: sequence - 1,
                run: persistedRun,
                event: persistedEvent,
              });
              if (!saved) throw new Error(t("workflow.runSaveConflict"));
            })
            .catch((error) => {
              persistenceError ??= error;
              controller?.abort();
            });
          notifyRunChange(current);
        },
      });
      await persistQueue;
      if (persistenceError) {
        const localInterrupted = {
          ...result,
          status: "interrupted",
          result: null,
          error: "Run event persistence failed; the durable outcome may be incomplete.",
        };
        const interrupted =
          (await reconcilePersistenceFailure(run, persistenceError)) ?? localInterrupted;
        notifyRunChange(interrupted);
        await refreshHistorySelection(run.id);
        status.textContent =
          interrupted.persistenceUncertain || interrupted.status === "interrupted"
            ? workflowErrorMessage(interrupted.error)
            : t(`workflow.runStatus.${interrupted.status}`);
        return;
      }
      notifyRunChange(result);
      await refreshHistory();
    } catch (error) {
      if (onWorkflowSnapshotConflict && WORKFLOW_SNAPSHOT_CONFLICTS.has(error?.message)) {
        try {
          if (await onWorkflowSnapshotConflict(error)) {
            status.textContent = t("workflow.runSnapshotChanged");
            return;
          }
        } catch (refreshError) {
          status.textContent = workflowErrorMessage(refreshError);
          return;
        }
      }
      status.textContent = workflowErrorMessage(error);
    } finally {
      controller = null;
      executingRunId = null;
      start.disabled = observedRunActive;
      rerun.disabled = !rerunSource || observedRunActive;
      retryTarget.disabled = !retrySource || observedRunActive;
      retry.disabled = !retrySource || !retryTarget.value || observedRunActive;
      concurrency.disabled = false;
      cancel.disabled = true;
      history.disabled = false;
      await onRunEnd?.();
    }
  }

  section.refreshHistory = refreshHistory;

  start.addEventListener("click", async () => {
    let runInput;
    try {
      runInput = input.value.trim() ? JSON.parse(input.value) : {};
    } catch {
      status.textContent = t("workflow.invalidJson");
      return;
    }
    try {
      await executeRun(
        createWorkflowRun(workflow(), runInput, {
          id: randomId(),
          nodeMetas,
          maxConcurrency: Number(concurrency.value),
        }),
      );
    } catch (error) {
      status.textContent = workflowErrorMessage(error);
    }
  });

  rerun.addEventListener("click", async () => {
    if (!rerunSource || controller) return;
    try {
      const run = createWorkflowRun(rerunSource.snapshot, rerunSource.input, {
        id: randomId(),
        nodeMetas,
        maxConcurrency: rerunSource.maxConcurrency,
        nodeMetaSnapshot: rerunSource.nodeMetaSnapshot,
      });
      await executeRun(run);
    } catch (error) {
      status.textContent = workflowErrorMessage(error);
    }
  });
  retry.addEventListener("click", async () => {
    if (!retrySource || !retryTarget.value || controller) return;
    try {
      const run = createWorkflowRetryRun(retrySource, retryTarget.value, {
        id: randomId(),
        nodeMetas,
      });
      await executeRun(run);
    } catch (error) {
      status.textContent = workflowErrorMessage(error);
    }
  });
  cancel.addEventListener("click", requestCancel);
  section.cancelRun = requestCancel;
  section.initialize = async () => {
    const runs = await refreshHistory();
    const selected = runs.find((item) => ["queued", "running"].includes(item.status)) ?? runs[0];
    if (selected) {
      history.value = selected.id;
      historyMenu?.sync();
      await loadRun(selected.id);
    }
  };
  section.initialize().catch((error) => {
    console.warn("[Workflow] Could not restore active run:", error);
  });

  return section;
}
