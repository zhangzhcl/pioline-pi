// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n.js";
import "./super-agent-runtime.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

function mockConfig({ tasks = [], projects = [], onWrite } = {}) {
  const call = vi.fn(async (method, params) => {
    if (method === "read_super_agent_tasks") {
      return { ok: true, data: { tasks } };
    }
    if (method === "list_super_agent_projects") {
      return { ok: true, data: { projects } };
    }
    if (method === "write_super_agent_tasks") {
      onWrite?.(params);
      return { ok: true };
    }
    return { ok: true, data: {} };
  });
  window.__picotConfigCall = call;
  return call;
}

function lastWrittenTasks(call) {
  const writes = call.mock.calls.filter(([method]) => method === "write_super_agent_tasks");
  return writes.length ? writes[writes.length - 1][1].tasks : null;
}

describe("super-agent-runtime project routing, dispatch, and active status", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    localStorage.clear();
    vi.restoreAllMocks();
    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).includes("/locales/")) {
        return { ok: true, status: 200, json: async () => enMessages };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await initI18n();
    mockConfig({
      tasks: [
        {
          id: "task-1",
          status: "pending",
          title: "Feature: Agent Status Indicator",
          description: "Add a real-time agent status indicator with many implementation notes.",
          targetProject: "/Users/me/project",
        },
      ],
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    window.__picotConfigCall = undefined;
  });

  it("approves a task after choosing a project from the project registry", async () => {
    const call = mockConfig({
      tasks: [
        {
          id: "task-1",
          status: "pending",
          title: "Missing target",
          description: "Needs a project.",
        },
      ],
      projects: [
        { name: "project-a", cwd: "/Users/me/project-a", status: "running", activePort: 47821 },
      ],
    });

    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    runtime.querySelector(".runtime-task-card").click();
    const select = runtime.querySelector('[data-action="select-project"]');
    expect(select).toBeInstanceOf(HTMLSelectElement);
    expect(select.classList.contains("ui-select-native")).toBe(true);

    runtime.querySelector(".ui-select[role='combobox']").click();
    const option = [...document.querySelectorAll(".ui-select-option")].find(
      (item) => item.dataset.value === "/Users/me/project-a",
    );
    expect(option).toBeDefined();
    option.click();
    expect(select.value).toBe("/Users/me/project-a");
    runtime.querySelector('[data-action="approve"]').click();

    await Promise.resolve();

    const written = lastWrittenTasks(call);
    expect(written).toContainEqual(
      expect.objectContaining({
        targetProject: "/Users/me/project-a",
        routingConfidence: "user_selected",
      }),
    );
  });

  it("offers bulk actions for ready pending tasks and completed tasks", async () => {
    const call = mockConfig({
      tasks: [
        {
          id: "ready-1",
          status: "pending",
          title: "Ready one",
          targetProject: "/Users/me/project",
        },
        {
          id: "missing-target",
          status: "pending",
          title: "Missing target",
        },
        {
          id: "done-1",
          status: "done",
          title: "Done one",
        },
      ],
    });

    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    const dispatches = [];
    runtime.addEventListener("sa-dispatch", (event) => dispatches.push(event.detail.id));
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.querySelector('[data-action="approve-all"]').textContent).toContain("Approve 1");
    runtime.querySelector('[data-action="approve-all"]').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatches).toEqual(["ready-1"]);
    let written = lastWrittenTasks(call);
    expect(written).toContainEqual(expect.objectContaining({ id: "ready-1", status: "running" }));

    runtime.querySelector('[data-action="clear-done"]').click();
    await Promise.resolve();

    written = lastWrittenTasks(call);
    expect(written.some((task) => task.id === "done-1")).toBe(false);
  });

  it("shows quick actions on collapsed cards", async () => {
    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.querySelector(".runtime-task-card").classList.contains("is-collapsed")).toBe(
      true,
    );
    expect(runtime.querySelector('.runtime-quick-actions [data-action="approve"]')).not.toBeNull();
    expect(runtime.querySelector('.runtime-quick-actions [data-action="dismiss"]')).not.toBeNull();
    expect(
      runtime.querySelector('.runtime-quick-actions [data-action="prompt-task"]'),
    ).not.toBeNull();
  });

  it("shows child session and event history actions for dispatched tasks", async () => {
    mockConfig({
      tasks: [
        {
          id: "task-1",
          status: "done",
          title: "Done task",
          dispatch: {
            targetProject: "/Users/me/project",
            childPort: 47822,
            childSessionId: "session-abc",
          },
          events: [
            {
              at: "2026-07-10T12:00:00.000Z",
              type: "dispatched",
              status: "running",
              message: "Dispatched.",
            },
            {
              at: "2026-07-10T12:05:00.000Z",
              type: "completed",
              status: "done",
              message: "Finished.",
            },
          ],
        },
      ],
    });

    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    const viewEvents = [];
    runtime.addEventListener("sa-view-session", (event) => viewEvents.push(event.detail));
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    runtime.querySelector(".runtime-task-card").click();

    expect(runtime.querySelector('[data-action="view-session"]')).not.toBeNull();
    expect(runtime.textContent).toContain("History");

    runtime.querySelector('[data-action="toggle-history"]').click();
    expect(runtime.textContent).toContain("Dispatched.");
    expect(runtime.textContent).toContain("Finished.");

    runtime.querySelector('[data-action="view-session"]').click();
    expect(viewEvents).toEqual([
      expect.objectContaining({
        id: "task-1",
        dispatch: expect.objectContaining({ childSessionId: "session-abc" }),
      }),
    ]);
  });

  it("disables View Session until the child session id is bound", async () => {
    mockConfig({
      tasks: [
        {
          id: "task-1",
          status: "running",
          title: "Running task",
          dispatch: {
            targetProject: "/Users/me/project",
            childPort: 47822,
            childSessionId: null,
          },
        },
      ],
    });

    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    runtime.querySelector(".runtime-task-card").click();

    const viewBtn = runtime.querySelector('[data-action="view-session"]');
    expect(viewBtn).not.toBeNull();
    expect(viewBtn.disabled).toBe(true);
  });

  it("opens the panel on pending tasks from keyboard and badge requests", async () => {
    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    document.dispatchEvent(
      new CustomEvent("sa-open-runtime", {
        detail: { filter: "pending" },
      }),
    );

    expect(runtime.classList.contains("collapsed")).toBe(false);
    expect(runtime.querySelector('[data-filter="pending"]').classList.contains("active")).toBe(
      true,
    );

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "I",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );

    expect(runtime.classList.contains("collapsed")).toBe(true);
  });

  it("shows blocked and clarification tasks as active work with source context", async () => {
    mockConfig({
      tasks: [
        {
          id: "task-1",
          status: "needs_input",
          title: "Clarify OAuth flow",
          description: "Which tenant should the agent use?",
          source: {
            channel: "telegram",
            conversationId: "chat-42",
            userId: "user-7",
            messageId: "msg-9",
          },
        },
        {
          id: "task-2",
          status: "blocked",
          title: "Blocked deploy",
          result: {
            failReason: "Missing credentials.",
          },
        },
      ],
    });

    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.querySelector("[data-running-count]").textContent).toBe("2");
    expect(
      runtime.querySelector('[data-task-id="task-1"]').classList.contains("status-needs_input"),
    ).toBe(true);
    expect(
      runtime.querySelector('[data-task-id="task-2"]').classList.contains("status-blocked"),
    ).toBe(true);

    runtime.querySelector('[data-task-id="task-1"]').click();
    runtime.querySelector('[data-task-id="task-2"]').click();

    expect(runtime.textContent).toContain("Source: telegram");
    expect(runtime.textContent).toContain("Missing credentials.");
  });
});
