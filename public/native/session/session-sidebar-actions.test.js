import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n.js";
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

describe("SessionSidebar.render — context menus, archive, delete, and Agent Inbox", () => {
  beforeEach(async () => {
    localStorage.clear();
    document.querySelectorAll(".session-context-menu").forEach((menu) => {
      menu.remove();
    });
    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).includes("/locales/")) {
        return { ok: true, status: 200, json: async () => enMessages };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await initI18n();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("generates and persists a title for the active session", async () => {
    const { sidebar, container, config, runtime } = makeSidebar([
      { id: "s-active", timestamp: new Date().toISOString(), name: "Old title" },
    ]);
    await sidebar.load();
    const item = container.querySelector('.session-item[data-session-id="s-active"]');
    item.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
    const generate = Array.from(document.querySelectorAll(".context-menu-item")).find((row) =>
      row.textContent.toLowerCase().includes("generate title"),
    );
    if (!generate) {
      const all = Array.from(document.querySelectorAll(".context-menu-item")).map(
        (row) => row.textContent,
      );
      throw new Error(`Generate title row missing. Rows: ${JSON.stringify(all)}`);
    }
    generate.click();

    await vi.waitFor(() =>
      expect(config.call).toHaveBeenCalledWith(
        "generate_session_title",
        {},
        { timeoutMs: 100_000, target: expect.objectContaining({ sessionId: "s-active" }) },
      ),
    );
    await vi.waitFor(() =>
      expect(runtime.request).toHaveBeenCalledWith(
        { type: "set_session_name", name: "Generated title" },
        expect.objectContaining({ sessionId: "s-active" }),
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      ),
    );
    expect(item.querySelector(".session-title").textContent).toBe("Generated title");
  });

  it("renames a historical session through Pi SessionManager config", async () => {
    const { sidebar, container, config, runtime } = makeSidebar([
      {
        id: "s-history",
        timestamp: new Date().toISOString(),
        name: "Old title",
        filePath: "/sessions/history.jsonl",
      },
    ]);
    config.call.mockResolvedValue({
      ok: true,
      data: { filePath: "/sessions/history.jsonl", name: "New title" },
    });
    await sidebar.load();
    const item = container.querySelector('.session-item[data-session-id="s-history"]');
    item.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
    const rename = Array.from(document.querySelectorAll(".context-menu-item")).find((row) =>
      row.textContent.includes("Rename"),
    );
    if (!rename) {
      const all = Array.from(document.querySelectorAll(".context-menu-item")).map(
        (row) => row.textContent,
      );
      throw new Error(`Rename row missing from context menu. Rows: ${JSON.stringify(all)}`);
    }
    rename.click();
    const input = item.querySelector(".session-rename-input");
    input.value = "New title";
    input.dispatchEvent(new FocusEvent("blur"));

    await vi.waitFor(() =>
      expect(config.call).toHaveBeenCalledWith("rename_historical_session", {
        filePath: "/sessions/history.jsonl",
        name: "New title",
      }),
    );
    expect(runtime.request).not.toHaveBeenCalled();
    expect(item.querySelector(".session-title").textContent).toBe("New title");
  });

  it("keeps show more and show less controls for non-current project groups", async () => {
    const sessions = Array.from({ length: 12 }, (_, index) => ({
      id: `other-${index}`,
      timestamp: new Date(Date.now() - index * 1000).toISOString(),
      name: `Other ${index}`,
      projectPath: "/other",
      projectName: "other",
      isCurrentWorkspace: false,
    }));
    const { sidebar, container } = makeSidebar(sessions);

    await sidebar.load();

    let group = container.querySelector(".project-group");
    expect(group.querySelectorAll(".session-item")).toHaveLength(8);
    const showMore = group.querySelector(
      ".project-sessions-toggle:not(.project-sessions-toggle-less)",
    );
    expect(showMore).toBeTruthy();
    expect(group.querySelector(".project-sessions-toggle-less")).toBeNull();

    showMore.click();

    group = container.querySelector(".project-group");
    expect(group.querySelectorAll(".session-item")).toHaveLength(12);
    expect(
      group.querySelector(".project-sessions-toggle:not(.project-sessions-toggle-less)"),
    ).toBeNull();
    expect(group.querySelector(".project-sessions-toggle-less")).toBeTruthy();

    group.querySelector(".project-sessions-toggle-less").click();

    expect(
      container.querySelector(".project-group").querySelectorAll(".session-item"),
    ).toHaveLength(8);
  });

  it("groups favourites and archived into separate sections", async () => {
    const { sidebar, container } = makeSidebar([
      { id: "s-fav", timestamp: new Date().toISOString(), name: "Fav" },
      { id: "s-arc", timestamp: new Date().toISOString(), name: "Arc" },
      { id: "s-reg", timestamp: new Date().toISOString(), name: "Reg" },
    ]);
    sidebar.toggleFavourite("s-fav");
    sidebar.toggleArchived("s-arc");
    await sidebar.load();
    expect(container.querySelector(".archived-group")).toBeTruthy();
    expect(
      container.querySelector('.projects-group .session-item[data-session-id="s-fav"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('.archived-group .session-item[data-session-id="s-arc"]'),
    ).toBeTruthy();
  });

  it("archives every session in a project from the project header context menu", async () => {
    const { sidebar, container } = makeSidebar([
      { id: "s-fav", timestamp: new Date().toISOString(), name: "Fav" },
      { id: "s-keep", timestamp: new Date().toISOString(), name: "Keep" },
      {
        id: "s-other",
        timestamp: new Date().toISOString(),
        name: "Other",
        projectPath: "/other",
        projectName: "other",
        isCurrentWorkspace: false,
      },
    ]);
    sidebar.toggleFavourite("s-fav");
    await sidebar.load();

    const currentHeader = container.querySelector(".project-group.current-project .project-header");
    currentHeader.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const menuItem = document.querySelector(".session-context-menu .context-menu-item");

    expect(menuItem?.textContent).toContain("Archive sessions");
    menuItem.click();

    expect(sidebar.isArchived("s-fav")).toBe(true);
    expect(sidebar.isArchived("s-keep")).toBe(true);
    expect(sidebar.isArchived("s-other")).toBe(false);
    expect(sidebar.isFavourite("s-fav")).toBe(false);
    expect(
      container.querySelectorAll(".archived-group > .project-sessions > .session-item"),
    ).toHaveLength(2);
    expect(container.querySelector(".archived-group .project-group")).toBeNull();
  });

  it("reports the latest Agent Inbox session for top-level navigation and hides its history", async () => {
    setSuperAgentEnabled(true);
    const onAgentInboxSessionChange = vi.fn();
    const { sidebar, container } = makeSidebar(
      [
        { id: "project", timestamp: "2026-06-02T00:00:00.000Z", name: "Project chat" },
        {
          id: "sa-old",
          timestamp: "2026-06-01T00:00:00.000Z",
          name: "Old Inbox",
          projectPath: "/Users/me/.pi/agent/super-agent",
          projectName: "super-agent",
          isCurrentWorkspace: false,
        },
        {
          id: "sa-new",
          timestamp: "2026-06-03T00:00:00.000Z",
          name: "New Inbox",
          projectPath: "/Users/me/.pi/agent/super-agent",
          projectName: "super-agent",
          isCurrentWorkspace: false,
        },
      ],
      { onAgentInboxSessionChange },
    );

    await sidebar.load();

    expect(onAgentInboxSessionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "sa-new",
        kind: "super-agent",
        name: "Agent Inbox",
        projectPath: "/Users/me/.pi/agent/super-agent",
      }),
    );
    expect(container.querySelector(".super-agent-pinned-group")).toBeNull();
    expect(container.querySelector('.session-item[data-session-id="sa-new"]')).toBeNull();
    expect(container.querySelector('.session-item[data-session-id="sa-old"]')).toBeNull();
    expect(container.querySelector('.session-item[data-session-id="project"]')).not.toBeNull();
  });

  it("hides Agent Inbox sessions when the setting is disabled", async () => {
    setSuperAgentEnabled(false);
    const onAgentInboxSessionChange = vi.fn();
    const { sidebar, container } = makeSidebar(
      [
        { id: "project", timestamp: "2026-06-02T00:00:00.000Z", name: "Project chat" },
        {
          id: "sa",
          timestamp: "2026-06-03T00:00:00.000Z",
          name: "Inbox",
          projectPath: "/Users/me/.pi/agent/super-agent",
          projectName: "super-agent",
          isCurrentWorkspace: false,
        },
      ],
      { onAgentInboxSessionChange },
    );

    await sidebar.load();

    expect(onAgentInboxSessionChange).toHaveBeenLastCalledWith(null);
    expect(container.querySelector(".super-agent-pinned-group")).toBeNull();
    expect(container.querySelector('.session-item[data-session-id="sa"]')).toBeNull();
    expect(container.textContent).not.toContain("Agent Inbox");
    expect(container.querySelector('.session-item[data-session-id="project"]')).not.toBeNull();
  });

  it("publishes Agent Inbox navigation after the setting is enabled without a new host fetch", async () => {
    setSuperAgentEnabled(false);
    const onAgentInboxSessionChange = vi.fn();
    const { sidebar, container } = makeSidebar(
      [
        { id: "project", timestamp: "2026-06-02T00:00:00.000Z", name: "Project chat" },
        {
          id: "sa",
          timestamp: "2026-06-03T00:00:00.000Z",
          name: "Inbox",
          projectPath: "/Users/me/.pi/agent/super-agent",
          projectName: "super-agent",
          isCurrentWorkspace: false,
        },
      ],
      { onAgentInboxSessionChange },
    );

    await sidebar.load();
    expect(onAgentInboxSessionChange).toHaveBeenLastCalledWith(null);
    const projectItem = container.querySelector('.session-item[data-session-id="project"]');

    setSuperAgentEnabled(true);
    sidebar.syncAgentInboxNav();
    expect(onAgentInboxSessionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "sa", kind: "super-agent", name: "Agent Inbox" }),
    );
    expect(container.querySelector('.session-item[data-session-id="project"]')).toBe(projectItem);
  });

  it("shows a delete-all button on the archived header that deletes archived sessions after confirming", async () => {
    const { sidebar, container, control } = makeSidebar([
      { id: "s-arc-1", timestamp: new Date().toISOString(), name: "Arc 1" },
      { id: "s-arc-2", timestamp: new Date().toISOString(), name: "Arc 2" },
    ]);
    sidebar.toggleArchived("s-arc-1");
    sidebar.toggleArchived("s-arc-2");
    await sidebar.load();

    const deleteAllBtn = container.querySelector(".archived-header .archived-delete-all-btn");
    expect(deleteAllBtn).toBeTruthy();
    expect(container.querySelector(".sidebar-section-footer .archived-delete-all-btn")).toBeNull();
    control.deleteSessions.mockResolvedValueOnce({ deleted: ["s-arc-1", "s-arc-2"], errors: [] });
    deleteAllBtn.click();

    const confirmDialog = document.querySelector(".sidebar-confirm-overlay");
    expect(confirmDialog).toBeTruthy();
    document.querySelector(".sidebar-confirm-yes").click();
    await Promise.resolve();
    await Promise.resolve();

    expect(control.deleteSessions).toHaveBeenCalledWith(["s-arc-1", "s-arc-2"]);
    expect(container.querySelector(".archived-group")).toBeFalsy();
    expect(sidebar.isArchived("s-arc-1")).toBe(false);
  });

  it("workspace context menu deletes a project's deletable sessions after confirming", async () => {
    const { sidebar, container, control } = makeSidebar([
      { id: "s-1", timestamp: new Date().toISOString(), name: "One" },
      { id: "s-2", timestamp: new Date().toISOString(), name: "Two" },
      { id: "s-live", timestamp: new Date().toISOString(), name: "Live" },
    ]);
    await sidebar.load();
    sidebar.setActive("s-1");
    sidebar.setStreaming("s-live", true);

    const header = container.querySelector(".project-group-header");
    header.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 8,
        clientY: 8,
      }),
    );
    const rows = [...document.querySelectorAll(".session-context-menu .context-menu-item")];
    const deleteRow = rows.find((el) => el.textContent === "Delete all sessions");
    expect(deleteRow).toBeTruthy();

    control.deleteSessions.mockResolvedValueOnce({ deleted: ["s-2"], errors: [] });
    deleteRow.click();
    document.querySelector(".sidebar-confirm-yes").click();
    await Promise.resolve();
    await Promise.resolve();

    expect(control.deleteSessions).toHaveBeenCalledWith(["s-2"]);
    expect(container.textContent).toContain("One");
    expect(container.textContent).toContain("Live");
    expect(container.textContent).not.toContain("Two");
  });

  it("workspace delete-all works from the pinned-workspace menu shape (no sessions array)", async () => {
    const { sidebar, container, control } = makeSidebar([
      { id: "pin-1", timestamp: new Date().toISOString(), name: "Pinned One" },
      { id: "pin-2", timestamp: new Date().toISOString(), name: "Pinned Two" },
      {
        id: "sa-1",
        timestamp: new Date().toISOString(),
        name: "Super Agent",
        projectPath: "/Users/me/.pi/agent/super-agent",
      },
    ]);
    await sidebar.load();
    sidebar.setActive("pin-1");

    control.deleteSessions.mockResolvedValueOnce({ deleted: ["pin-2"], errors: [] });
    const deleting = sidebar.deleteWorkspaceSessions({ path: "/ws-1", name: "ws-1" });
    document.querySelector(".sidebar-confirm-yes").click();
    await deleting;

    expect(control.deleteSessions).toHaveBeenCalledWith(["pin-2"]);
    expect(container.textContent).toContain("Pinned One");
    expect(container.textContent).not.toContain("Pinned Two");
  });

  it("cancelling the delete-all confirm dialog keeps archived sessions", async () => {
    const { sidebar, container, control } = makeSidebar([
      { id: "s-arc", timestamp: new Date().toISOString(), name: "Arc" },
    ]);
    sidebar.toggleArchived("s-arc");
    await sidebar.load();

    container.querySelector(".archived-delete-all-btn").click();
    document.querySelector(".sidebar-confirm-no").click();
    await Promise.resolve();

    expect(control.deleteSessions).not.toHaveBeenCalled();
    expect(sidebar.isArchived("s-arc")).toBe(true);
  });

  it("drives streaming indicator classes", async () => {
    const { sidebar, container } = makeSidebar([
      { id: "s-1", timestamp: new Date().toISOString(), name: "One" },
    ]);
    await sidebar.load();
    sidebar.setStreaming("s-1", true);
    expect(container.querySelector('.session-item[data-session-id="s-1"]').classList).toContain(
      "streaming",
    );
    sidebar.setStreaming("s-1", false);
    expect(
      container
        .querySelector('.session-item[data-session-id="s-1"]')
        .classList.contains("streaming"),
    ).toBe(false);
  });

  it("hydrates unread and in-progress statuses from session summaries", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-active",
        timestamp: new Date().toISOString(),
        name: "Active",
        status: "working",
        unread: true,
      },
      {
        id: "s-background",
        timestamp: new Date().toISOString(),
        name: "Background",
        status: "working",
        unread: true,
      },
    ]);
    await sidebar.load();
    expect(
      container.querySelector('.session-item[data-session-id="s-active"]').classList,
    ).toContain("streaming");
    expect(
      container
        .querySelector('.session-item[data-session-id="s-active"]')
        .classList.contains("unread"),
    ).toBe(false);
    expect(
      container.querySelector('.session-item[data-session-id="s-background"]').classList,
    ).toContain("streaming");
    expect(
      container.querySelector('.session-item[data-session-id="s-background"]').classList,
    ).toContain("unread");
  });
});
