// ABOUTME: In-panel task analysis -- where the time went, what failed, what got
// ABOUTME: stuck, which steps were redundant, and the model's own reading of it.

/**
 * Task analysis: a compact summary row in the Info panel rail (title + total
 * elapsed time) that opens a dialog with the full report. The report itself
 * -- phase split, findings, slowest steps -- has too many stacked sections
 * to read as an inline block in a ~280px rail; it earns a proper modal
 * instead. It stays a report on trouble, not a full run log: findings are
 * pared to the ones that explain a failure or a slow step, and the step
 * list is capped to the 5 slowest rather than every step the turn took.
 *
 * Answers the four questions a "why was this slow / why did it fail" report has
 * to answer, from the spans `turn-trace.js` recorded:
 *
 *   1. Where did the time go?  -> phase split (model / tool / compaction / idle)
 *   2. What got stuck?         -> longest span, plus spans that never ended
 *   3. Where did it fail?      -> first failing span and every later one
 *   4. What was wasted?        -> identical tool calls, retry loops, re-reads
 *
 * Turns this window watched come from the recorder; everything before that -- a
 * reopened session, a restarted app -- is rebuilt from the saved session log
 * when `loadHistoryTurns` is supplied. The two are merged with live winning
 * where they overlap (see `mergeTurnSources`), so the section is useful on the
 * first open rather than only after the next task runs.
 *
 * Nothing here decides anything about the turn: `analyze` (turn-analysis.js) is
 * a pure function and the optional AI block is the only model call, kept behind
 * its own button because it costs a real request.
 */

import { t as translate } from "../../i18n.js";
import { createIcon } from "../../icons.js";
import { bindDialogEscape } from "../../ui/dialog-escape.js";
import { createSessionAiAnalysis } from "./session-ai-analysis.js";
import {
  buildMarkdownReport,
  element,
  renderFindings,
  renderPhases,
  renderSteps,
  renderSummary,
} from "./session-task-analysis-views.js";
import { analyzeTurns, formatMs } from "./turn-analysis.js";
import { mergeTurnSources } from "./turn-history.js";

export { buildMarkdownReport };

let instanceSeq = 0;

/**
 * Build the Info panel's task analysis section.
 *
 * @param {{
 *   getTurns: () => Array<object>,
 *   loadHistoryTurns?: () => Promise<Array<object>> | Array<object>,
 *   analyze?: (turns: Array<object>, options?: object) => object,
 *   resolveTurns?: () => Promise<Array<object>> | Array<object>,
 *   analyzeWithAi?: (turns: Array<object>) => Promise<string>,
 *   t?: (key: string, params?: object) => string,
 *   writeText?: (text: string) => Promise<void> | void,
 * }} options
 * @returns {{
 *   element: HTMLElement,
 *   refresh: () => Promise<void>,
 *   rerender: () => void,
 *   resetHistory: () => void,
 *   setStreaming: (value: boolean) => void,
 *   getReport: () => object | null,
 * }}
 */
