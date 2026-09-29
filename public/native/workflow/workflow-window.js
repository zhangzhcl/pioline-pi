import { initI18n, onLocaleChange, startSharedLocaleSync, t } from "../../i18n.js";
import { applyTheme, getCurrentTheme } from "../../themes.js";
import { HostControlGateway } from "../transport/control-gateway.js";
import { HostRuntimeAdapter, resolveHostWebSocketUrl } from "../transport/runtime-adapter.js";
import { RuntimeGateway } from "../transport/runtime-gateway.js";
import { randomId } from "../utils/random-id.js";
import { parseAppRoute } from "../utils/router.js";
import { createPiSessionActivity } from "./pi-session-activity.js";
import { workflowErrorMessage } from "./workflow-error-message.js";

const route = parseAppRoute(window.location.pathname);
const query = new URLSearchParams(window.location.search);
if (route.name !== "workflow") throw new Error("Pipline requires a workflow route");

function buildShell() {
  document.body.classList.add("workflow-window-page");
  const panel = document.createElement("section");
  panel.className = "workflow-panel workflow-window";
  panel.id = "workflow-panel";
  panel.setAttribute("aria-labelledby", "workflow-panel-title");
  const header = document.createElement("header");
  header.className = "workflow-panel__header";
  const heading = document.createElement("div");
  const title = document.createElement("h1");
  title.id = "workflow-panel-title";
  title.textContent = t("workflow.title");
  const revision = document.createElement("span");
  revision.className = "workflow-panel__revision";
  revision.id = "workflow-revision";
  heading.append(title, revision);
  const close = document.createElement("button");
  close.type = "button";
  close.id = "workflow-close";
  close.className = "ui-icon-button ui-icon-button--sm ui-icon-button--ghost";
  close.setAttribute("aria-label", t("workflow.close"));
  close.textContent = "×";
  const unusedModeButton = document.createElement("button");
  unusedModeButton.type = "button";
  unusedModeButton.id = "workflow-mode-toggle";
  unusedModeButton.className = "hidden";
  unusedModeButton.setAttribute("aria-expanded", "true");
  header.append(heading, close);
  const body = document.createElement("div");
  body.className = "workflow-panel__body";
  body.id = "workflow-panel-body";
  body.setAttribute("aria-live", "polite");
  panel.append(header, body, unusedModeButton);
  document.body.replaceChildren(panel);
  return panel;
}

export const appReady = (async () => {
  document.body.dataset.runtime = "native";
  applyTheme(getCurrentTheme());
  await initI18n();
  startSharedLocaleSync();
  const panel = buildShell();
  const adapter = new HostRuntimeAdapter({
    url: resolveHostWebSocketUrl(window),
    clientId: `workflow-${randomId()}`,
    clientType: "desktop",
  });
  const runtime = new RuntimeGateway(adapter);
  const control = new HostControlGateway(adapter);
  const sessionId = query.get("sessionId");
  const instanceId = query.get("instanceId");
  let target =
    sessionId && instanceId ? { workspaceId: route.workspaceId, sessionId, instanceId } : null;
  const piActivity = createPiSessionActivity(runtime);
  void piActivity.setTarget(target);
  if (target) adapter.subscribeTarget(target);
  window.addEventListener("pipline:workflow-target-changed", (event) => {
    const next = event.detail;
    if (
      !next ||
      next.workspaceId !== route.workspaceId ||
      typeof next.sessionId !== "string" ||
      typeof next.instanceId !== "string"
    )
      return;
    target = next;
    adapter.subscribeTarget(next);
    void piActivity.setTarget(next);
  });
  runtime.subscribe((frame) => {
    if (
      frame?.type === "workflow_changed" ||
      frame?.type === "workflow_node_templates_changed" ||
      frame?.type === "workflow_run_changed" ||
      frame?.type === "workflow_resync_required"
    )
      window.dispatchEvent(new CustomEvent("pipline:workflow-host-event", { detail: frame }));
  });
  adapter.connect();
  window.addEventListener("pipline:workflow-context-request", async (event) => {
    try {
      await globalThis.__TAURI__?.core?.invoke?.("send_workflow_context", {
        workspaceId: route.workspaceId,
        summary: event.detail?.summary,
      });
    } catch (error) {
      const body = document.getElementById("workflow-panel-body");
      if (body) body.dataset.error = workflowErrorMessage(error);
    }
  });
  const handlePiLock = async (running) => {
    await globalThis.__TAURI__?.core?.invoke?.("set_workflow_run_lock", {
      workspaceId: route.workspaceId,
      running,
    });
  };
  try {
    const { requestStandaloneWorkflowNavigation, toggleWorkflowPanel } = await import(
      "./workflow-panel.js"
    );
    window.addEventListener("pipline:workflow-navigation-requested", (event) => {
      const workflowId = event.detail?.workflowId;
      if (!requestStandaloneWorkflowNavigation(workflowId)) return;
      const nextUrl = new URL(window.location.href);
      nextUrl.pathname = `/app/workspaces/${encodeURIComponent(route.workspaceId)}/workflows/${encodeURIComponent(workflowId)}`;
      nextUrl.search = "";
      if (
        event.detail?.target?.workspaceId === route.workspaceId &&
        typeof event.detail.target.sessionId === "string" &&
        typeof event.detail.target.instanceId === "string"
      ) {
        nextUrl.searchParams.set("sessionId", event.detail.target.sessionId);
        nextUrl.searchParams.set("instanceId", event.detail.target.instanceId);
      }
      window.location.assign(nextUrl);
    });
    await toggleWorkflowPanel({
      control,
      preferences: {
        get: async () => route.workflowId,
        set: async () => route.workflowId,
      },
      workspaceId: route.workspaceId,
      runtime,
      getTarget: () => target,
      getPiBusy: piActivity.getBusy,
      getModel: () => null,
      onPiRunningChange: async (running) => {
        await handlePiLock(running);
        panel.classList.toggle("is-run-active", running);
      },
      setAgentToolsEnabled: async () => {},
      requestAgentApproval: async () => false,
      standalone: true,
      requestedWorkflowId: route.workflowId,
    });
  } catch (error) {
    console.error("[Workflow] Failed to initialize standalone editor", error);
    const body = document.getElementById("workflow-panel-body");
    if (body) body.textContent = workflowErrorMessage(error) || t("workflow.loadError");
  }
  document.title = `${t("workflow.title")} · Pipline`;
  const updateNativeTitle = () => {
    document.title = `${t("workflow.title")} · Pipline`;
    void globalThis.__TAURI__?.core?.invoke?.("set_workflow_window_title", {
      title: document.title,
    });
  };
  onLocaleChange(updateNativeTitle);
  updateNativeTitle();
  window.addEventListener("beforeunload", () => {
    handlePiLock(false);
    piActivity.dispose();
    adapter.disconnect();
  });
})();
