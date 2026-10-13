// ABOUTME: Chart.js and CSS fallback renderers for cost dashboard bar and
// doughnut charts, plus model token summary aggregation.

import { t } from "../i18n.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function formatUsd(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

export function formatInt(value) {
  return Number(value || 0).toLocaleString();
}

export function formatCompact(value) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(value || 0));
}

export function formatHourLabel(hour) {
  if (!Number.isFinite(hour)) return t("cost.notAvailable");
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12} ${suffix}`;
}

export function renderEmpty(target, message = t("cost.noDataInSelectedRange")) {
  target.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}

export function buildModelSummary(rows, payload) {
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const topModels = rows.slice(0, 3).map((row) => ({
    name: row.name || t("cost.unknown"),
    fraction: Number(row.fraction || 0),
    inputTokens: 0,
    outputTokens: 0,
  }));
  const modelNames = new Set(topModels.map((model) => model.name));
  const byDay = new Map();

  for (const session of sessions) {
    const modelName = session.model || t("cost.unknown");
    if (!modelNames.has(modelName)) continue;
    const time = new Date(session.time);
    if (!Number.isFinite(time.getTime())) continue;
    const dayKey = time.toISOString().slice(0, 10);
    let day = byDay.get(dayKey);
    if (!day) {
      day = Object.create(null);
      byDay.set(dayKey, day);
    }
    day[modelName] = (day[modelName] || 0) + Number(session.totalTokens || 0);
    const summary = topModels.find((model) => model.name === modelName);
    if (summary) {
      summary.inputTokens += Number(session.inputTokens || 0);
      summary.outputTokens += Number(session.outputTokens || 0);
    }
  }

  const labels = Array.from(byDay.keys()).sort();
  return {
    labels,
    models: topModels,
    series: topModels.map((model) => ({
      name: model.name,
      data: labels.map((label) => Number(byDay.get(label)?.[model.name] || 0)),
    })),
  };
}

function getModelChartPalette() {
  return ["#3b82f6", "#10b981", "#f59e0b"];
}

function getStackSegmentRadius(seriesList, datasetIndex, dataIndex) {
  const activeIndices = seriesList
    .map((series, index) => ({ index, value: Number(series.data?.[dataIndex] || 0) }))
    .filter((entry) => entry.value > 0)
    .map((entry) => entry.index);

  if (activeIndices.length === 0 || !activeIndices.includes(datasetIndex)) {
    return 0;
  }

  const first = activeIndices[0];
  const last = activeIndices[activeIndices.length - 1];

  if (first === last) {
    return { topLeft: 6, topRight: 6, bottomLeft: 6, bottomRight: 6 };
  }

  if (datasetIndex === first) {
    return { topLeft: 0, topRight: 0, bottomLeft: 6, bottomRight: 6 };
  }

  if (datasetIndex === last) {
    return { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 };
  }

  return 0;
}

export function mountModelsBarChart(canvas, modelSummary, formatCompactFn, onFallback) {
  if (!canvas || !modelSummary) return;
  const colors = getModelChartPalette();
  if (typeof window.Chart === "function") {
    const previous = canvas._modelsChart;
    if (previous && typeof previous.destroy === "function") {
      previous.destroy();
    }
    canvas._modelsChart = new window.Chart(canvas, {
      type: "bar",
      data: {
        labels: modelSummary.labels,
        datasets: modelSummary.series.map((series, index) => ({
          label: series.name,
          data: series.data,
          backgroundColor: colors[index] || colors[colors.length - 1],
          borderRadius(context) {
            return getStackSegmentRadius(modelSummary.series, index, context.dataIndex);
          },
          borderSkipped: false,
          maxBarThickness: 30,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            callbacks: {
              label(context) {
                return t("cost.chartTooltipTokens", {
                  label: context.dataset.label,
                  tokens: formatCompactFn(context.raw),
                });
              },
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            grid: {
              display: false,
            },
            border: {
              display: false,
            },
            ticks: {
              color: "#8f959e",
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 8,
            },
          },
          y: {
            stacked: true,
            grid: {
              color: "rgba(255,255,255,0.08)",
            },
            border: {
              display: false,
            },
            ticks: {
              color: "#8f959e",
              callback(value) {
                return formatCompactFn(value);
              },
            },
          },
        },
      },
    });
    return;
  }

  onFallback(colors);
}

export function renderModelsChart(canvas, modelSummary) {
  mountModelsBarChart(canvas, modelSummary, formatCompact, (colors) => {
    renderModelsChartFallback(canvas, modelSummary, colors);
  });
}

function renderModelsChartFallback(canvas, modelSummary, colors) {
  const labels = modelSummary.labels.length > 0 ? modelSummary.labels : ["Total"];
  const series =
    modelSummary.labels.length > 0
      ? modelSummary.series
      : modelSummary.models.map((model) => ({
          name: model.name,
          data: [Number(model.inputTokens || 0) + Number(model.outputTokens || 0)],
        }));
  const totals = labels.map((_, dataIndex) =>
    series.reduce((sum, item) => sum + Number(item.data?.[dataIndex] || 0), 0),
  );
  const maxTotal = Math.max(...totals, 0);

  if (maxTotal <= 0) {
    canvas.replaceWith(
      Object.assign(document.createElement("div"), {
        className: "empty",
        textContent: "No model token history in selected range.",
      }),
    );
    return;
  }

  const chart = document.createElement("div");
  chart.className = "infobar-models-chart-fallback";
  chart.innerHTML = labels
    .map((label, dataIndex) => {
      const total = totals[dataIndex];
      const height = Math.max(4, (total / maxTotal) * 100);
      const segments = series
        .map((item, seriesIndex) => ({
          color: colors[seriesIndex] || colors[colors.length - 1],
          name: item.name,
          value: Number(item.data?.[dataIndex] || 0),
        }))
        .filter((item) => item.value > 0)
        .map((item) => {
          const basis = total > 0 ? (item.value / total) * 100 : 0;
          return `<span class="infobar-models-fallback-segment" style="flex-basis:${basis}%;background:${item.color}" title="${escapeHtml(t("cost.chartTooltipTokens", { label: item.name, tokens: formatCompact(item.value) }))}"></span>`;
        })
        .join("");
      return `
        <div class="infobar-models-fallback-column">
          <div class="infobar-models-fallback-track">
            <div class="infobar-models-fallback-bar" style="height:${height}%">${segments}</div>
          </div>
          <div class="infobar-models-fallback-label">${escapeHtml(formatChartDateLabel(label))}</div>
        </div>
      `;
    })
    .join("");
  canvas.replaceWith(chart);
}

function formatChartDateLabel(label) {
  if (label === "Total") return label;
  const date = new Date(`${label}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return label;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function getToolChartPalette() {
  return ["#4f8ff7", "#67c587", "#f3a64f", "#8c7cf7", "#ef6b73", "#4fc3d9"];
}

