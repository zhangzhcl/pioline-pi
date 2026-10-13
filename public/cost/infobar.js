import { t } from "../i18n.js";
import {
  buildModelSummary,
  escapeHtml,
  formatCompact,
  formatInt,
  formatUsd,
  renderEmpty,
  renderModelsChart,
  renderProjectsChart,
  renderToolCostChart,
} from "./infobar-charts.js";
import {
  deriveOverviewMetrics,
  renderActivityPanel,
  renderOverviewNote,
  renderSessionsPanel,
} from "./infobar-metrics.js";

const STAT_ICONS = {
  totalCost: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 1.5v13M11.5 4H6.75a2.25 2.25 0 0 0 0 4.5h2.5a2.25 2.25 0 0 1 0 4.5H4.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  sessions: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v6A1.5 1.5 0 0 1 12.5 10H9l-3 3v-3H3.5A1.5 1.5 0 0 1 2 8.5v-6z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>`,
  messages: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5l-4 4V3z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><circle cx="5.5" cy="6.5" r="1" fill="currentColor"/><circle cx="8" cy="6.5" r="1" fill="currentColor"/><circle cx="10.5" cy="6.5" r="1" fill="currentColor"/></svg>`,
  totalTokens: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><ellipse cx="8" cy="4" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.25"/><path d="M2.5 4v4c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2V4" stroke="currentColor" stroke-width="1.25"/><path d="M2.5 8v4c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2V8" stroke="currentColor" stroke-width="1.25"/></svg>`,
  activeDays: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="3" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.25"/><path d="M5 1v3M11 1v3M1 7h14" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/><circle cx="5" cy="10.5" r="1" fill="currentColor"/><circle cx="8" cy="10.5" r="1" fill="currentColor"/><circle cx="11" cy="10.5" r="1" fill="currentColor"/></svg>`,
  currentStreak: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 1S4 5 4 9a4 4 0 0 0 8 0c0-4-4-8-4-8z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M8 11.5c-.83 0-1.5-.67-1.5-1.5S8 7.5 8 7.5s1.5 1 1.5 2.5-.67 1.5-1.5 1.5z" fill="currentColor"/></svg>`,
  longestStreak: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 2.5h9v5.5a4.5 4.5 0 0 1-9 0V2.5z" stroke="currentColor" stroke-width="1.25"/><path d="M3.5 5.5H2a1.5 1.5 0 0 0 1.5 1.5M12.5 5.5H14a1.5 1.5 0 0 1-1.5 1.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/><path d="M8 12.5v2M5.5 14.5h5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>`,
  input: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2v9M4.5 7.5 8 11l3.5-3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 13.5h11" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>`,
  output: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 14V5M4.5 8.5 8 5l3.5 3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 2.5h11" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>`,
  cacheRead: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9.5 1.5 5 8.5h4.5L6.5 14.5l6-8.5H8l1.5-4.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>`,
  cacheWrite: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 4a2 2 0 0 1 2-2h6l4 4v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4z" stroke="currentColor" stroke-width="1.25"/><path d="M5 2v3.5h5V2M5 15v-4h6v4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>`,
  toolCalls: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 1.5a3.5 3.5 0 0 1 .5 5.5L4 13.5a1.5 1.5 0 0 1-2-2L8.5 5A3.5 3.5 0 0 1 10 1.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><circle cx="10.5" cy="3.5" r="1" fill="currentColor"/></svg>`,
};

function buildStatCard(id, label, value, tone, extraClass = "") {
  const icon = STAT_ICONS[id] || "";
  return `
    <article class="infobar-stat-card infobar-card-tone-${tone} ${extraClass}">
      <div class="infobar-stat-title">${icon ? `<span class="infobar-stat-icon">${icon}</span>` : ""}${escapeHtml(label)}</div>
      <div class="infobar-stat-value">${escapeHtml(value)}</div>
    </article>
  `;
}

export function renderInfobarOverview(target, overview = {}, usage = {}) {
  const stats = [
    ["totalCost", t("cost.stats.totalCost"), formatUsd(overview.totalCost), "green", ""],
    ["sessions", t("cost.stats.sessions"), formatInt(overview.sessions), "blue", ""],
    ["messages", t("cost.stats.messages"), formatInt(overview.messages), "violet", ""],
    ["totalTokens", t("cost.stats.totalTokens"), formatCompact(overview.totalTokens), "teal", ""],
    ["activeDays", t("cost.stats.activeDays"), formatInt(overview.activeDays), "amber", ""],
    [
      "currentStreak",
      t("cost.stats.currentStreak"),
      t("cost.daysShort", { count: formatInt(overview.currentStreak) }),
      "blue",
      "",
    ],
    [
      "longestStreak",
      t("cost.stats.longestStreak"),
      t("cost.daysShort", { count: formatInt(overview.longestStreak) }),
      "violet",
      "",
    ],
    ["input", t("cost.stats.input"), formatCompact(usage.inputTokens), "teal", ""],
    ["output", t("cost.stats.output"), formatCompact(usage.outputTokens), "green", ""],
    ["cacheRead", t("cost.stats.cacheRead"), formatCompact(usage.cacheRead), "amber", ""],
    ["cacheWrite", t("cost.stats.cacheWrite"), formatCompact(usage.cacheWrite), "violet", ""],
    ["toolCalls", t("cost.stats.toolCalls"), formatInt(usage.toolCalls), "rose", ""],
  ];
  target.innerHTML = stats
    .map(([id, label, value, tone, extraClass]) =>
      buildStatCard(id, label, value, tone, extraClass),
    )
    .join("");
}

export function renderInfobarModels(target, rows = [], payload = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    renderEmpty(target);
    return;
  }
  const modelSummary = buildModelSummary(rows, payload);
  target.innerHTML = `
    <div class="infobar-models-card">
      <div class="infobar-models-chart-wrap">
        <canvas class="infobar-models-chart" width="960" height="320"></canvas>
      </div>
      <div class="infobar-models-legend">
        ${modelSummary.models
          .map((model, index) => {
            const percent = Math.round((model.fraction || 0) * 1000) / 10;
            return `
              <div class="infobar-model-legend-row">
                <div class="infobar-model-legend-main">
                  <span class="infobar-tool-legend-dot infobar-model-color-${index + 1}"></span>
                  <span class="infobar-model-legend-name">${escapeHtml(model.name)}</span>
                </div>
                <div class="infobar-model-legend-meta">
                  <span>${escapeHtml(t("cost.modelTokens", { input: formatCompact(model.inputTokens), output: formatCompact(model.outputTokens) }))}</span>
                  <span>${percent}%</span>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
  renderModelsChart(target.querySelector(".infobar-models-chart"), modelSummary);
}

export function renderInfobarProjects(target, rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    renderEmpty(target);
    return;
  }
  const top = rows.slice(0, 6);
  const totalCost = top.reduce((sum, r) => sum + Number(r.cost || 0), 0);
  target.innerHTML = `
    <div class="infobar-projects-card">
      <div class="infobar-tool-chart-layout">
        <div class="infobar-tool-chart-wrap">
          <canvas class="infobar-projects-chart" width="240" height="240"></canvas>
        </div>
        <div class="infobar-tool-legend">
          ${top
            .map((row, index) => {
              const percent =
                totalCost > 0 ? Math.round((Number(row.cost || 0) / totalCost) * 100) : 0;
              return `
                <div class="infobar-tool-legend-row">
                  <div class="infobar-tool-legend-main">
                    <span class="infobar-tool-legend-dot" data-tool-color="${index}"></span>
                    <div>
                      <div class="infobar-tool-legend-title">${escapeHtml(row.name || t("cost.unknown"))}</div>
                      <div class="infobar-tool-legend-subtitle">${escapeHtml(t("cost.projectSessions", { count: formatInt(row.sessions || 0) }))}</div>
                    </div>
                  </div>
                  <div class="infobar-tool-legend-values">
                    <span>${formatUsd(row.cost)}</span>
                    <span>${percent}%</span>
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    </div>
  `;
  renderProjectsChart(target.querySelector(".infobar-projects-chart"), top);
}

export function renderInfobarUsage(target, usage = {}) {
  const summaryCards = [
    ["totalTokens", t("cost.stats.totalTokens"), formatCompact(usage.totalTokens), "blue"],
    ["input", t("cost.stats.input"), formatCompact(usage.inputTokens), "teal"],
    ["output", t("cost.stats.output"), formatCompact(usage.outputTokens), "green"],
    ["cacheRead", t("cost.stats.cacheRead"), formatCompact(usage.cacheRead), "amber"],
    ["cacheWrite", t("cost.stats.cacheWrite"), formatCompact(usage.cacheWrite), "violet"],
    ["toolCalls", t("cost.stats.toolCalls"), formatInt(usage.toolCalls), "rose"],
  ];

  target.innerHTML = `
    <div class="infobar-usage-grid">
      ${summaryCards.map(([id, label, value, tone]) => buildStatCard(id, label, value, tone)).join("")}
    </div>
  `;
}

export function renderInfobarToolCost(target, usage = {}, metaTarget = null) {
  const tools = Array.isArray(usage.tools) ? usage.tools : [];
  if (metaTarget) {
    metaTarget.textContent = t("cost.trackedTools", { count: formatInt(tools.length) });
  }
  target.innerHTML = `
    <div class="infobar-tool-cost-card">
      ${
        tools.length > 0
          ? `
        <div class="infobar-tool-chart-layout">
          <div class="infobar-tool-chart-wrap">
            <canvas class="infobar-tool-chart" width="240" height="240"></canvas>
          </div>
          <div class="infobar-tool-legend">
            ${tools
              .slice(0, 6)
              .map((row, index) => {
                const percent = Math.round((row.fraction || 0) * 100);
                return `
                  <div class="infobar-tool-legend-row">
                    <div class="infobar-tool-legend-main">
                      <span class="infobar-tool-legend-dot" data-tool-color="${index}"></span>
                      <div>
                        <div class="infobar-tool-legend-title">${escapeHtml(row.name || t("cost.unknown"))}</div>
                        <div class="infobar-tool-legend-subtitle">${escapeHtml(t("cost.toolSessions", { count: formatInt(row.count) }))}</div>
                      </div>
                    </div>
                    <div class="infobar-tool-legend-values">
                      <span>${formatUsd(row.cost)}</span>
                      <span>${percent}%</span>
                    </div>
                  </div>
                `;
              })
              .join("")}
          </div>
        </div>
      `
          : `<div class="empty">${escapeHtml(t("cost.noToolUsage"))}</div>`
      }
    </div>
  `;

  if (tools.length > 0) {
    renderToolCostChart(target.querySelector(".infobar-tool-chart"), tools.slice(0, 6));
  }
}

export function renderCostInfobar(section, payload = {}) {
  if (!section) return;
  const overviewEl = section.querySelector("#infobar-overview-grid");
  const activityEl = section.querySelector("#infobar-activity-panel");
  const overviewNoteEl = section.querySelector("#infobar-overview-note");
  const modelsEl = section.querySelector("#infobar-models-list");
  const toolCostEl = section.querySelector("#infobar-tool-cost-panel");
  const projectsEl = section.querySelector("#infobar-projects-list");
  const sessionsEl = section.querySelector("#infobar-sessions-panel");
  const titleEl = section.querySelector("#infobar-page-title");

  if (
    !overviewEl ||
    !activityEl ||
    !overviewNoteEl ||
    !modelsEl ||
    !toolCostEl ||
    !projectsEl ||
    !sessionsEl
  ) {
    return;
  }

  const infobar = payload.infobar || payload || {};
  const overview = infobar.overview || {};
  const hasData = Number(overview.sessionCount || 0) > 0;
  if (titleEl) {
    titleEl.textContent = t("cost.overview");
  }
  if (!hasData) {
    renderEmpty(overviewEl);
    renderEmpty(activityEl);
    overviewNoteEl.textContent = "";
    renderEmpty(modelsEl);
    renderEmpty(toolCostEl);
    renderEmpty(projectsEl);
    renderEmpty(sessionsEl);
    return;
  }

  const overviewMetrics = deriveOverviewMetrics(payload, overview);
  renderInfobarOverview(overviewEl, overviewMetrics, infobar.usage || {});
  renderActivityPanel(activityEl, payload);
  renderOverviewNote(overviewNoteEl, overviewMetrics.totalTokens);
  renderInfobarModels(modelsEl, infobar.models || [], payload);
  renderInfobarToolCost(toolCostEl, infobar.usage || {});
  renderInfobarProjects(projectsEl, infobar.projects || []);
  renderSessionsPanel(sessionsEl, payload.sessions || payload.topSessions || []);
}
