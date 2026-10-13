// ABOUTME: Markdown report builder and DOM section views for session task analysis.

import { t as translate } from "../../i18n.js";
import { formatMs, formatShare } from "./turn-analysis.js";

const PHASE_ORDER = ["model", "tool", "compaction", "idle"];

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function findingText(finding, t) {
  return t(`taskDebugger.finding.${finding.code}`, finding.params || {});
}

function problemFindings(report) {
  return report.findings.filter((finding) => finding.severity !== "info");
}

/** Turn a report into a paste-ready Markdown summary (bug reports, issues). */
export function buildMarkdownReport(report, t = translate) {
  const lines = [];
  lines.push(`# ${t("taskDebugger.title")}`);
  lines.push("");
  lines.push(
    `- ${t("taskDebugger.statusLabel")}: ${t(`taskDebugger.status.${report.status}`)}`,
    `- ${t("taskDebugger.totalTime")}: ${formatMs(report.totals.wallMs)}`,
    `- ${t("taskDebugger.phase.model")}: ${formatMs(report.totals.modelMs)}`,
    `- ${t("taskDebugger.phase.tool")}: ${formatMs(report.totals.toolMs)} (${report.totals.toolCalls})`,
    `- ${t("taskDebugger.phase.idle")}: ${formatMs(report.totals.idleMs)}`,
  );
  if (report.totals.wastedMs > 0) {
    lines.push(`- ${t("taskDebugger.wasted")}: ${formatMs(report.totals.wastedMs)}`);
  }
  const findings = problemFindings(report);
  if (findings.length) {
    lines.push("", `## ${t("taskDebugger.findings")}`);
    for (const finding of findings) {
      lines.push(
        `- **${t(`taskDebugger.severity.${finding.severity}`)}** ${findingText(finding, t)}`,
      );
    }
  }
  if (report.slowest.length) {
    lines.push("", `## ${t("taskDebugger.slowest")}`);
    for (const step of report.slowest) {
      lines.push(
        `- ${step.label}${step.detail ? ` (${step.detail})` : ""} - ${formatMs(step.durationMs)} (${formatShare(step.share)})`,
      );
    }
  }
  if (report.failures.length) {
    lines.push("", `## ${t("taskDebugger.failures")}`);
    for (const failure of report.failures) {
      lines.push(`- ${failure.label}: ${failure.error || t("taskDebugger.unknownError")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderSummary(report, t) {
  const section = element("section", "session-analysis-summary");
  const status = element(
    "span",
    `session-analysis-status session-analysis-status--${report.status}`,
  );
  status.textContent = t(`taskDebugger.status.${report.status}`);
  const headline = element("div", "session-analysis-headline");
  headline.append(status, element("strong", "", formatMs(report.totals.wallMs)));
  section.appendChild(headline);

  const stats = element("div", "session-analysis-stats");
  const rows = [
    [t("taskDebugger.turns"), String(report.totals.turns)],
    [t("taskDebugger.toolCalls"), String(report.totals.toolCalls)],
    [t("taskDebugger.failures"), String(report.totals.failureCount)],
    [t("taskDebugger.wasted"), formatMs(report.totals.wastedMs)],
  ];
  if (report.totals.usage.cost > 0) {
    rows.push([t("taskDebugger.cost"), `$${report.totals.usage.cost.toFixed(4)}`]);
  }
  for (const [label, value] of rows) {
    const stat = element("div", "session-analysis-stat");
    stat.append(
      element("span", "session-analysis-stat-label", label),
      element("span", "session-analysis-stat-value", value),
    );
    stats.appendChild(stat);
  }
  section.appendChild(stats);
  return section;
}

export function renderPhases(report, t) {
  const section = element("section", "session-analysis-section");
  section.appendChild(element("h3", "session-analysis-heading", t("taskDebugger.timeSplit")));

  const bar = element("div", "session-analysis-bar");
  for (const kind of PHASE_ORDER) {
    const phase = report.phases.find((entry) => entry.kind === kind);
    if (!phase || phase.ms <= 0) continue;
    const segment = element(
      "span",
      `session-analysis-bar-segment session-analysis-bar-segment--${kind}`,
    );
    segment.style.flexGrow = String(phase.ms);
    segment.title = `${t(`taskDebugger.phase.${kind}`)} ${formatMs(phase.ms)}`;
    bar.appendChild(segment);
  }
  if (!bar.childElementCount) bar.appendChild(element("span", "session-analysis-bar-empty"));
  section.appendChild(bar);

  const legend = element("ul", "session-analysis-legend");
  for (const kind of PHASE_ORDER) {
    const phase = report.phases.find((entry) => entry.kind === kind);
    if (!phase) continue;
    const item = element(
      "li",
      `session-analysis-legend-item session-analysis-legend-item--${kind}`,
    );
    item.append(
      element("span", "session-analysis-legend-label", t(`taskDebugger.phase.${kind}`)),
      element(
        "span",
        "session-analysis-legend-value",
        `${formatMs(phase.ms)} · ${formatShare(phase.share)}`,
      ),
    );
    legend.appendChild(item);
  }
  section.appendChild(legend);
  return section;
}

export function renderFindings(report, t) {
  const findings = problemFindings(report);
  if (!findings.length) return null;
  const section = element("section", "session-analysis-section");
  section.appendChild(element("h3", "session-analysis-heading", t("taskDebugger.findings")));
  const list = element("ul", "session-analysis-findings");
  for (const finding of findings) {
    const item = element(
      "li",
      `session-analysis-finding session-analysis-finding--${finding.severity}`,
    );
    item.append(
      element(
        "span",
        "session-analysis-finding-severity",
        t(`taskDebugger.severity.${finding.severity}`),
      ),
      element("span", "session-analysis-finding-text", findingText(finding, t)),
    );
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
}

export function renderSteps(report, t) {
  if (!report.slowest.length) return null;
  const section = element("section", "session-analysis-section");
  section.appendChild(element("h3", "session-analysis-heading", t("taskDebugger.slowest")));
  const list = element("ol", "session-analysis-steps");
  for (const step of report.slowest) {
    list.appendChild(stepRow(step, t));
  }
  section.appendChild(list);
  return section;
}

function stepDetail(step, t) {
  if (step.detail) return step.detail;
  if (step.kind === "model" && step.toolNames?.length) {
    return t("taskDebugger.stepToolCalls", { tools: step.toolNames.join(", ") });
  }
  if (step.kind === "model") return t("taskDebugger.stepNoOutput");
  return "";
}

function stepRow(step, t) {
  const item = element("li", `session-analysis-step session-analysis-step--${step.status}`);
  const head = element("div", "session-analysis-step-head");
  head.append(
    element("span", "session-analysis-step-label", step.label),
    element("span", "session-analysis-step-duration", formatMs(step.durationMs)),
  );
  item.appendChild(head);
  const detail = stepDetail(step, t);
  if (detail) item.appendChild(element("div", "session-analysis-step-detail", detail));
  if (step.error) item.appendChild(element("div", "session-analysis-step-error", step.error));
  if (step.status === "unfinished") {
    item.appendChild(
      element("div", "session-analysis-step-error", t("taskDebugger.neverFinished")),
    );
  }
  return item;
}
