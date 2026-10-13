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

describe("super-agent-runtime panel layout and approval", () => {
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

  it("keeps task details collapsed until the card is opened", async () => {
    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.textContent).toContain("Feature: Agent Status Indicator");
    expect(runtime.textContent).not.toContain("many implementation notes");
    expect(runtime.querySelector(".runtime-project-select")).toBeNull();

    runtime.querySelector(".runtime-task-card").click();

    expect(runtime.textContent).toContain("many implementation notes");
    expect(runtime.querySelector('[data-action="approve"]')).not.toBeNull();
    expect(runtime.querySelector(".runtime-project-select")).not.toBeNull();
  });

  it("uses the shared side-panel resize handle and close button", async () => {
    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.querySelector(".app-side-panel-resize-handle")).not.toBeNull();
    expect(
      runtime.querySelector('[data-collapse-btn][aria-label="Close activity panel"]'),
    ).not.toBeNull();
  });

  it("starts collapsed by default unless the user explicitly left it open", () => {
    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    expect(runtime.classList.contains("collapsed")).toBe(true);

    document.body.innerHTML = "";
    localStorage.setItem("sa-runtime-collapsed", "0");
    const reopenedRuntime = new Runtime();
    document.body.appendChild(reopenedRuntime);

    expect(reopenedRuntime.classList.contains("collapsed")).toBe(false);
  });

  it("shows the task panel body immediately while the first task fetch is pending", () => {
    window.__picotConfigCall = vi.fn(() => new Promise(() => {}));

    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    expect(runtime.querySelector("[data-task-list]").textContent).toContain("Connecting");
    expect(runtime.querySelector("[data-pending-count]").textContent).toBe("0");
  });

  it("places bulk actions below the scrollable task list", () => {
    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    const taskList = runtime.querySelector("[data-task-list]");
    const bulkActions = runtime.querySelector("[data-bulk-actions]");

    expect(taskList.compareDocumentPosition(bulkActions) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("sends a task to the main chat instead of opening edit or ask forms", async () => {
    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    const promptedTasks = [];
    runtime.addEventListener("sa-prompt-task", (event) => promptedTasks.push(event.detail));
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    runtime.querySelector('[data-action="prompt-task"]').click();

    expect(promptedTasks).toEqual([
      expect.objectContaining({ id: "task-1", title: "Feature: Agent Status Indicator" }),
    ]);
    expect(runtime.querySelector('[data-action="edit"]')).toBeNull();
    expect(runtime.querySelector('[data-action="ask"]')).toBeNull();
  });

  it("formats markdown-like task descriptions into readable sections", async () => {
    mockConfig({
      tasks: [
        {
          id: "task-1",
          status: "pending",
          title: "Feature: Agent Status Indicator",
          description:
            "Add a real-time agent status indicator. ## Status States - [Idle] **Idle** — Pi is waiting for input - [Working] **Working** — Pi is actively processing ## Goal Users should not switch panes. ## Implementation Hints 1. Detect state changes 2. Show the status dot",
          targetProject: "/Users/me/project",
        },
      ],
    });

    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    runtime.querySelector(".runtime-task-card").click();

    expect(runtime.querySelectorAll(".runtime-task-section-title")).toHaveLength(3);
    expect(runtime.querySelector(".runtime-task-desc").textContent).not.toContain("##");
    expect(runtime.querySelector(".runtime-task-desc").textContent).not.toContain("**Idle**");
    expect(
      [...runtime.querySelectorAll(".runtime-task-list-item")].map((item) => item.textContent),
    ).toEqual([
      "[Idle] Idle — Pi is waiting for input",
      "[Working] Working — Pi is actively processing",
      "Detect state changes",
      "Show the status dot",
    ]);
  });

  it("approves with the project chosen at task creation", async () => {
    const call = mockConfig({
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
    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    runtime.querySelector(".runtime-task-card").click();

    expect(runtime.querySelector(".runtime-project-select")).not.toBeNull();
    expect(runtime.textContent).toContain("Project: project");

    runtime.querySelector('[data-action="approve"]').click();

    await Promise.resolve();

    const written = lastWrittenTasks(call);
    expect(written).toContainEqual(
      expect.objectContaining({ targetProject: "/Users/me/project", status: "running" }),
    );
  });

  it("does not allow approval when a task was created without a project", async () => {
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

    expect(runtime.querySelector('[data-action="approve"]')).toBeNull();
    expect(runtime.querySelector(".runtime-project-select")).not.toBeNull();
    expect(runtime.querySelector('[data-action="select-project"]')).toBeInstanceOf(
      HTMLSelectElement,
    );
    expect(
      runtime
        .querySelector('[data-action="select-project"]')
        .classList.contains("ui-select-native"),
    ).toBe(true);
    expect(runtime.querySelector(".ui-select[role='combobox']")).not.toBeNull();
    expect(runtime.textContent).toContain("Choose a project before approval");

    expect(call).not.toHaveBeenCalledWith("write_super_agent_tasks", expect.anything());
  });
});
