import { showNativeDialog } from "../extensions/dialog.js";
import { randomId } from "../utils/random-id.js";
import { explicitlyRequestsWorkflow } from "./workflow-intent.js";

/**
 * 协调工作流模式面板懒加载、独立编辑器窗口打开、会话切换时目标同步，以及普通对话中的工作流意图自动开启。
 */
export function setupWorkflowModeController({
  button = document.getElementById("workflow-mode-toggle"),
  input,
  sendButton,
  control,
  preferences,
  runtime,
  getTarget,
  getPiBusy,
  getModel,
  t,
  showError,
}) {
  let workflowComposerDisabledState = null;
  let workflowModeOpening = null;

  async function openWorkflowMode() {
    if (!button) return;
    if (workflowModeOpening) return workflowModeOpening;
    button.disabled = true;
    const opening = (async () => {
      try {
        const target = getTarget();
        const existingPanel = document.getElementById("workflow-panel");
        if (!existingPanel || existingPanel.classList.contains("hidden")) {
          const { toggleWorkflowPanel } = await import("./workflow-panel.js");
          await toggleWorkflowPanel({
            control,
            preferences,
            workspaceId: target.workspaceId,
            runtime,
            getTarget,
            getPiBusy,
            getModel,
            onPiRunningChange: (running) => {
              if (running) {
                if (workflowComposerDisabledState) return;
                workflowComposerDisabledState = {
                  input: input.disabled,
                  sendButton: sendButton.disabled,
                };
                input.disabled = true;
                sendButton.disabled = true;
                return;
              }
              if (!workflowComposerDisabledState) return;
              input.disabled = workflowComposerDisabledState.input;
              sendButton.disabled = workflowComposerDisabledState.sendButton;
              workflowComposerDisabledState = null;
            },
            setAgentToolsEnabled: (enabled, modeTarget) =>
              runtime.request(
                { type: "prompt", message: `/pipline-workflow-mode ${enabled ? "on" : "off"}` },
                modeTarget ?? getTarget(),
                { idempotencyKey: randomId() },
              ),
            requestAgentApproval: ({
              workflow,
              preview,
              operations,
              dismissSignal,
              title,
              message,
            }) =>
              showNativeDialog(
                {
                  method: "confirm",
                  title: title ?? t("workflow.proposalTitle"),
                  message:
                    message ??
                    t("workflow.proposalMessage", {
                      fromRevision: workflow.revision,
                      toRevision: workflow.revision + 1,
                      operations: JSON.stringify(operations, null, 2),
                      nodeCount: preview.nodes.length,
                      edgeCount: preview.edges.length,
                    }),
                },
                undefined,
                { dismissSignal },
              ).then((result) => result?.confirmed === true),
          });
        }
        const currentTarget = getTarget();
        const workflowId = await preferences.get(`ui.workflow.active.${currentTarget.workspaceId}`);
        const invoke = globalThis.__TAURI__?.core?.invoke;
        if (!workflowId || typeof invoke !== "function") {
          throw new Error(t("workflow.openWindowFailed"));
        }
        await invoke("open_workflow_window", {
          workspaceId: currentTarget.workspaceId,
          workflowId,
          target: currentTarget,
        });
        window.dispatchEvent(new CustomEvent("pipline:workflow-window-opened"));
      } catch (error) {
        console.error("[Workflow] Failed to open workflow mode:", error);
        const body = document.getElementById("workflow-panel-body");
        if (body) body.textContent = error?.message || String(error);
        throw error;
      } finally {
        button.disabled = false;
      }
    })();
    workflowModeOpening = opening;
    try {
      await opening;
    } finally {
      if (workflowModeOpening === opening) workflowModeOpening = null;
    }
  }

  button?.addEventListener("click", () => openWorkflowMode().catch(showError));

  async function ensureWorkflowModeForPrompt(message) {
    if (!explicitlyRequestsWorkflow(message)) return;
    if (workflowModeOpening) await workflowModeOpening;
    const panel = document.getElementById("workflow-panel");
    if (panel && !panel.classList.contains("hidden")) return;
    await openWorkflowMode();
  }

  function syncTargetOnSwitch(nextTarget) {
    void globalThis.__TAURI__?.core?.invoke?.("update_workflow_window_target", {
      workspaceId: nextTarget.workspaceId,
      target: nextTarget,
    });
    const workflowPanel = document.getElementById("workflow-panel");
    if (workflowPanel && !workflowPanel.classList.contains("hidden")) {
      void import("./workflow-panel.js")
        .then(({ syncWorkflowModeTarget }) => syncWorkflowModeTarget())
        .catch((error) =>
          console.warn("[Workflow] Could not sync Pi tools after session switch:", error),
        );
    }
  }

  return {
    openWorkflowMode,
    ensureWorkflowModeForPrompt,
    syncTargetOnSwitch,
  };
}
