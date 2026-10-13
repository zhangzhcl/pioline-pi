// ABOUTME: Creates the workflow run input, start/cancel controls, and run log view.

import { onLocaleChange, t } from "../../i18n.js";
import { randomId } from "../utils/random-id.js";
import { workflowErrorMessage } from "./workflow-error-message.js";
import {
  createRunControlsDom,
  formatRunEventsLog,
  populateRetryTargetOptions,
  reconcilePersistenceFailure as reconcilePersistenceFailureWithControl,
  updateRunControlsLocalizedLabels,
} from "./workflow-run-controls-dom.js";
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
  const dom = createRunControlsDom();
  const {
    section,
    input,
    start,
    concurrency,
    cancel,
    status,
    history,
    historyPlaceholder,
    refreshHistoryButton,
    rerun,
    retryTarget,
    retryPlaceholder,
    retry,
    log,
    concurrencyMenu,
    historyMenu,
  } = dom;
  let rerunSource = null;
  let observedRunActive = false;
  let executingRunId = null;
  let historyLoadGeneration = 0;
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
    return reconcilePersistenceFailureWithControl(control, run, persistenceError);
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
    const initialRetrySource =
      run.workflowId === workflow().id &&
      run.workspaceId === workflow().workspaceId &&
      run.snapshot &&
      typeof run.snapshot === "object" &&
      new Set(["error", "cancelled", "interrupted"]).has(run.status)
        ? structuredClone(run)
        : null;
    retrySource = populateRetryTargetOptions(
      retryTarget,
      retryPlaceholder,
      initialRetrySource,
      nodeMetas,
    );
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
    log.textContent = formatRunEventsLog(events);
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

  const unsubscribeLocaleChange = onLocaleChange(() => {
    updateRunControlsLocalizedLabels(dom);
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
    if (controller && runId && executingRunId === runId) return;
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
          log.append(
            `${event.timestamp}  ${event.type}${event.nodeId ? ` · ${event.nodeId}` : ""}${event.error ? ` · ${workflowErrorMessage(event.error)}` : ""}\n`,
          );
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
  section.destroy = () => {
    unsubscribeLocaleChange?.();
    concurrencyMenu?.destroy?.();
    historyMenu?.destroy?.();
  };
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
