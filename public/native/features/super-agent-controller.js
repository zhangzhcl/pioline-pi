import { dispatchSuperAgentTaskNative } from "../../super-agent/native-dispatch.js";
import {
  isSuperAgentSessionSummary,
  resolveSuperAgentActiveSession,
} from "../../super-agent/session.js";
import { isSuperAgentEnabled } from "../../super-agent/settings.js";
import { selectSuperAgentStartupAction } from "../../super-agent/startup-flow.js";
import {
  buildTaskComposerPrompt,
  markTaskChildSessionBound,
} from "../../super-agent/task-state.js";
import { updateSuperAgentTask } from "../../super-agent/task-store.js";
import { randomId } from "../utils/random-id.js";
import {
  openSessionInProjectViaHost,
  resolveWorkspaceViaHost,
  spawnSessionViaHost,
} from "../workspace/workspace-actions.js";

const SUPER_AGENT_LAUNCHED_KEY = "pi-studio-super-agent-launched";

function wasSuperAgentLaunched() {
  try {
    return sessionStorage.getItem(SUPER_AGENT_LAUNCHED_KEY) === "1";
  } catch {
    return false;
  }
}

function markSuperAgentLaunched() {
  try {
    sessionStorage.setItem(SUPER_AGENT_LAUNCHED_KEY, "1");
  } catch {
    // sessionStorage 不可用时降级允许重复自动拉起
  }
}

/**
 * 管理 Super Agent（Agent Inbox）会话激活状态、启动自动确保/拉起、子任务分发与后台子会话绑定。
 */
