/**
 * Workflow Window Bridge
 * 负责主聊天窗口与独立工作流窗口之间的事件协同、输入区运行时锁定与上下文互通
 */

export function setupWorkflowWindowBridge({
  input,
  sendButton,
  composerAutoResize,
  formatWorkflowChatContext,
  t,
  getTarget,
  getPreferences,
  showError,
  invoke = globalThis.__TAURI__?.core?.invoke,
  windowTarget = window,
  documentTarget = document,
} = {}) {
  let workflowLockSnapshot = null;

  function handleRunLock(event) {
    if (event.detail?.running === true) {
      if (workflowLockSnapshot) return;
      workflowLockSnapshot = {
        input: Boolean(input?.disabled),
        sendButton: Boolean(sendButton?.disabled),
      };
      if (input) input.disabled = true;
      if (sendButton) sendButton.disabled = true;
      return;
    }
    if (!workflowLockSnapshot) return;
    if (input) input.disabled = workflowLockSnapshot.input;
    if (sendButton) sendButton.disabled = workflowLockSnapshot.sendButton;
    workflowLockSnapshot = null;
  }

  function handleWorkflowContext(event) {
    const summary = event.detail?.summary;
    if (!summary || !input) return;
    const formatContext = formatWorkflowChatContext || ((s) => JSON.stringify(s));
    const context = formatContext(summary, t);
    input.value = input.value.trim() ? `${input.value.trim()}\n\n${context}` : context;
    if (composerAutoResize?.sync) {
      composerAutoResize.sync();
    }
    input.focus();
  }

  async function handleContextRequest(event) {
    const target = getTarget?.();
    if (typeof invoke !== "function" || !target?.workspaceId) return;
    try {
      await invoke("send_workflow_context", {
        workspaceId: target.workspaceId,
        summary: event.detail?.summary,
      });
    } catch (error) {
      if (showError) showError(error);
    }
  }

  function handleWindowOpened() {
    documentTarget.getElementById?.("workflow-panel")?.classList.add("is-detached");
  }

  function handleWindowClosed() {
    const panel = documentTarget.getElementById?.("workflow-panel");
    if (!panel?.classList.contains("is-detached")) return;
    panel.classList.remove("is-detached");
    documentTarget.getElementById?.("workflow-mode-toggle")?.setAttribute("aria-expanded", "true");
  }

  function handleWindowHidden() {
    const panel = documentTarget.getElementById?.("workflow-panel");
    if (!panel?.classList.contains("is-detached")) return;
    panel.classList.remove("is-detached");
    documentTarget.getElementById?.("workflow-mode-toggle")?.setAttribute("aria-expanded", "true");
  }

  async function handleOpenWindowClick() {
    const target = getTarget?.();
    const preferences = getPreferences?.();
    const workflowId = await preferences?.get?.(`ui.workflow.active.${target?.workspaceId}`);
    if (!workflowId || typeof invoke !== "function") {
      if (showError) {
        showError(new Error(t ? t("workflow.openWindowFailed") : "Failed to open workflow window"));
      }
      return;
    }
    try {
      await invoke("open_workflow_window", {
        workspaceId: target.workspaceId,
        workflowId,
        target,
      });
      windowTarget.dispatchEvent?.(new CustomEvent("pipline:workflow-window-opened"));
    } catch (error) {
      if (showError) showError(error);
    }
  }

  windowTarget.addEventListener?.("pipline:workflow-run-lock", handleRunLock);
  windowTarget.addEventListener?.("pipline:workflow-context", handleWorkflowContext);
  windowTarget.addEventListener?.("pipline:workflow-context-request", handleContextRequest);
  windowTarget.addEventListener?.("pipline:workflow-window-opened", handleWindowOpened);
  windowTarget.addEventListener?.("pipline:workflow-window-closed", handleWindowClosed);
  windowTarget.addEventListener?.("pipline:workflow-window-hidden", handleWindowHidden);

  const openWindowBtn = documentTarget.getElementById?.("workflow-open-window");
  openWindowBtn?.addEventListener?.("click", handleOpenWindowClick);

  return {
    destroy() {
      windowTarget.removeEventListener?.("pipline:workflow-run-lock", handleRunLock);
      windowTarget.removeEventListener?.("pipline:workflow-context", handleWorkflowContext);
      windowTarget.removeEventListener?.("pipline:workflow-context-request", handleContextRequest);
      windowTarget.removeEventListener?.("pipline:workflow-window-opened", handleWindowOpened);
      windowTarget.removeEventListener?.("pipline:workflow-window-closed", handleWindowClosed);
      windowTarget.removeEventListener?.("pipline:workflow-window-hidden", handleWindowHidden);
      openWindowBtn?.removeEventListener?.("click", handleOpenWindowClick);
    },
  };
}
