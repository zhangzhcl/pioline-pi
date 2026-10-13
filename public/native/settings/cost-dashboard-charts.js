// 成本仪表盘格式化工具与 Chart.js 图表渲染逻辑。
import {
  buildModelSummary,
  escapeHtml,
  formatUsd,
  mountModelsBarChart,
  renderCostDoughnutChart,
} from "../../cost/infobar-charts.js";
import { getLocale } from "../../i18n.js";

export { buildModelSummary, escapeHtml, formatUsd };

const intFormatters = new Map();
const compactFormatters = new Map();

function getIntFormatter(locale) {
  const key = locale || "default";
  let formatter = intFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale);
    intFormatters.set(key, formatter);
  }
  return formatter;
}

function getCompactFormatter(locale) {
  const key = locale || "default";
  let formatter = compactFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      notation: "compact",
      maximumFractionDigits: 1,
    });
    compactFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatInt(value) {
  return getIntFormatter(getLocale()).format(Number(value || 0));
}

export function formatCompact(value) {
  return getCompactFormatter(getLocale()).format(Number(value || 0));
}

function replaceWithUnavailableState(canvas) {
  canvas.replaceWith(
    Object.assign(document.createElement("div"), {
      className: "cost-dash-empty-state",
      textContent: "Chart unavailable in this environment.",
    }),
  );
}

export function renderModelsChart(canvas, modelSummary) {
  mountModelsBarChart(canvas, modelSummary, formatCompact, () => {
    replaceWithUnavailableState(canvas);
  });
}

export function renderProjectsChart(canvas, rows) {
  renderCostDoughnutChart(canvas, rows, "_projectsChart", () => {
    replaceWithUnavailableState(canvas);
  });
}

export function renderToolCostChart(canvas, tools) {
  renderCostDoughnutChart(canvas, tools, "_toolCostChart", (data, colors) => {
    const total = data.reduce((sum, value) => sum + value, 0);
    const conicStops = data.reduce(
      (parts, value, index) => {
        const start = parts.offset;
        const end = total > 0 ? start + (value / total) * 360 : start;
        parts.values.push(`${colors[index]} ${start}deg ${end}deg`);
        parts.offset = end;
        return parts;
      },
      { values: [], offset: 0 },
    );

    canvas.replaceWith(
      Object.assign(document.createElement("div"), {
        className: "cost-dash-tool-chart-fallback",
        style: `background: conic-gradient(${conicStops.values.join(", ")});`,
      }),
    );
  });
}
