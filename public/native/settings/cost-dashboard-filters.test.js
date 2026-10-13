import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLocale } from "../../i18n.js";
import { loadCostDashboard } from "./cost-dashboard.js";

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

describe("cost dashboard loader and range filters", () => {
  it("renders the usage dashboard shell and aggregates dashboard data", async () => {
    const container = document.createElement("div");
    const data = {
      costDashboard: vi.fn().mockResolvedValue({
        dashboard: {
          sessions: [
            {
              title: "Session 1",
              workspace: "/work/pi-alpha",
              model: "gpt-4.1",
              time: new Date().toISOString(),
              totalCost: 1.2,
              totalTokens: 900,
              inputTokens: 600,
              outputTokens: 300,
              cacheRead: 0,
              cacheWrite: 0,
              toolCalls: 1,
              userMessages: 1,
              toolCostByName: { read_file: 1.2 },
            },
          ],
        },
      }),
    };
    const getWorkspaceId = vi.fn().mockReturnValue("ws-1");

    await loadCostDashboard(container, { data, getWorkspaceId });

    expect(container.querySelector("#usage-overview h3").textContent).toBe("Overview");
    expect(container.querySelector("#usage-models h3").textContent).toBe("Models");
    expect(container.querySelector("#usage-tool-cost h3").textContent).toBe("Tool Cost");
    expect(container.querySelector("#usage-projects h3").textContent).toBe("Projects");
    expect(container.querySelector("#usage-sessions h3").textContent).toBe("Sessions");
    expect(container.querySelector('[data-range-chip="7d"]').textContent).toBe("7d");
    expect(
      container.querySelectorAll("#cost-dash-overview-grid .cost-dash-stat-card"),
    ).toHaveLength(12);
    expect(container.querySelector("#cost-dash-models-list").textContent).toContain("gpt-4.1");
    expect(container.querySelector("#cost-dash-tool-cost-panel").textContent).toContain(
      "read_file",
    );
    expect(container.querySelector("#cost-dash-sessions-panel").textContent).toContain("Session 1");
  });

  it("defaults to the 30d range and re-aggregates when a range chip is clicked", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-15T12:00:00Z") });
    const now = new Date();
    const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
    const sessions = [
      {
        title: "Today",
        model: "gpt-4.1",
        time: daysAgo(0),
        totalCost: 1,
        totalTokens: 100,
        inputTokens: 60,
        outputTokens: 40,
        toolCalls: 0,
        userMessages: 1,
        workspace: "/w",
        toolCostByName: {},
      },
      {
        title: "10d ago",
        model: "gpt-4.1",
        time: daysAgo(10),
        totalCost: 2,
        totalTokens: 200,
        inputTokens: 120,
        outputTokens: 80,
        toolCalls: 0,
        userMessages: 1,
        workspace: "/w",
        toolCostByName: {},
      },
      {
        title: "20d ago",
        model: "claude",
        time: daysAgo(20),
        totalCost: 4,
        totalTokens: 400,
        inputTokens: 240,
        outputTokens: 160,
        toolCalls: 0,
        userMessages: 1,
        workspace: "/w",
        toolCostByName: {},
      },
      {
        title: "50d ago",
        model: "claude",
        time: daysAgo(50),
        totalCost: 8,
        totalTokens: 800,
        inputTokens: 480,
        outputTokens: 320,
        toolCalls: 0,
        userMessages: 1,
        workspace: "/w",
        toolCostByName: {},
      },
    ];

    const container = document.createElement("div");
    const data = {
      costDashboard: vi.fn().mockResolvedValue({ dashboard: { sessions } }),
    };
    localStorage.removeItem("pi-studio-cost-filters");

    await loadCostDashboard(container, { data, getWorkspaceId: () => "ws-1" });

    const chip30d = container.querySelector('[data-range-chip="30d"]');
    const chip7d = container.querySelector('[data-range-chip="7d"]');
    const chip90d = container.querySelector('[data-range-chip="90d"]');
    expect(chip30d.classList.contains("is-active")).toBe(true);
    expect(chip30d.getAttribute("aria-pressed")).toBe("true");
    expect(chip7d.classList.contains("is-active")).toBe(false);
    expect(chip7d.getAttribute("aria-pressed")).toBe("false");
    expect(
      container.querySelectorAll("#cost-dash-sessions-panel .cost-dash-sessions-table tbody tr"),
    ).toHaveLength(3);

    chip7d.click();
    expect(chip7d.classList.contains("is-active")).toBe(true);
    expect(chip30d.classList.contains("is-active")).toBe(false);
    expect(
      container.querySelectorAll("#cost-dash-sessions-panel .cost-dash-sessions-table tbody tr"),
    ).toHaveLength(1);
    expect(localStorage.getItem("pi-studio-cost-filters")).toContain('"range":"7d"');

    chip90d.click();
    expect(chip90d.classList.contains("is-active")).toBe(true);
    expect(
      container.querySelectorAll("#cost-dash-sessions-panel .cost-dash-sessions-table tbody tr"),
    ).toHaveLength(4);

    vi.useRealTimers();
  });
});
