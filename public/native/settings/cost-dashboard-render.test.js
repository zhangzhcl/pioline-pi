import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLocale } from "../../i18n.js";
import { renderCostDashboard } from "./cost-dashboard-render.js";

const localeDir = resolve(import.meta.dirname, "..", "..", "locales");

function readLocaleMessages(locale) {
  try {
    const content = readFileSync(resolve(localeDir, `${locale}.json`), "utf-8");
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to load ${locale}.json fixture: ${error?.message || error}`);
  }
}

const enMessages = readLocaleMessages("en");
const zhMessages = readLocaleMessages("zh");

function clearLanguageCookie() {
  document.cookie = "picot-language=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}

function buildDashboardSection() {
  const section = document.createElement("section");
  for (const id of [
    "cost-dash-overview-grid",
    "cost-dash-activity-panel",
    "cost-dash-overview-note",
    "cost-dash-models-list",
    "cost-dash-tool-cost-panel",
    "cost-dash-projects-list",
    "cost-dash-sessions-panel",
  ]) {
    const element = document.createElement("div");
    element.id = id;
    section.appendChild(element);
  }
  return section;
}

beforeEach(async () => {
  clearLanguageCookie();
  vi.spyOn(global, "fetch").mockImplementation((url) => {
    const path = String(url);
    const body = path.includes("/locales/zh.json")
      ? zhMessages
      : path.includes("/locales/en.json")
        ? enMessages
        : {};
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  });
  await initI18n();
  await setLocale("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.Chart;
});

describe("cost dashboard renderers", () => {
  it("renders overview cards", () => {
    const section = buildDashboardSection();
    renderCostDashboard(section, {
      infobar: {
        overview: { totalCost: 9, sessionCount: 7, messageCount: 22, daysActive: 4 },
        usage: {
          inputTokens: 2000,
          outputTokens: 1000,
          cacheRead: 400,
          cacheWrite: 150,
          toolCalls: 6,
        },
      },
      summary: { totalTokens: 3550 },
      sessions: [],
    });

    expect(section.querySelectorAll("#cost-dash-overview-grid .cost-dash-stat-card")).toHaveLength(
      12,
    );
    expect(section.querySelector("#cost-dash-overview-grid").textContent).toContain("Total cost");
    expect(section.querySelector("#cost-dash-overview-grid").textContent).toContain("$9.00");
    expect(section.querySelector("#cost-dash-overview-grid").textContent).not.toContain(
      "Peak hour",
    );
    expect(section.querySelector("#cost-dash-overview-grid").textContent).toContain("Sessions");
    expect(section.querySelector("#cost-dash-overview-grid").textContent).toContain("Messages");
    expect(section.querySelector("#cost-dash-overview-grid").textContent).toContain("Tool Calls");
  });

  it("renders ranked model and project rows plus usage totals", () => {
    const section = buildDashboardSection();
    window.Chart = function MockChart() {
      return { destroy() {} };
    };
    renderCostDashboard(section, {
      infobar: {
        overview: { sessionCount: 2 },
        models: [
          { name: "gpt-4.1", cost: 7.5, count: 2, fraction: 1 },
          { name: "gpt-4.1-mini", cost: 1.5, count: 1, fraction: 0.2 },
        ],
        projects: [
          { name: "pi-alpha", path: "/work/pi-alpha", cost: 7.5, sessions: 2, fraction: 1 },
        ],
        usage: {
          totalTokens: 3550,
          inputTokens: 2000,
          outputTokens: 1000,
          cacheRead: 400,
          cacheWrite: 150,
          toolCalls: 6,
          tools: [
            { name: "read_file", count: 2, cost: 1.6, fraction: 1 },
            { name: "edit_file", count: 2, cost: 1.4, fraction: 0.875 },
          ],
        },
      },
      summary: { totalTokens: 3550 },
      sessions: [
        {
          model: "gpt-4.1",
          time: "2026-06-05T10:00:00.000Z",
          totalTokens: 3200,
          inputTokens: 2000,
          outputTokens: 900,
        },
        {
          model: "gpt-4.1-mini",
          time: "2026-06-06T10:00:00.000Z",
          totalTokens: 1200,
          inputTokens: 600,
          outputTokens: 400,
        },
      ],
    });

    expect(section.querySelectorAll(".cost-dash-model-legend-row")).toHaveLength(2);
    expect(section.querySelector(".cost-dash-projects-chart")).not.toBeNull();
    expect(section.querySelector("#cost-dash-overview-grid").textContent).toContain("Total tokens");
    expect(section.querySelector("#cost-dash-tool-cost-panel").textContent).toContain("read_file");
    expect(section.querySelector("#cost-dash-tool-cost-panel").textContent).toContain("edit_file");
  });

  it("uses the same model palette for chart bars and legend dots", () => {
    const section = buildDashboardSection();
    const chartCalls = [];
    window.Chart = function MockChart(_canvas, config) {
      chartCalls.push(config);
      return { destroy() {} };
    };
    renderCostDashboard(section, {
      infobar: {
        overview: { sessionCount: 3 },
        models: [
          { name: "claude-sonnet-4-6", cost: 7.5, count: 2, fraction: 1 },
          { name: "claude-opus-4-7", cost: 3.1, count: 1, fraction: 0.4 },
          { name: "claude-opus-4-8", cost: 1.2, count: 1, fraction: 0.16 },
        ],
      },
      summary: { totalTokens: 5300 },
      sessions: [
        {
          model: "claude-sonnet-4-6",
          time: "2026-06-05T10:00:00.000Z",
          totalTokens: 3200,
          inputTokens: 2000,
          outputTokens: 900,
        },
        {
          model: "claude-opus-4-7",
          time: "2026-06-06T10:00:00.000Z",
          totalTokens: 1200,
          inputTokens: 600,
          outputTokens: 400,
        },
        {
          model: "claude-opus-4-8",
          time: "2026-06-07T10:00:00.000Z",
          totalTokens: 900,
          inputTokens: 500,
          outputTokens: 300,
        },
      ],
    });

    const barChart = chartCalls.find((config) => config.type === "bar");
    expect(barChart).toBeDefined();
    const datasets = barChart.data.datasets;
    expect(datasets[0].backgroundColor).toBe("#3b82f6");
    expect(datasets[1].backgroundColor).toBe("#10b981");
    expect(datasets[2].backgroundColor).toBe("#f59e0b");
    expect(datasets[0].borderRadius({ dataIndex: 0 })).toEqual({
      topLeft: 6,
      topRight: 6,
      bottomLeft: 6,
      bottomRight: 6,
    });
    expect(datasets[1].borderRadius({ dataIndex: 0 })).toBe(0);
  });

  it("renders chart fallbacks when Chart.js is unavailable", () => {
    const section = buildDashboardSection();
    renderCostDashboard(section, {
      infobar: {
        overview: { sessionCount: 2 },
        models: [
          { name: "claude-sonnet-4-6", cost: 7.5, count: 2, fraction: 1 },
          { name: "gpt-5.5", cost: 3.1, count: 1, fraction: 0.4 },
        ],
        projects: [
          { name: "pi-alpha", path: "/work/pi-alpha", cost: 7.5, sessions: 2, fraction: 1 },
          { name: "pi-beta", path: "/work/pi-beta", cost: 2.5, sessions: 1, fraction: 0.33 },
        ],
        usage: {
          tools: [{ name: "read_file", count: 2, cost: 1.6, fraction: 1 }],
        },
      },
      sessions: [
        {
          model: "claude-sonnet-4-6",
          time: "2026-06-05T10:00:00.000Z",
          totalTokens: 3200,
          inputTokens: 2000,
          outputTokens: 900,
        },
        {
          model: "gpt-5.5",
          time: "2026-06-06T10:00:00.000Z",
          totalTokens: 1200,
          inputTokens: 600,
          outputTokens: 400,
        },
      ],
    });

    expect(section.querySelector("#cost-dash-models-list").textContent).toContain(
      "Chart unavailable in this environment.",
    );
    expect(section.querySelector("#cost-dash-projects-list").textContent).toContain(
      "Chart unavailable in this environment.",
    );
    const toolFallback = section.querySelector(
      "#cost-dash-tool-cost-panel .cost-dash-tool-chart-fallback",
    );
    expect(toolFallback).not.toBeNull();
    expect(toolFallback.className).toBe("cost-dash-tool-chart-fallback");
  });

  it("renders the single-page dashboard sections including sessions", () => {
    const section = buildDashboardSection();
    renderCostDashboard(section, {
      range: {
        range: "30d",
        scope: "all",
        from: "2026-05-11T00:00:00.000Z",
        to: "2026-06-06T00:00:00.000Z",
      },
      series: [
        { bucket: "2026-06-05", cost: 2.4, tokens: 1000 },
        { bucket: "2026-06-06", cost: 5.1, tokens: 3000 },
      ],
      sessions: [
        {
          title: "Session 1",
          workspace: "/work/pi-alpha",
          model: "gpt-4.1",
          time: "2026-05-18T10:00:00.000Z",
          totalCost: 1.2,
          totalTokens: 900,
          toolCalls: 1,
          userMessages: 1,
          assistantMessages: 1,
        },
        {
          title: "Session 2",
          workspace: "/work/pi-alpha",
          model: "gpt-4.1",
          time: "2026-06-06T10:00:00.000Z",
          totalCost: 4.2,
          totalTokens: 3200,
          toolCalls: 6,
          userMessages: 2,
          assistantMessages: 2,
        },
        {
          title: "Session 3",
          workspace: "/work/pi-beta",
          model: "gpt-4.1-mini",
          time: "2026-06-05T08:30:00.000Z",
          totalCost: 2.4,
          totalTokens: 1400,
          toolCalls: 3,
          userMessages: 2,
          assistantMessages: 2,
        },
      ],
      summary: {
        totalTokens: 5500,
      },
      infobar: {
        overview: {
          totalCost: 9,
          sessionCount: 7,
          messageCount: 22,
          daysActive: 4,
        },
        models: [{ name: "gpt-4.1", cost: 7.5, count: 2, fraction: 1 }],
        projects: [
          { name: "pi-alpha", path: "/work/pi-alpha", cost: 7.5, sessions: 2, fraction: 1 },
        ],
        usage: {
          totalTokens: 3550,
          inputTokens: 2000,
          outputTokens: 1000,
          cacheRead: 400,
          cacheWrite: 150,
          toolCalls: 6,
          tools: [{ name: "read_file", count: 2, cost: 1.6, fraction: 1 }],
        },
      },
    });

    expect(section.querySelectorAll("#cost-dash-overview-grid .cost-dash-stat-card")).toHaveLength(
      12,
    );
    expect(section.querySelector("#cost-dash-overview-grid").textContent).toContain("Total cost");
    expect(section.querySelector("#cost-dash-overview-grid").textContent).toContain("$9.00");
    expect(section.querySelector("#cost-dash-overview-grid").textContent).not.toContain(
      "Peak hour",
    );
    expect(
      section.querySelector("#cost-dash-activity-panel .cost-dash-activity-months").textContent,
    ).toContain("May");
    expect(
      section.querySelector("#cost-dash-activity-panel .cost-dash-activity-weekdays").textContent,
    ).toContain("Mon");
    expect(
      section
        .querySelector("#cost-dash-activity-panel")
        .querySelectorAll(".cost-dash-activity-cell").length,
    ).toBeGreaterThan(0);
    expect(
      section.querySelector("#cost-dash-activity-panel .cost-dash-activity-footer").textContent,
    ).toContain("More");
    expect(section.querySelector("#cost-dash-overview-note").textContent).toContain(
      "War and Peace",
    );
    expect(section.querySelector("#cost-dash-models-list").textContent).toContain("gpt-4.1");
    expect(section.querySelector("#cost-dash-tool-cost-panel").textContent).toContain("read_file");
    expect(section.querySelector("#cost-dash-sessions-panel").textContent).toContain("Session 1");
  });

  it("renders translated Chinese cost labels after locale switch", async () => {
    await setLocale("zh");
    const section = buildDashboardSection();
    renderCostDashboard(section, {
      range: { from: "2026-06-01T00:00:00.000Z", to: "2026-06-02T00:00:00.000Z" },
      sessions: [{ time: "2026-06-01T10:00:00.000Z", totalTokens: 100 }],
      infobar: { overview: { sessionCount: 1 } },
    });

    expect(section.querySelector("#cost-dash-overview-grid").textContent).toContain("总成本");
    expect(section.querySelector("#cost-dash-overview-grid").textContent).toContain("工具调用");
    expect(section.querySelector("#cost-dash-tool-cost-panel").textContent).toContain(
      "所选范围内无工具使用。",
    );
    expect(section.querySelector("#cost-dash-activity-panel").textContent).toContain("周一");
    expect(section.querySelector("#cost-dash-activity-panel").textContent).toContain("较多");
  });
});