export function createSessionTaskAnalysis({
  getTurns,
  loadHistoryTurns = null,
  analyze = analyzeTurns,
  resolveTurns,
  analyzeWithAi = null,
  t = translate,
  writeText = (text) => navigator.clipboard?.writeText(text),
} = {}) {
  const section = element("section", "session-analysis");
  const uid = ++instanceSeq;
  section.setAttribute("aria-labelledby", `session-analysis-heading-${uid}`);

  // Compact trigger row: the only part of the report that lives in the rail
  // permanently. It opens the dialog rather than expanding inline -- the
  // full report (phase bar, findings, step list, timeline) has too many
  // stacked sections to read as a block in a rail this narrow.
  const head = document.createElement("button");
  head.type = "button";
  head.className = "session-analysis-toggle";
  head.setAttribute("aria-haspopup", "dialog");
  const title = element("span", "session-analysis-title", t("taskDebugger.title"));
  title.id = `session-analysis-heading-${uid}`;
  const time = element("span", "session-analysis-time", "");
  const caret = element("span", "session-analysis-caret");
  caret.setAttribute("aria-hidden", "true");
  caret.append(createIcon("chevron-right", { size: 14 }));
  head.append(title, time, caret);

  // Dialog: portaled to <body>, not left as a child of `section`. The rail
  // that hosts `section` (.info-sidebar / .app-side-panel) carries its own
  // `backdrop-filter`, and a `backdrop-filter` on an ancestor creates a new
  // containing block for `position: fixed` descendants -- so a fixed dialog
  // left inside it paints relative to the narrow rail instead of the
  // viewport. Matches the pattern other dialogs in this app already use
  // (see workspace/remote-workspace-dialog.js).
  const overlay = element("div", "session-analysis-overlay hidden");
  const dialogTitleId = `session-analysis-dialog-heading-${uid}`;
  const content = element("div", "session-analysis-content hidden");
  content.setAttribute("role", "dialog");
  content.setAttribute("aria-modal", "true");
  content.setAttribute("aria-labelledby", dialogTitleId);

  const dialogHead = element("div", "session-analysis-dialog-head");
  const dialogTitle = element("span", "session-analysis-dialog-title", t("taskDebugger.title"));
  dialogTitle.id = dialogTitleId;
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className =
    "ui-icon-button ui-icon-button--xs ui-icon-button--ghost session-analysis-copy";
  copyButton.append(createIcon("clipboard", { size: 14 }));
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className =
    "ui-icon-button ui-icon-button--sm ui-icon-button--ghost session-analysis-close";
  closeButton.append(createIcon("x", { size: 16 }));
  dialogHead.append(dialogTitle, copyButton, closeButton);

  const body = element("div", "session-analysis-body");
  content.append(dialogHead, body);
  section.append(head);
  document.body.append(overlay, content);

  let streaming = false;
  // The dialog opens on demand; the rail only ever shows the compact trigger.
  let collapsed = true;
  let lastReport = null;
  let historyTurns = [];
  let historyState = typeof loadHistoryTurns === "function" ? "idle" : "off";
  // Guards a session switch (or a concurrent refresh) from letting a stale read
  // of the previous session's log repaint the section.
  let historySeq = 0;

  const aiAnalysis =
    typeof analyzeWithAi === "function" && typeof resolveTurns === "function"
      ? createSessionAiAnalysis({
          t,
          resolveTurns,
          analyzeWithAi,
          isStreaming: () => streaming,
        })
      : null;

  function availableTurns() {
    return mergeTurnSources(historyTurns, getTurns?.() ?? []);
  }

  function selectedTurns() {
    const turns = availableTurns();
    // A turn still streaming has open spans; calling them "stuck" would be a
    // lie, so it is left out until it settles.
    return streaming ? turns.filter((turn) => turn.status !== "running") : turns;
  }

  function renderCopyButton() {
    copyButton.disabled = !lastReport;
    const label = t("taskDebugger.copyReport");
    copyButton.title = label;
    copyButton.setAttribute("aria-label", label);
  }

  function renderBody() {
    const turns = selectedTurns();
    body.replaceChildren();
    if (!turns.length) {
      const key =
        historyState === "loading"
          ? "taskDebugger.loadingHistory"
          : historyState === "failed"
            ? "taskDebugger.historyFailed"
            : "taskDebugger.noTurns";
      body.appendChild(element("p", "session-analysis-empty", t(key)));
      lastReport = null;
      return;
    }
    const report = analyze(turns);
    lastReport = report;
    body.append(
      ...[
        renderSummary(report, t),
        renderFindings(report, t),
        renderPhases(report, t),
        renderSteps(report, t),
      ].filter(Boolean),
    );
    // Rebuilt spans come from the saved log, which records no compaction and no
    // step the runtime never wrote down. Say so rather than letting a thinner
    // report read as a complete one.
    if (turns.some((turn) => turn.source === "history")) {
      body.appendChild(element("p", "session-analysis-note", t("taskDebugger.historyNote")));
    }
    if (aiAnalysis) body.appendChild(aiAnalysis.element);
  }

  function render() {
    overlay.classList.toggle("hidden", collapsed);
    content.classList.toggle("hidden", collapsed);
    head.setAttribute("aria-expanded", String(!collapsed));
    // Labels change with the locale; re-render them here rather than only at build.
    title.textContent = t("taskDebugger.title");
    dialogTitle.textContent = t("taskDebugger.title");
    renderBody();
    // The trigger always shows the whole session's total, visible without
    // opening the dialog.
    time.textContent = lastReport ? formatMs(lastReport.totals.wallMs) : "";
    renderCopyButton();
    aiAnalysis?.refresh();
  }

  function open() {
    if (!collapsed) return;
    collapsed = false;
    render();
  }

  function close() {
    if (collapsed) return;
    collapsed = true;
    render();
    head.focus();
  }

  /**
   * Re-read the saved log: a turn that ended since the last look is exactly the
   * one the user came to see, and the read is a single file.
   */
  async function refresh() {
    if (typeof loadHistoryTurns !== "function") return;
    const seq = ++historySeq;
    historyState = "loading";
    if (!historyTurns.length) render();
    try {
      const turns = await loadHistoryTurns();
      if (seq !== historySeq) return;
      historyTurns = Array.isArray(turns) ? turns : [];
      historyState = "ready";
    } catch (error) {
      if (seq !== historySeq) return;
      console.warn("[TaskAnalysis] session history rebuild failed:", error);
      historyTurns = [];
      historyState = "failed";
    }
    render();
  }

  head.addEventListener("click", () => {
    if (collapsed) open();
    else close();
  });
  overlay.addEventListener("click", close);
  closeButton.addEventListener("click", close);
  bindDialogEscape(close, { isActive: () => !collapsed });
  let copyResetTimer = null;
  copyButton.addEventListener("click", async () => {
    if (!lastReport) return;
    try {
      const result = writeText?.(buildMarkdownReport(lastReport, t));
      if (!result) throw new Error("Clipboard unavailable");
      await result;
      copyButton.title = t("taskDebugger.copied");
      copyButton.setAttribute("aria-label", t("taskDebugger.copied"));
    } catch {
      copyButton.title = t("taskDebugger.copyFailed");
      copyButton.setAttribute("aria-label", t("taskDebugger.copyFailed"));
    }
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(renderCopyButton, 1500);
  });

  render();

  return {
    element: section,
    refresh,
    /** Repaint translated labels from cached state (locale change). */
    rerender: render,
    /** A session switch invalidates the rebuilt history, not the live trace. */
    resetHistory() {
      historySeq += 1;
      historyTurns = [];
      historyState = typeof loadHistoryTurns === "function" ? "idle" : "off";
      aiAnalysis?.reset();
      collapsed = true;
      render();
    },
    /** Streaming turns are excluded: their open spans are not "stuck" yet. */
    setStreaming(value) {
      streaming = Boolean(value);
      render();
    },
    getReport: () => lastReport,
  };
}
