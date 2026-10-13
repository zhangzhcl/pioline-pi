// ABOUTME: Activity calendar heatmap, session table, and overview streak/metric
// derivation for the cost infobar dashboard.

import { t } from "../i18n.js";
import {
  escapeHtml,
  formatCompact,
  formatHourLabel,
  formatInt,
  formatUsd,
  renderEmpty,
} from "./infobar-charts.js";

function formatSessionDate(timeStr) {
  if (!timeStr) return "";
  const d = new Date(timeStr);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function renderSessionsPanel(target, sessions = []) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    renderEmpty(target, t("cost.noRecentSessions"));
    return;
  }
  target.innerHTML = `
    <div class="infobar-sessions-table-wrap">
      <table class="infobar-sessions-table">
        <thead>
          <tr>
            <th>${escapeHtml(t("cost.table.session"))}</th>
            <th>${escapeHtml(t("cost.table.model"))}</th>
            <th class="num">${escapeHtml(t("cost.table.tokens"))}</th>
            <th class="num">${escapeHtml(t("cost.table.tools"))}</th>
            <th class="num">${escapeHtml(t("cost.table.cost"))}</th>
            <th>${escapeHtml(t("cost.table.date"))}</th>
          </tr>
        </thead>
        <tbody>
          ${sessions
            .map(
              (session) => `
            <tr>
              <td class="infobar-sessions-td-title">
                <div class="infobar-sessions-title">${escapeHtml(session.title || t("cost.untitled"))}</div>
                ${session.workspace ? `<div class="infobar-sessions-workspace">${escapeHtml(session.workspace)}</div>` : ""}
              </td>
              <td class="infobar-sessions-td-model">${escapeHtml(session.model || "—")}</td>
              <td class="num">${formatCompact(session.totalTokens)}</td>
              <td class="num">${formatInt(session.toolCalls)}</td>
              <td class="num infobar-sessions-cost">${formatUsd(session.totalCost)}</td>
              <td class="infobar-sessions-td-date">${formatSessionDate(session.time)}</td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

