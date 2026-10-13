import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n.js";
import { setSuperAgentEnabled } from "../../super-agent/settings.js";
import { formatSessionTime, SessionSidebar, workspaceFolderName } from "./session-sidebar.js";
import { escapeHtml } from "./session-sidebar-storage.js";

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
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

describe("workspaceFolderName", () => {
  it("returns a POSIX basename", () => {
    expect(workspaceFolderName("/Users/me/Documents/test")).toBe("test");
  });

  it("returns only the folder name for Windows extended UNC paths", () => {
    expect(workspaceFolderName(String.raw`\\?\UNC\psf\Home\Documents\test`)).toBe("test");
    expect(workspaceFolderName(String.raw`\\?\UNC\psf\Home\Documents\New project 2`)).toBe(
      "New project 2",
    );
  });

  it("prefers a clean projectName over a Windows path", () => {
    expect(workspaceFolderName(String.raw`C:\Users\me\proj`, "proj")).toBe("proj");
  });
});

describe("formatSessionTime", () => {
  it("renders relative labels instead of raw ISO strings", () => {
    const now = Date.now();
    expect(formatSessionTime(new Date(now - 30 * 1000).toISOString())).toBe("Just now");
    expect(formatSessionTime(new Date(now - 5 * 60 * 1000).toISOString())).toBe("5m ago");
    expect(formatSessionTime(new Date(now - 3 * 3600 * 1000).toISOString())).toBe("3h ago");
    expect(formatSessionTime(new Date(now - 26 * 3600 * 1000).toISOString())).toBe("Yesterday");
  });

  it("returns empty string for invalid input", () => {
    expect(formatSessionTime("")).toBe("");
    expect(formatSessionTime("not-a-date")).toBe("");
  });
});

describe("escapeHtml", () => {
  it("escapes quotes as well as angle brackets and ampersands for attribute safety", () => {
    expect(escapeHtml(`a&b<"c">'d'`)).toBe("a&amp;b&lt;&quot;c&quot;&gt;&#39;d&#39;");
  });
});

