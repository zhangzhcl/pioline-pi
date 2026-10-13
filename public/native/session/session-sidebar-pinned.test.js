import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, t } from "../../i18n.js";
import { setSuperAgentEnabled } from "../../super-agent/settings.js";
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

describe("SessionSidebar.pinned", () => {
  beforeEach(() => {
    localStorage.clear();
    setSuperAgentEnabled(false);
  });

  it("renders no PINNED section when nothing is pinned", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-1",
        filePath: "/sessions/s-1.jsonl",
        timestamp: new Date().toISOString(),
        name: "Hello",
      },
    ]);
    await sidebar.load();
    expect(container.querySelector(".pinned-group")).toBeNull();
  });

  it("shows only the folder name for Windows UNC pinned workspaces", async () => {
    const winPath = String.raw`\\?\UNC\psf\Home\Documents\test`;
    const { sidebar, container } = makeSidebar([
      {
        id: "s-win",
        filePath: "/sessions/s-win.jsonl",
        timestamp: new Date().toISOString(),
        name: "Hello",
        projectPath: winPath,
        projectName: winPath,
      },
    ]);
    await sidebar.load();
    sidebar.pinnedStore.pinWorkspace(winPath, winPath);
    await sidebar.load();
    const nameEl = container.querySelector(".pinned-workspace-group .workspace-name");
    expect(nameEl?.textContent).toBe("test");
    expect(nameEl?.title).toBe(winPath);
  });

  it("renders a PINNED section listing pinned workspace sessions", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-1",
        filePath: "/sessions/s-1.jsonl",
        timestamp: new Date().toISOString(),
        name: "Hello",
      },
      {
        id: "s-2",
        filePath: "/sessions/s-2.jsonl",
        timestamp: new Date().toISOString(),
        name: "World",
      },
    ]);
    await sidebar.load();
    sidebar.pinnedStore.pinWorkspace("/ws-1", "/ws-1");
    await sidebar.load();
    const group = container.querySelector(".pinned-group");
    expect(group).not.toBeNull();
    expect(group.querySelector(".pinned-workspace-group")).not.toBeNull();
    expect(group.querySelectorAll(".pinned-workspace-group .session-item")).toHaveLength(2);
    expect(group.textContent).toContain("PINNED");
  });

  it("keeps show more and show less controls for pinned workspace sessions", async () => {
    const sessions = Array.from({ length: 12 }, (_, index) => ({
      id: `pinned-${index}`,
      filePath: `/sessions/pinned-${index}.jsonl`,
      timestamp: new Date(Date.now() - index * 1000).toISOString(),
      name: `Pinned ${index}`,
    }));
    const { sidebar, container } = makeSidebar(sessions);

    await sidebar.load();
    sidebar.pinnedStore.pinWorkspace("/ws-1", "/ws-1");
    await sidebar.load();

    let group = container.querySelector(".pinned-workspace-group");
    expect(group.querySelectorAll(".session-item")).toHaveLength(8);
    const showMore = group.querySelector(
      ".project-sessions-toggle:not(.project-sessions-toggle-less)",
    );
    expect(showMore).toBeTruthy();
    expect(group.querySelector(".project-sessions-toggle-less")).toBeNull();

    showMore.click();

    group = container.querySelector(".pinned-workspace-group");
    expect(group.querySelectorAll(".session-item")).toHaveLength(12);
    expect(
      group.querySelector(".project-sessions-toggle:not(.project-sessions-toggle-less)"),
    ).toBeNull();
    expect(group.querySelector(".project-sessions-toggle-less")).toBeTruthy();

    group.querySelector(".project-sessions-toggle-less").click();

    expect(
      container.querySelector(".pinned-workspace-group").querySelectorAll(".session-item"),
    ).toHaveLength(8);
  });

  it("excludes workspace-pinned sessions from the regular project list", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-1",
        filePath: "/sessions/s-1.jsonl",
        timestamp: new Date().toISOString(),
        name: "Hello",
      },
    ]);
    await sidebar.load();
    sidebar.pinnedStore.pinWorkspace("/ws-1", "/ws-1");
    await sidebar.load();
    expect(container.querySelectorAll(".pinned-group .session-item")).toHaveLength(1);
    expect(container.querySelectorAll(".projects-group .session-item")).toHaveLength(0);
  });

  it("renders the Unavailable sub-section for orphan pin records", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-1",
        filePath: "/sessions/s-1.jsonl",
        timestamp: new Date().toISOString(),
        name: "Hello",
      },
    ]);
    await sidebar.load();
    sidebar.pinnedStore.pinWorkspace("/ghost-ws", "/ghost-ws");
    sidebar.pinnedStore.pinSession("ghost-session");
    await sidebar.load();
    const unavailableRows = container.querySelectorAll(".pinned-unavailable");
    expect(unavailableRows.length).toBeGreaterThanOrEqual(2);
  });

  it("clears an orphan pin via the Unavailable Unpin button", async () => {
    const { sidebar, container } = makeSidebar([]);
    await sidebar.load();
    sidebar.pinnedStore.pinWorkspace("/ghost-ws", "/ghost-ws");
    await sidebar.load();
    const unpinBtn = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes(t("sidebar.unpinWorkspace")),
    );
    expect(unpinBtn).toBeTruthy();
    unpinBtn.click();
    expect(sidebar.pinnedStore.isWorkspacePinned("/ghost-ws")).toBe(false);
  });

  it("keeps the Agent Inbox out of the recents record", async () => {
    setSuperAgentEnabled(true);
    const { sidebar } = makeSidebar([
      {
        id: "agent-inbox",
        filePath: "/sessions/agent-inbox.jsonl",
        timestamp: new Date().toISOString(),
        name: "Inbox",
        projectPath: "/Users/me/.pi/agent/super-agent",
        projectName: "super-agent",
      },
      {
        id: "s-1",
        filePath: "/sessions/s-1.jsonl",
        timestamp: new Date().toISOString(),
        name: "Hello",
      },
    ]);
    await sidebar.load();
    sidebar.setActive("agent-inbox");
    sidebar.setActive("s-1");
    await sidebar.load();
    expect(sidebar.recent).toEqual(["s-1"]);
  });

  it("renders the PINNED section between SESSIONS and PROJECTS", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-1",
        filePath: "/sessions/s-1.jsonl",
        timestamp: new Date().toISOString(),
        name: "Hello",
        isDefaultWorkspace: true,
      },
      {
        id: "s-other",
        filePath: "/sessions/s-other.jsonl",
        timestamp: new Date().toISOString(),
        name: "Other",
        projectPath: "/other-ws",
        projectName: "other-ws",
        isCurrentWorkspace: false,
      },
    ]);
    await sidebar.load();
    sidebar.pinnedStore.pinWorkspace("/pinned-ws", "/pinned-ws");
    await sidebar.load();
    const order = Array.from(container.children).map(
      (node) =>
        node.className.split(" ").find((c) => c.endsWith("-group")) || node.className.split(" ")[0],
    );
    const sessionsIdx = order.indexOf("sessions-group");
    const pinnedIdx = order.indexOf("pinned-group");
    const projectIdx = order.indexOf("projects-group");
    expect(sessionsIdx).toBeGreaterThanOrEqual(0);
    expect(pinnedIdx).toBeGreaterThan(sessionsIdx);
    expect(projectIdx).toBeGreaterThan(pinnedIdx);
  });
});