export function deriveOverviewMetrics(payload, overview) {
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const dayCounts = new Map();
  const hourCounts = new Map();
  const modelCounts = new Map();

  for (const session of sessions) {
    const time = new Date(session.time);
    if (!Number.isFinite(time.getTime())) continue;
    const dayKey = time.toISOString().slice(0, 10);
    dayCounts.set(dayKey, (dayCounts.get(dayKey) || 0) + 1);
    hourCounts.set(time.getHours(), (hourCounts.get(time.getHours()) || 0) + 1);
    if (session.model) {
      modelCounts.set(session.model, (modelCounts.get(session.model) || 0) + 1);
    }
  }

  const sortedDays = Array.from(dayCounts.keys()).sort();
  let longestStreak = 0;
  let currentStreak = 0;
  let streak = 0;
  let previousDate = null;

  for (const key of sortedDays) {
    const currentDate = new Date(`${key}T00:00:00`);
    if (previousDate) {
      const diffDays = Math.round((currentDate - previousDate) / 86400000);
      streak = diffDays === 1 ? streak + 1 : 1;
    } else {
      streak = 1;
    }
    longestStreak = Math.max(longestStreak, streak);
    previousDate = currentDate;
  }

  if (sortedDays.length > 0) {
    const todayKey = new Date().toISOString().slice(0, 10);
    const cursor = new Date(`${todayKey}T00:00:00`);
    while (dayCounts.has(cursor.toISOString().slice(0, 10))) {
      currentStreak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
  }

  const peakHourEntry =
    Array.from(hourCounts.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] || null;
  const favoriteModelEntry =
    Array.from(modelCounts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ||
    null;

  return {
    totalCost: overview.totalCost || payload.summary?.totalCost || 0,
    sessions: overview.sessionCount || sessions.length,
    messages: overview.messageCount || 0,
    totalTokens: payload.summary?.totalTokens || 0,
    activeDays: overview.daysActive || sortedDays.length,
    currentStreak,
    longestStreak,
    peakHour: peakHourEntry ? formatHourLabel(peakHourEntry[0]) : t("cost.notAvailable"),
    favoriteModel: favoriteModelEntry?.[0] || t("cost.notAvailable"),
  };
}

export function renderActivityPanel(target, payload) {
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const intensityByDay = new Map();
  for (const session of sessions) {
    const time = new Date(session.time);
    if (!Number.isFinite(time.getTime())) continue;
    const key = time.toISOString().slice(0, 10);
    intensityByDay.set(key, (intensityByDay.get(key) || 0) + Number(session.totalTokens || 0));
  }

  const TOTAL_DAYS = 365;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = TOTAL_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, value: intensityByDay.get(key) || 0 });
  }

  const max = Math.max(...days.map((day) => day.value), 0);
  const leadingEmptyDays = new Date(`${days[0]?.key}T00:00:00`).getDay();
  const totalCells = leadingEmptyDays + days.length;
  const weekColumns = Math.ceil(totalCells / 7);
  const monthLabels = buildActivityMonthLabels(days, leadingEmptyDays);
  const emptyCells = Array.from(
    { length: leadingEmptyDays },
    () => '<div class="infobar-activity-cell is-empty" aria-hidden="true"></div>',
  ).join("");
  const weekdayMonday = escapeHtml(t("cost.activity.monday"));
  const weekdayWednesday = escapeHtml(t("cost.activity.wednesday"));
  const weekdayFriday = escapeHtml(t("cost.activity.friday"));
  const activityLess = escapeHtml(t("cost.activity.less"));
  const activityMore = escapeHtml(t("cost.activity.more"));

  target.innerHTML = `
    <div class="infobar-activity-calendar" style="--activity-columns:${weekColumns}">
      <div class="infobar-activity-months" aria-hidden="true">
        ${monthLabels
          .map(
            (label) =>
              `<span class="infobar-activity-month" style="grid-column:${label.column}">${escapeHtml(label.name)}</span>`,
          )
          .join("")}
      </div>
      <div class="infobar-activity-body">
        <div class="infobar-activity-weekdays" aria-hidden="true">
          <span></span>
          <span>${weekdayMonday}</span>
          <span></span>
          <span>${weekdayWednesday}</span>
          <span></span>
          <span>${weekdayFriday}</span>
          <span></span>
        </div>
        <div class="infobar-activity-grid">
          ${emptyCells}${days
            .map((day) => {
              let level = 0;
              if (max > 0) {
                const ratio = day.value / max;
                if (ratio >= 0.75) level = 4;
                else if (ratio >= 0.5) level = 3;
                else if (ratio >= 0.25) level = 2;
                else if (ratio > 0) level = 1;
              }
              return `<div class="infobar-activity-cell level-${level}" title="${escapeHtml(t("cost.activityCellTitle", { date: day.key, tokens: formatCompact(day.value) }))}"></div>`;
            })
            .join("")}
        </div>
      </div>
      <div class="infobar-activity-footer">
        <span>${activityLess}</span>
        <span class="infobar-activity-cell level-0" aria-hidden="true"></span>
        <span class="infobar-activity-cell level-1" aria-hidden="true"></span>
        <span class="infobar-activity-cell level-2" aria-hidden="true"></span>
        <span class="infobar-activity-cell level-3" aria-hidden="true"></span>
        <span class="infobar-activity-cell level-4" aria-hidden="true"></span>
        <span>${activityMore}</span>
      </div>
    </div>
  `;
}

function buildActivityMonthLabels(days, leadingEmptyDays) {
  const labels = [];
  const seen = new Set();
  for (let index = 0; index < days.length; index += 1) {
    const date = new Date(`${days[index].key}T00:00:00`);
    if (!Number.isFinite(date.getTime())) continue;
    const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
    if (seen.has(monthKey)) continue;
    seen.add(monthKey);
    labels.push({
      column: Math.floor((leadingEmptyDays + index) / 7) + 1,
      name: date.toLocaleDateString(undefined, { month: "short" }),
    });
  }
  return labels;
}

export function renderOverviewNote(target, totalTokens) {
  const warAndPeaceTokens = 587000;
  const ratio = Math.max(1, Math.round(Number(totalTokens || 0) / warAndPeaceTokens));
  target.textContent = t("cost.overviewNote", { ratio });
}