describe("SessionSidebar.render — loading, caching, and project grouping", () => {
  beforeEach(() => {
    localStorage.clear();
    document.querySelectorAll(".session-context-menu").forEach((menu) => {
      menu.remove();
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders each session with a title and no visible timestamp", async () => {
    const { sidebar, container } = makeSidebar([
      { id: "s-1", timestamp: new Date().toISOString(), name: "Hello", firstMessage: "hi" },
    ]);
    await sidebar.load();
    expect(container.querySelectorAll(".session-item")).toHaveLength(1);
    expect(container.querySelector(".session-title").textContent).toBe("Hello");
    expect(container.querySelector(".session-time")).toBeNull();
  });

  it("updates a generated session name while the agent is still running", async () => {
    const { sidebar, container } = makeSidebar([
      { id: "s-active", timestamp: new Date().toISOString(), firstMessage: "Help me name this" },
    ]);
    await sidebar.load();

    sidebar.setSessionName("s-active", "Generated in Parallel");

    expect(container.querySelector(".session-title").textContent).toBe("Generated in Parallel");
  });

  it("loads a targetless launcher catalog with an explicit cache scope", async () => {
    const loadSessions = vi.fn().mockResolvedValue({
      sessions: [
        {
          id: "s-launcher",
          timestamp: new Date().toISOString(),
          name: "Launcher session",
          projectPath: "/ws-launcher",
          projectName: "ws-launcher",
          isCurrentWorkspace: false,
        },
      ],
    });
    const { sidebar, container, data } = makeSidebar([], {
      getTarget: () => null,
      cacheScope: "launcher",
      loadSessions,
    });

    await sidebar.load();

    expect(loadSessions).toHaveBeenCalledOnce();
    expect(data.listAllSessions).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Launcher session");
  });

  it("retries transient load failures before showing the manual retry error", async () => {
    vi.useFakeTimers();
    const { sidebar, container, data } = makeSidebar([]);
    data.listAllSessions
      .mockRejectedValueOnce(new Error("Host disconnected before the data request completed"))
      .mockResolvedValueOnce({
        sessions: [
          {
            id: "s-1",
            timestamp: new Date().toISOString(),
            name: "Recovered",
            projectPath: "/ws-1",
            projectName: "ws-1",
            isCurrentWorkspace: true,
          },
        ],
      });

    await sidebar.load();
    expect(container.querySelector(".ui-loading")).not.toBeNull();
    expect(container.textContent).toContain("Loading sessions");
    expect(container.textContent).not.toContain("Failed to load sessions");

    await vi.advanceTimersByTimeAsync(250);

    expect(data.listAllSessions).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll(".session-item")).toHaveLength(1);
    expect(container.querySelector(".session-title").textContent).toBe("Recovered");
  });

  it("renders a cached session list immediately while refreshing in the background", async () => {
    const pending = deferred();
    localStorage.setItem(
      "picot-session-list-cache:ws-1",
      JSON.stringify([
        {
          id: "s-cached",
          timestamp: new Date().toISOString(),
          name: "Cached",
          projectPath: "/ws-1",
          projectName: "ws-1",
          isCurrentWorkspace: true,
        },
      ]),
    );
    const { sidebar, container, data } = makeSidebar([]);
    data.listAllSessions.mockReturnValueOnce(pending.promise);

    const load = sidebar.load();

    expect(container.textContent).toContain("Cached");
    expect(container.textContent).not.toContain("Loading sessions");

    pending.resolve({
      sessions: [
        {
          id: "s-fresh",
          timestamp: new Date().toISOString(),
          name: "Fresh",
          projectPath: "/ws-1",
          projectName: "ws-1",
          isCurrentWorkspace: true,
        },
      ],
    });
    await load;

    expect(container.textContent).toContain("Fresh");
    expect(container.textContent).not.toContain("Cached");
  });

  it("keeps cached sessions and Agent Inbox when an early host response is empty", async () => {
    setSuperAgentEnabled(true);
    const sessions = [
      {
        id: "s-active",
        timestamp: "2026-08-09T01:00:00.000Z",
        name: "Current session",
        projectPath: "/ws-1",
        projectName: "ws-1",
        isCurrentWorkspace: true,
      },
      {
        id: "agent-inbox",
        timestamp: "2026-08-09T02:00:00.000Z",
        projectPath: "/Users/me/.pi/agent/super-agent",
        projectName: "super-agent",
        isCurrentWorkspace: false,
      },
    ];
    localStorage.setItem("picot-session-list-cache:ws-1", JSON.stringify(sessions));
    const onAgentInboxSessionChange = vi.fn();
    const { sidebar, container, data } = makeSidebar([], { onAgentInboxSessionChange });
    data.listAllSessions.mockResolvedValueOnce({ sessions: [] });

    await sidebar.load();

    expect(container.querySelector('[data-session-id="s-active"]')).not.toBeNull();
    expect(sidebar.sessions).toHaveLength(2);
    expect(onAgentInboxSessionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "agent-inbox", kind: "super-agent" }),
    );
    expect(JSON.parse(localStorage.getItem("picot-session-list-cache:ws-1"))).toHaveLength(2);
  });

  it("clears a cached in-progress status when the live session list has no runtime status", async () => {
    const pending = deferred();
    localStorage.setItem(
      "picot-session-list-cache:ws-1",
      JSON.stringify([
        {
          id: "s-interrupted",
          timestamp: new Date().toISOString(),
          name: "Interrupted",
          projectPath: "/ws-1",
          projectName: "ws-1",
          isCurrentWorkspace: true,
          status: "working",
        },
      ]),
    );
    const { sidebar, container, data } = makeSidebar([]);
    data.listAllSessions.mockReturnValueOnce(pending.promise);

    const load = sidebar.load();
    expect(
      container
        .querySelector('.session-item[data-session-id="s-interrupted"]')
        .classList.contains("streaming"),
    ).toBe(true);

    pending.resolve({
      sessions: [
        {
          id: "s-interrupted",
          timestamp: new Date().toISOString(),
          name: "Interrupted",
          projectPath: "/ws-1",
          projectName: "ws-1",
          isCurrentWorkspace: true,
        },
      ],
    });
    await load;

    expect(
      container
        .querySelector('.session-item[data-session-id="s-interrupted"]')
        .classList.contains("streaming"),
    ).toBe(false);
  });

  it("falls back to the latest cached session list for a workspace without its own cache", async () => {
    const pending = deferred();
    localStorage.setItem(
      "picot-session-list-cache:latest",
      JSON.stringify([
        {
          id: "s-old-project",
          timestamp: new Date().toISOString(),
          name: "Old project",
          projectPath: "/old",
          projectName: "old",
          isCurrentWorkspace: true,
        },
        {
          id: "s-new-project",
          timestamp: new Date().toISOString(),
          name: "New project",
          projectPath: "/new",
          projectName: "new",
          isCurrentWorkspace: false,
        },
      ]),
    );
    const { sidebar, container, data } = makeSidebar([], {
      getTarget: () => ({ workspaceId: "ws-2", sessionId: "s-new-project" }),
    });
    data.listAllSessions.mockReturnValueOnce(pending.promise);

    const load = sidebar.load();

    expect(container.textContent).toContain("New project");
    expect(
      container.querySelector(".project-group.current-project .project-name").textContent,
    ).toBe("new");
    expect(container.textContent).not.toContain("Loading sessions");

    pending.resolve({ sessions: [] });
    await load;
  });

  it("does not rerender when the refreshed session list is unchanged", async () => {
    const session = {
      id: "s-1",
      timestamp: new Date().toISOString(),
      name: "One",
      projectPath: "/ws-1",
      projectName: "ws-1",
      isCurrentWorkspace: true,
    };
    localStorage.setItem("picot-session-list-cache:ws-1", JSON.stringify([session]));
    const { sidebar } = makeSidebar([]);
    sidebar.data.listAllSessions.mockResolvedValueOnce({ sessions: [session] });
    const render = vi.spyOn(sidebar, "render");

    await sidebar.load();

    expect(render).toHaveBeenCalledTimes(1);
  });

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

  it("marks the active session", async () => {
    const { sidebar, container } = makeSidebar([
      { id: "s-active", timestamp: new Date().toISOString(), name: "Current" },
      { id: "s-2", timestamp: new Date().toISOString(), name: "Other" },
    ]);
    await sidebar.load();
    const active = container.querySelector(".session-item.active");
    expect(active?.dataset.sessionId).toBe("s-active");
  });

  it("invokes onSelect with the session object on click", async () => {
    const { sidebar, container, onSelect } = makeSidebar([
      { id: "s-2", timestamp: new Date().toISOString(), name: "Other" },
    ]);
    await sidebar.load();
    container.querySelector('.session-item[data-session-id="s-2"]').click();
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s-2", isCurrentWorkspace: true }),
    );
  });

  it("groups sessions by project and opens other projects in a new window", async () => {
    const { sidebar, container, onSelect } = makeSidebar([
      {
        id: "s-there",
        timestamp: new Date().toISOString(),
        name: "There",
        projectPath: "/other",
        projectName: "other",
        isCurrentWorkspace: false,
      },
      { id: "s-here", timestamp: new Date().toISOString(), name: "Here" },
    ]);
    await sidebar.load();
    const groups = container.querySelectorAll(".project-group");
    expect(groups).toHaveLength(2);
    expect(groups[0].classList.contains("current-project")).toBe(false);
    expect(groups[0].querySelector(".project-name").textContent).toBe("other");
    expect(groups[1].classList.contains("current-project")).toBe(true);
    expect(groups[1].querySelector(".project-sessions").classList.contains("collapsed")).toBe(
      false,
    );
    expect(groups[0].querySelector(".project-sessions").classList.contains("collapsed")).toBe(true);
    container.querySelector('.session-item[data-session-id="s-there"]').click();
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s-there", projectPath: "/other", isCurrentWorkspace: false }),
    );
  });

  it("still toggles a project when saving its collapsed state exceeds storage quota", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-other",
        timestamp: new Date().toISOString(),
        name: "Other",
        projectPath: "/other",
        projectName: "other",
        isCurrentWorkspace: false,
      },
    ]);
    await sidebar.load();

    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key === "picot-projects-collapsed") {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      originalSetItem.call(this, key, value);
    });

    const project = container.querySelector(".project-group");
    const header = project.querySelector(".project-header");
    const sessions = project.querySelector(".project-sessions");
    expect(sessions.classList.contains("collapsed")).toBe(true);

    header.click();

    expect(sessions.classList.contains("collapsed")).toBe(false);
  });

  it("shows the current project new-chat button for LAN clients", async () => {
    delete globalThis.__TAURI__;
    const onCreateSession = vi.fn().mockResolvedValue(undefined);
    const { sidebar, container } = makeSidebar(
      [{ id: "s-here", timestamp: new Date().toISOString(), name: "Here" }],
      { onCreateSession },
    );

    await sidebar.load();

    const button = container.querySelector(".current-project .project-new-chat-btn");
    expect(button).toBeTruthy();
    button.click();
    await vi.waitFor(() => expect(onCreateSession).toHaveBeenCalledWith("ws-1"));
  });
});