export function setupSuperAgentController({
  adapter,
  runtime,
  input,
  composerAutoResize,
  getTarget,
  getSidebar,
  switchSession,
  showError,
}) {
  let agentInboxNavSelectSession = null;
  let agentInboxNavSession = null;
  let superAgentEnsureInFlight = null;
  const dispatchedInstances = new Map();

  async function openSessionInProject(session) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (!invoke) {
      await openSessionInProjectViaHost(session);
      return;
    }
    await invoke("open_session_in_project", {
      projectPath: session.projectPath,
      sessionId: session.id,
    });
  }

  function updateAgentInboxNavActive() {
    const button = document.getElementById("sidebar-agent-inbox-btn");
    button?.classList.toggle("active", document.body.classList.contains("super-agent-active"));
  }

  function updateSuperAgentActiveState(session = null, { openRuntimePanel = false } = {}) {
    const active = isSuperAgentSessionSummary(session);
    document.body.classList.toggle("super-agent-active", active);
    document.getElementById("super-agent-chat-header")?.classList.toggle("hidden", !active);
    updateAgentInboxNavActive();

    if (active && !openRuntimePanel) {
      document.querySelector("super-agent-runtime")?.classList.add("collapsed");
      console.info("[SESSION-LOAD] Agent Inbox active; runtime panel kept collapsed", {
        sessionId: getTarget().sessionId,
      });
    }
  }

  function setAgentInboxNavSession(session) {
    agentInboxNavSession = session;
    const button = document.getElementById("sidebar-agent-inbox-btn");
    button?.classList.toggle("hidden", !session);
    updateAgentInboxNavActive();
  }

  function openAgentInboxNav({ openRuntimePanel = false } = {}) {
    if (!agentInboxNavSession) return;
    updateSuperAgentActiveState(agentInboxNavSession, { openRuntimePanel });
    const selected = agentInboxNavSelectSession?.(agentInboxNavSession);
    if (selected && typeof selected.catch === "function") selected.catch(showError);
  }

  function insertTaskPrompt(task) {
    if (!task) return;
    const draft = input.value.trim();
    input.value = `${buildTaskComposerPrompt(task)}${draft ? `\n${draft}` : ""}`;
    composerAutoResize.sync();
    input.focus();
  }

  async function ensureSuperAgentStartupSession({ reloadAfterEnsure = true } = {}) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (!invoke || !isSuperAgentEnabled()) return;
    if (!superAgentEnsureInFlight) {
      superAgentEnsureInFlight = invoke("ensure_agent_inbox_session").finally(() => {
        superAgentEnsureInFlight = null;
      });
    }
    await superAgentEnsureInFlight;
    if (reloadAfterEnsure) await getSidebar()?.load({ quiet: true });
  }

  async function openSuperAgentSessionOnce(session) {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (!invoke || !session) return;
    markSuperAgentLaunched();
    try {
      await invoke("open_session_in_project", {
        projectPath: session.projectPath,
        sessionId: session.id,
      });
    } catch (error) {
      console.warn("[SuperAgent] Failed to auto-launch Agent Inbox:", error);
    }
  }

  async function handleSuperAgentStartupSessions(sessions) {
    const action = selectSuperAgentStartupAction({
      alreadyLaunched: wasSuperAgentLaunched(),
      enabled: isSuperAgentEnabled(),
      sessions,
      currentSessionId: getTarget().sessionId,
    });
    if (action.type === "ensure") {
      await ensureSuperAgentStartupSession();
      return;
    }
    if (action.type === "launch") {
      await openSuperAgentSessionOnce(action.session);
    }
  }

  async function bindDispatchedChildSession(instanceId, boundSessionId) {
    if (!instanceId || !boundSessionId) return;
    const taskId = dispatchedInstances.get(instanceId);
    if (!taskId) return;
    dispatchedInstances.delete(instanceId);
    await updateSuperAgentTask(window.__picotConfigCall, taskId, (task) =>
      markTaskChildSessionBound(task, { childSessionId: boundSessionId }),
    ).catch((error) => console.warn("[SuperAgent] failed to bind child session:", error));
  }

  document.getElementById("sidebar-agent-inbox-btn")?.addEventListener("click", () => {
    openAgentInboxNav();
  });

  document.addEventListener("sa-open-agent-inbox", (event) => {
    openAgentInboxNav({ openRuntimePanel: event.detail?.openRuntimePanel === true });
  });

  document.addEventListener("sa-prompt-task", (event) => insertTaskPrompt(event.detail));

  document.addEventListener("sa-view-session", (event) => {
    const task = event.detail;
    const childSessionId = task?.dispatch?.childSessionId;
    if (!childSessionId) return;
    const projectPath = task?.dispatch?.targetProject || task?.targetProject;
    if (projectPath) {
      openSessionInProject({ id: childSessionId, projectPath }).catch(showError);
    } else {
      updateSuperAgentActiveState(null);
      switchSession(childSessionId).catch(showError);
    }
  });

  document.addEventListener("sa-dispatch", (event) => {
    const task = event.detail;
    if (!task) return;
    dispatchSuperAgentTaskNative({
      task,
      resolveWorkspace: (projectPath) => resolveWorkspaceViaHost(projectPath),
      spawnSession: (workspaceId) => spawnSessionViaHost(workspaceId),
      sendPrompt: (dispatchTarget, message) =>
        runtime.request({ type: "prompt", message }, dispatchTarget, {
          idempotencyKey: randomId(),
        }),
      resolveBoundTarget: async (dispatchTarget) => {
        const snapshot = await runtime.snapshot(dispatchTarget.sessionId);
        return snapshot.target;
      },
      updateTask: (taskId, updater) =>
        updateSuperAgentTask(window.__picotConfigCall, taskId, updater),
      registerDispatchTarget: (dispatchTarget, taskId) => {
        dispatchedInstances.set(dispatchTarget.instanceId, taskId);
        adapter.subscribeTarget?.(dispatchTarget);
      },
    }).catch(showError);
  });

  window.addEventListener("picot-super-agent-autostart-changed", (event) => {
    if (event.detail?.enabled) {
      getSidebar()?.syncAgentInboxNav();
      ensureSuperAgentStartupSession().catch(showError);
      return;
    }
    setAgentInboxNavSession(null);
    updateSuperAgentActiveState(null);
  });

  return {
    openSessionInProject,
    updateSuperAgentActiveState,
    setAgentInboxNavSession,
    setSelectSessionHandler(handler) {
      agentInboxNavSelectSession = handler;
    },
    ensureSuperAgentStartupSession,
    handleSuperAgentStartupSessions,
    bindDispatchedChildSession,
    syncActiveFromSessions(sessions) {
      updateSuperAgentActiveState(resolveSuperAgentActiveSession(sessions, getTarget().sessionId));
    },
  };
}
