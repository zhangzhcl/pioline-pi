import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n.js";
import { SessionSidebar } from "./session-sidebar.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EN_LOCALE_PATH = join(__dirname, "..", "..", "locales", "en.json");
const enMessages = JSON.parse(readFileSync(EN_LOCALE_PATH, "utf8"));

function makeSidebar(sessions, overrides = {}) {
  const container = document.createElement("div");
  const enriched = sessions.map((session) => ({
    projectPath: "/ws-1",
    projectName: "ws-1",
    isCurrentWorkspace: true,
    ...session,
  }));
  const data = {
    listAllSessions: vi.fn().mockResolvedValue({ sessions: enriched }),
    searchSessions: vi.fn().mockResolvedValue({ results: [] }),
  };
  const runtime = { request: vi.fn().mockResolvedValue({}) };
  const config = {
    call: vi.fn().mockResolvedValue({ ok: true, data: { title: "Generated title" } }),
  };
  const control = { deleteSessions: vi.fn().mockResolvedValue({ deleted: [], errors: [] }) };
  const onSelect = vi.fn();
  const sidebar = new SessionSidebar(container, {
    data,
    runtime,
    control,
    config,
    getTarget: () => ({ workspaceId: "ws-1", sessionId: "s-active" }),
    onSelect,
    ...overrides,
  });
  return { sidebar, container, data, runtime, config, control, onSelect };
}

beforeEach(async () => {
  globalThis.fetch = vi.fn(async (input) => {
    if (String(input).includes("/locales/")) {
      return { ok: true, status: 200, json: async () => enMessages };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

describe("SessionSidebar.upsertSession", () => {
  it("upserts a newly bound session so it appears before the host list refresh catches up", async () => {
    const { sidebar, container } = makeSidebar([]);

    sidebar.upsertSession({
      id: "s-new",
      firstMessage: "Start with this request",
      timestamp: "2026-07-22T00:00:00.000Z",
      modifiedAtMs: 1,
      isCurrentWorkspace: true,
    });

    expect(container.querySelectorAll(".session-item")).toHaveLength(1);
    expect(container.querySelector(".session-title").textContent).toBe("Start with this request");
    expect(container.querySelector(".session-item").dataset.sessionId).toBe("s-new");

    sidebar.upsertSession({
      id: "s-new",
      firstMessage: "Follow-up should not replace the first title",
      modifiedAtMs: 2,
    });

    expect(container.querySelectorAll(".session-item")).toHaveLength(1);
    expect(container.querySelector(".session-title").textContent).toBe("Start with this request");
  });

  it("keeps default workspace sessions in default section without borrowing project path from foreign projects", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-proj",
        timestamp: new Date().toISOString(),
        name: "Project Session",
        projectPath: "/projects/my-app",
        projectName: "my-app",
        isCurrentWorkspace: false,
        isDefaultWorkspace: false,
      },
    ]);
    sidebar.registeredWorkspaces = [
      { workspaceId: "ws-home", path: "/home/user", folderName: "user", isDefaultWorkspace: true },
      {
        workspaceId: "ws-proj",
        path: "/projects/my-app",
        folderName: "my-app",
        isDefaultWorkspace: false,
      },
    ];
    await sidebar.load();

    sidebar.getTarget = () => ({ workspaceId: "ws-home", sessionId: "s-new" });

    sidebar.upsertSession({
      id: "s-new",
      firstMessage: "Hello in plain session",
      timestamp: new Date().toISOString(),
      modifiedAtMs: 1,
      isCurrentWorkspace: true,
    });

    const newSession = sidebar.sessions.find((s) => s.id === "s-new");
    expect(newSession).toBeDefined();
    expect(newSession.isDefaultWorkspace).toBe(true);
    expect(newSession.projectPath).not.toBe("/projects/my-app");

    const projectGroups = container.querySelectorAll(".project-group");
    expect(projectGroups).toHaveLength(1);
    const projectSessions = projectGroups[0].querySelectorAll(".session-item");
    expect([...projectSessions].some((el) => el.dataset.sessionId === "s-new")).toBe(false);
  });
});
