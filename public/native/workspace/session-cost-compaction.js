import { createCompactCoordinator } from "../../compact-coordinator.js";
import { createHeaderStatusBar } from "../../ui/header-status-bar.js";
import { randomId } from "../utils/random-id.js";

export function computeTotalCostFromMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const msg of messages) {
    if (msg?.usage?.cost?.total) total += Number(msg.usage.cost.total) || 0;
  }
  return total;
}

/**
 * 管理顶部状态栏会话成本统计、权威 `get_session_stats` 水合以及手动上下文压缩（Compact）状态机。
 */
export function setupSessionCostAndCompaction({
  sessionCostEl = document.getElementById("session-cost"),
  compactContextButton = document.getElementById("compact-context-btn"),
  runtime,
  contextUsage,
  getTarget,
  getStore,
  clearStoreCompaction,
  getSessions,
  t,
  showError,
}) {
  const headerStatusBar = sessionCostEl
    ? createHeaderStatusBar({
        sessionCostEl,
        t,
        onTotalsChange: (totals) => contextUsage.setSessionTotals(totals),
      })
    : null;

  let sessionTotalCost = 0;
  let statsHydrationGeneration = 0;

  function activeSessionFileForStatusBar() {
    const sessions = getSessions() ?? [];
    const target = getTarget();
    const store = getStore();
    return (
      sessions.find((s) => s.id === target.sessionId)?.filePath ??
      sessions.find((s) => s.projectPath === store.cwd)?.filePath ??
      null
    );
  }

  async function hydrateHeaderSessionStats() {
    if (!headerStatusBar) return;
    const generation = ++statsHydrationGeneration;
    try {
      const frame = await runtime.request({ type: "get_session_stats" }, getTarget());
      const result = frame?.response ?? frame;
      if (!result?.success || !result?.data) return;
      if (generation !== statsHydrationGeneration) return;
      if (!result.data.sessionFile) return;
      const activeSessionFile = activeSessionFileForStatusBar();
      if (activeSessionFile && result.data.sessionFile !== activeSessionFile) return;
      headerStatusBar.hydrateSessionStats({
        sessionFile: result.data.sessionFile,
        tokens: result.data.tokens,
        cost: result.data.cost,
      });
    } catch {
      // 聚合并非强阻塞项，失败时保留当前上下文统计显示
    }
  }

  function setSessionCost(cost) {
    sessionTotalCost = cost;
    if (!sessionCostEl) return;
    if (!cost || cost <= 0) {
      sessionCostEl.classList.remove("visible");
      sessionCostEl.textContent = "";
      return;
    }
    sessionCostEl.classList.add("visible");
    sessionCostEl.textContent = `$${cost.toFixed(4)}`;
    sessionCostEl.title = `Session cost: $${cost.toFixed(6)}`;
  }

  function addSessionCost(delta) {
    setSessionCost(sessionTotalCost + (Number(delta) || 0));
  }

  const compactCoordinator = createCompactCoordinator({
    send: async () => {
      const frame = await runtime.request({ type: "compact" }, getTarget(), {
        idempotencyKey: randomId(),
      });
      return frame?.response ?? { success: false };
    },
    onState: (state) => {
      contextUsage.setCompacting(state === "requested" || state === "running");
    },
    onTimeout: () => {
      clearStoreCompaction();
      showError(new Error(t("errors.compactionTimedOut")));
    },
  });

  async function requestManualCompaction() {
    const store = getStore();
    if (
      !contextUsage.canCompact ||
      store.lifecycle === "working" ||
      store.compaction?.status === "running" ||
      compactCoordinator.busy
    ) {
      return;
    }
    await compactCoordinator.request();
  }

  compactContextButton?.addEventListener("click", () => requestManualCompaction().catch(showError));

  return {
    headerStatusBar,
    compactCoordinator,
    hydrateHeaderSessionStats,
    setSessionCost,
    addSessionCost,
    resetForNewTarget() {
      headerStatusBar?.reset?.();
      void hydrateHeaderSessionStats();
      setSessionCost(0);
    },
  };
}
