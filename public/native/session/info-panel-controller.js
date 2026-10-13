import { createWorkspaceAppActions } from "../workspace/app-actions.js";
import { toggleExclusiveSidePanel } from "../workspace/exclusive-side-panel.js";
import { spawnSessionViaHost } from "../workspace/workspace-actions.js";
import { InfoPanel } from "./info-panel.js";
import { buildAnalysisPrompt, runAiAnalysis } from "./session-ai-runner.js";
import { activeSession, setupSessionInfo } from "./session-info.js";
import { createSessionTaskAnalysis } from "./session-task-analysis.js";
import { buildTurnsFromEntries, mergeTurnSources } from "./turn-history.js";

/**
 * 封装会话信息浮层、右侧 Info 面板（会话分支树 + 工作区快捷动作 + 任务耗时/AI 诊断分析）及其刷新和树节点跳转。
 */
export function setupInfoPanelController({
  data,
  runtime,
  control,
  config,
  turnTrace,
  getTarget,
  getSessions,
  getCurrentModel,
  isStreaming,
  hydrateSnapshotOnce,
  t,
}) {
  const infoSidebar = document.getElementById("info-sidebar");
  let infoPanel = null;
  let infoTreeSeq = 0;

  const sessionInfo = setupSessionInfo({
    toggle: document.getElementById("session-info-toggle"),
    panel: document.getElementById("session-info-panel"),
    fileValue: document.getElementById("session-info-file"),
    idValue: document.getElementById("session-info-id"),
    getTarget,
    getSessions,
  });

  function syncSessionInfo() {
    sessionInfo.refresh();
    const { id, session } = activeSession(getTarget, getSessions);
    infoPanel?.updateSessionInfo({ filePath: session?.filePath || "", sessionId: id });
  }

  async function loadHistoryTurnsForTarget() {
    const target = getTarget();
    const sessionId = target.sessionId;
    const options = { target, leafId: null };
    try {
      const runtimeResponse = await runtime.request({ type: "get_entries" }, target);
      const tree = runtimeResponse?.response?.data;
      if (Array.isArray(tree?.entries)) {
        if (getTarget().sessionId !== sessionId) return [];
        return buildTurnsFromEntries(tree.entries, { ...options, leafId: tree.leafId ?? null });
      }
    } catch (error) {
      console.warn("[TaskDebugger] runtime entries unavailable, falling back to disk:", error);
    }
    if (sessionId.startsWith("temporary-")) return [];
    const response = await data.readSessionTree(target.workspaceId, sessionId);
    if (getTarget().sessionId !== sessionId) return [];
    return buildTurnsFromEntries(response?.tree?.entries ?? [], {
      ...options,
      leafId: response?.tree?.leafId ?? null,
    });
  }

  async function resolveSessionTurns() {
    let history = [];
    try {
      history = await loadHistoryTurnsForTarget();
    } catch (error) {
      console.warn("[InfoPanel] AI analysis history read failed:", error);
    }
    return mergeTurnSources(history, turnTrace.getTurns(getTarget()));
  }

  async function analyzeSessionTurnsWithAi(turns) {
    const model = getCurrentModel();
    return runAiAnalysis({
      runtime,
      control,
      spawnSession: spawnSessionViaHost,
      workspaceId: getTarget().workspaceId,
      model: model?.provider && model?.id ? { provider: model.provider, id: model.id } : null,
      prompt: buildAnalysisPrompt(turns),
    });
  }

  const infoAppActions = createWorkspaceAppActions({
    control,
    getWorkspacePath: () => infoPanel?.workspacePath || "",
  });

  const taskAnalysis = createSessionTaskAnalysis({
    getTurns: () => turnTrace.getTurns(getTarget()),
    loadHistoryTurns: loadHistoryTurnsForTarget,
    resolveTurns: resolveSessionTurns,
    analyzeWithAi: analyzeSessionTurnsWithAi,
    t,
  });

  async function refreshInfoPanel({ refreshWorkspace = false } = {}) {
    if (!infoPanel || !infoSidebar || infoSidebar.classList.contains("collapsed")) return;
    const seq = ++infoTreeSeq;
    const target = getTarget();
    void taskAnalysis?.refresh();
    if (refreshWorkspace) {
      try {
        const response = await data.workspaceInfo(target.workspaceId);
        infoPanel.updateWorkspace(response?.info?.path ?? "");
      } catch {
        // 工作区路径查询失败时保留上次值，继续加载会话树
      }
    }
    syncSessionInfo();
    try {
      const runtimeResponse = await runtime.request({ type: "get_entries" }, target);
      const tree = runtimeResponse?.response?.data;
      if (Array.isArray(tree?.entries)) {
        if (seq !== infoTreeSeq) return;
        infoPanel.updateTree({ entries: tree.entries, leafId: tree.leafId ?? null });
        return;
      }
      throw new Error("Runtime get_entries returned no entries");
    } catch (runtimeError) {
      try {
        const response = await data.readSessionTree(target.workspaceId, target.sessionId);
        if (seq !== infoTreeSeq) return;
        infoPanel.updateTree({
          entries: response?.tree?.entries ?? [],
          leafId: response?.tree?.leafId ?? null,
        });
      } catch (error) {
        console.warn("[InfoPanel] tree refresh failed:", runtimeError, error);
      }
    }
  }

  async function navigateActiveTree(entryId) {
    if (!entryId || isStreaming()) return;
    const result = await config.call("navigate_tree", {
      targetId: entryId,
      summarize: false,
      label: t("infoPanel.resumeBranch"),
    });
    if (!result?.ok) throw new Error(result?.error || "Session tree navigation failed");
    await hydrateSnapshotOnce();
    if (infoSidebar && !infoSidebar.classList.contains("collapsed")) {
      await refreshInfoPanel();
    }
  }

  infoPanel = infoSidebar
    ? new InfoPanel({
        panel: document.getElementById("info-panel"),
        actions: infoAppActions,
        t,
        onNavigateLeaf: (entryId) => navigateActiveTree(entryId),
        isStreaming,
        taskAnalysis,
      })
    : null;

  function openInfoPanel() {
    const opened = toggleExclusiveSidePanel(infoSidebar, [
      document.getElementById("file-sidebar"),
      document.getElementById("diff-sidebar"),
    ]);
    if (opened) void refreshInfoPanel({ refreshWorkspace: true });
  }

  document.getElementById("info-sidebar-toggle")?.addEventListener("click", openInfoPanel);
  document.getElementById("info-sidebar-close")?.addEventListener("click", () => {
    infoSidebar?.classList.add("collapsed");
  });
  document.getElementById("info-sidebar-refresh")?.addEventListener("click", () => {
    void refreshInfoPanel({ refreshWorkspace: true });
  });

  return {
    infoPanel,
    taskAnalysis,
    syncSessionInfo,
    refreshInfoPanel,
    refreshIfOpen() {
      if (infoSidebar && !infoSidebar.classList.contains("collapsed")) {
        void refreshInfoPanel();
      }
    },
    navigateActiveTree,
    onTargetChanged({ workspaceChanged }) {
      taskAnalysis?.rerender();
      infoTreeSeq += 1;
      infoPanel?.updateTree({ entries: [], leafId: null });
      if (infoSidebar && !infoSidebar.classList.contains("collapsed")) {
        void refreshInfoPanel({ refreshWorkspace: workspaceChanged });
      }
      syncSessionInfo();
    },
  };
}