export function renderCostDoughnutChart(
  canvas,
  items,
  chartProp,
  onFallback = (data, colors) => renderDoughnutFallback(canvas, data, colors),
) {
  if (!canvas || !Array.isArray(items) || items.length === 0) return;
  const labels = items.map((item) => item.name || t("cost.unknown"));
  const data = items.map((item) => Number(item.cost || 0));
  const colors = getToolChartPalette().slice(0, items.length);

  if (typeof window.Chart === "function") {
    const previous = canvas[chartProp];
    if (previous && typeof previous.destroy === "function") {
      previous.destroy();
    }
    canvas[chartProp] = new window.Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data,
            backgroundColor: colors,
            borderWidth: 0,
            hoverOffset: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "62%",
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            callbacks: {
              label(context) {
                return t("cost.chartTooltipCost", {
                  label: context.label,
                  cost: formatUsd(context.raw),
                });
              },
            },
          },
        },
      },
    });
    return;
  }

  onFallback(data, colors);
}

export function renderProjectsChart(canvas, rows) {
  renderCostDoughnutChart(canvas, rows, "_projectsChart");
}

export function renderToolCostChart(canvas, tools) {
  renderCostDoughnutChart(canvas, tools, "_toolCostChart");
}

function renderDoughnutFallback(canvas, data, colors) {
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
  const background =
    conicStops.values.length > 0 ? conicStops.values.join(", ") : "#d8d3ca 0deg 360deg";

  canvas.replaceWith(
    Object.assign(document.createElement("div"), {
      className: "infobar-tool-chart-fallback",
      style: `background: radial-gradient(circle, var(--bg-solid, #f4f1ec) 0 54%, transparent 55%), conic-gradient(${background});`,
    }),
  );
}
