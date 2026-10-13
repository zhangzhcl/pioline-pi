// ABOUTME: DOM construction, localization, and persistence-reconciliation helpers for workflow run controls.

import { t } from "../../i18n.js";
import { enhanceSelect } from "../../ui/select-menu.js";
import { nodeMetaKey } from "./builtin-node-registry.js";
import { localizeNodeMeta } from "./node-meta-localization.js";
import { workflowErrorMessage } from "./workflow-error-message.js";

export function createRunControlsDom() {
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

  const concurrencyMenu = enhanceSelect(concurrency);
  const historyMenu = enhanceSelect(history);
  enhanceSelect(retryTarget);

  return {
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
  };
}

export function updateRunControlsLocalizedLabels(dom) {
  dom.input.setAttribute("aria-label", t("workflow.runInput"));
  dom.input.placeholder = t("workflow.runInputPlaceholder");
  dom.start.textContent = t("workflow.run");
  dom.concurrency.setAttribute("aria-label", t("workflow.maxConcurrency"));
  for (const option of dom.concurrency.options)
    option.textContent = `${t("workflow.maxConcurrency")}: ${option.value}`;
  dom.cancel.textContent = t("workflow.cancelRun");
  dom.history.setAttribute("aria-label", t("workflow.runHistory"));
  dom.historyPlaceholder.textContent = t("workflow.runHistory");
  dom.refreshHistoryButton.textContent = t("workflow.refreshRunHistory");
  dom.rerun.textContent = t("workflow.rerunSnapshot");
  dom.retryTarget.setAttribute("aria-label", t("workflow.retryFromNode"));
  dom.retryPlaceholder.textContent = t("workflow.retryFromNode");
  dom.retry.textContent = t("workflow.retryFromNode");
}

export async function reconcilePersistenceFailure(control, run, persistenceError) {
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

export function populateRetryTargetOptions(retryTarget, retryPlaceholder, retrySource, nodeMetas) {
  retryTarget.replaceChildren(retryPlaceholder);
  if (!retrySource) return null;
  for (const node of retrySource.snapshot.nodes) {
    const state = retrySource.nodeStates?.[node.instanceId];
    if (!new Set(["error", "interrupted"]).has(state?.status)) continue;
    const meta = localizeNodeMeta(nodeMetas?.get(nodeMetaKey(node.meta)));
    const option = document.createElement("option");
    option.value = node.instanceId;
    option.textContent = `${meta?.label ?? node.instanceId} · ${t(`workflow.runStatus.${state.status}`)}`;
    retryTarget.append(option);
  }
  if (!retryTarget.options.length || retryTarget.options.length === 1) return null;
  return retrySource;
}

export function formatRunEventsLog(events) {
  return events
    .map(
      (event) =>
        `${event.timestamp}  ${event.type}${event.nodeId ? ` · ${event.nodeId}` : ""}${event.error ? ` · ${workflowErrorMessage(event.error)}` : ""}${event.message ? ` · ${event.message}` : ""}`,
    )
    .join("\n");
}
