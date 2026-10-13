// ABOUTME: Unit tests for the Info panel view (workspace actions + session tree).
// Ported from picot-v3 5dd2bb9; navigation callbacks stay injected so the
// component remains independent from runtime transport details.
import { describe, expect, test, vi } from "vitest";
import { InfoPanel } from "./info-panel.js";

const t = (key, params = {}) => {
  const dict = {
    "infoPanel.title": "Info",
    "infoPanel.workspace": "Workspace",
    "infoPanel.copyPath": "Copy path",
    "infoPanel.copied": "Copied",
    "infoPanel.sessionHistory": "Session history",
    "infoPanel.activePath": "Active path",
    "infoPanel.branch": "Branch",
    "infoPanel.turns": "{count} turns",
    "infoPanel.empty": "No messages yet",
    "infoPanel.roleUser": "You",
    "infoPanel.roleAssistant": "Assistant",
    "infoPanel.statusError": "Error",
    "infoPanel.statusAborted": "Aborted",
    "infoPanel.imageMessage": "Image",
    "infoPanel.resumeBranch": "Resume branch",
    "infoPanel.resumeStreamingBlocked": "Resume unavailable while streaming",
    "sessionInfo.heading": "Session Info",
    "sessionInfo.file": "File",
    "sessionInfo.id": "ID",
    "sessionInfo.inMemory": "In memory (not saved yet)",
    "sessionInfo.unavailable": "Unavailable",
    "sessionInfo.copyFile": "Copy file path",
    "sessionInfo.copyId": "Copy session ID",
    "sessionInfo.copied": "Copied",
    "sessionInfo.copyFailed": "Copy failed",
    "sessionInfo.aiTitle": "AI analysis",
    "sessionInfo.aiRun": "Analyze with AI",
    "sessionInfo.aiRerun": "Re-analyze",
    "sessionInfo.aiAnalyzing": "Analyzing…",
    "sessionInfo.aiFailed": "Analysis failed.",
    "sessionInfo.aiNoTurns": "Nothing to analyse yet",
    "sessionInfo.aiBusy": "Available when the task finishes",
    "sessionInfo.aiHint": "Ask the model to read the run log",
  };
  let out = dict[key] ?? key;
  for (const [name, value] of Object.entries(params)) {
    out = out.replace(`{${name}}`, String(value));
  }
  return out;
};

function u(id, parentId, content) {
  return { type: "message", id, parentId, message: { role: "user", content } };
}
function a(id, parentId, content) {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content: [{ type: "text", text: content }], stopReason: "stop" },
  };
}

function makePanel(overrides = {}) {
  const panel = document.createElement("aside");
  const actions = {
    copyWorkspacePath: vi.fn(async () => "/wsp/path"),
  };
  const options = {
    panel,
    actions,
    t,
    ...overrides,
  };
  const info = new InfoPanel(options);
  return { info, panel, actions };
}

describe("InfoPanel workspace section", () => {
  test("renders the copy path icon and Session Info with visible, truncatable values", () => {
    const { panel } = makePanel();
    const copy = panel.querySelector(".info-panel-copy-path");
    expect(copy).not.toBeNull();
    expect(copy.getAttribute("aria-label")).toBe("Copy path");
    expect(copy.textContent).not.toContain("Copy path");
    expect(panel.querySelector(".info-panel-link")).toBeNull();
    expect(panel.querySelector(".info-panel-link-app")).toBeNull();
    expect(panel.querySelector("#info-panel-session-heading").textContent).toBe("Session Info");

    const fileValue = panel.querySelector('[data-session-field="file"]');
    const idValue = panel.querySelector('[data-session-field="id"]');
    const fileCopy = panel.querySelector('[data-copy-session-field="file"]');
    const idCopy = panel.querySelector('[data-copy-session-field="id"]');
    expect(fileValue.textContent).toBe("In memory (not saved yet)");
    expect(idValue.textContent).toBe("Unavailable");
    expect(fileCopy).not.toBeNull();
    expect(idCopy).not.toBeNull();
    expect(fileCopy.querySelector("svg")).not.toBeNull();
    expect(idCopy.querySelector("svg")).not.toBeNull();
    expect(fileCopy.title).toBe("Copy file path");
    expect(idCopy.title).toBe("Copy session ID");
  });

  test("updateSessionInfo exposes the file path and session id as visible values", () => {
    const { info, panel } = makePanel();
    info.updateSessionInfo({
      filePath: "/sessions/a.jsonl",
      sessionId: "session-a",
    });
    const fileValue = panel.querySelector('[data-session-field="file"]');
    const idValue = panel.querySelector('[data-session-field="id"]');
    const fileCopy = panel.querySelector('[data-copy-session-field="file"]');
    const idCopy = panel.querySelector('[data-copy-session-field="id"]');
    expect(fileValue.textContent).toBe("a.jsonl");
    expect(fileValue.title).toBe("/sessions/a.jsonl");
    expect(fileCopy.getAttribute("aria-label")).toBe("File: /sessions/a.jsonl · Copy file path");
    expect(fileCopy.dataset.copyValue).toBe("/sessions/a.jsonl");
    expect(idValue.textContent).toBe("session-a");
    expect(idCopy.getAttribute("aria-label")).toBe("ID: session-a · Copy session ID");
    expect(idCopy.dataset.copyValue).toBe("session-a");
  });

  test("updateWorkspace updates the path text and title", () => {
    const { info, panel } = makePanel();
    info.updateWorkspace("/tmp/alpha/beta");
    const path = panel.querySelector(".info-panel-path");
    expect(path.textContent).toBe("/tmp/alpha/beta");
    expect(path.title).toBe("/tmp/alpha/beta");
  });

  test("copy icon swaps aria-label to Copied and reverts", async () => {
    vi.useFakeTimers();
    try {
      const { panel, actions } = makePanel();
      const copy = panel.querySelector(".info-panel-copy-path");
      copy.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(actions.copyWorkspacePath).toHaveBeenCalled();
      expect(copy.getAttribute("aria-label")).toBe("Copied");
      expect(copy.title).toBe("Copied");
      vi.advanceTimersByTime(1300);
      expect(copy.getAttribute("aria-label")).toBe("Copy path");
      expect(copy.title).toBe("Copy path");
    } finally {
      vi.useRealTimers();
    }
  });

  test("session info copy buttons write the painted fields", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { info, panel } = makePanel({ writeText });
    info.updateSessionInfo({ filePath: "/sessions/a.jsonl", sessionId: "session-a" });
    panel.querySelector('[data-copy-session-field="file"]').click();
    panel.querySelector('[data-copy-session-field="id"]').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenNthCalledWith(1, "/sessions/a.jsonl");
    expect(writeText).toHaveBeenNthCalledWith(2, "session-a");
  });

  test("session file value shows the basename with the full path in its tooltip, and copies the full path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { info, panel } = makePanel({ writeText });
    const filePath =
      "/Users/ShixinGuo/.pi/agent/sessions/picot/2026-08-28T06-21-25-01a04707-0620-750f-a29a-5bc353f97d06.jsonl";
    const sessionId = "01a04707-0620-750f-a29a-5bc353f97d06";
    info.updateSessionInfo({ filePath, sessionId });
    const fileValue = panel.querySelector('[data-session-field="file"]');
    const idValue = panel.querySelector('[data-session-field="id"]');
    const fileCopy = panel.querySelector('[data-copy-session-field="file"]');
    expect(fileValue.title).toBe(filePath);
    expect(fileValue.textContent).toBe(
      "2026-08-28T06-21-25-01a04707-0620-750f-a29a-5bc353f97d06.jsonl",
    );
    expect(idValue.title).toBe(sessionId);
    fileCopy.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(filePath));
    await vi.waitFor(() => expect(fileCopy.getAttribute("aria-label")).toBe("Copied"));
  });

  test("mounts the injected task analysis section above the session tree", () => {
    const taskAnalysis = {
      element: document.createElement("section"),
      resetHistory: vi.fn(),
    };
    taskAnalysis.element.className = "session-analysis";
    const { info, panel } = makePanel({ taskAnalysis });

    const scroll = panel.querySelector(".info-panel-scroll");
    expect(scroll).not.toBeNull();
    expect(scroll.firstElementChild).toBe(taskAnalysis.element);
    expect(scroll.querySelector(".info-panel-history")).not.toBeNull();

    info.updateSessionInfo({ filePath: "/sessions/a.jsonl", sessionId: "session-a" });
    expect(taskAnalysis.resetHistory).toHaveBeenCalledTimes(1);
    info.updateSessionInfo({ filePath: "/sessions/a.jsonl", sessionId: "session-a" });
    expect(taskAnalysis.resetHistory).toHaveBeenCalledTimes(1);
  });

  test("works without a task analysis section", () => {
    const { panel } = makePanel();
    expect(panel.querySelector(".info-panel-scroll")).not.toBeNull();
    expect(panel.querySelector(".session-analysis")).toBeNull();
  });
});

describe("InfoPanel session history", () => {
  const entries = [
    u("u1", null, "JWT or cookie?"),
    a("a1", "u1", "Recommendation"),
    u("jwt", "a1", "Implement JWT"),
    a("jwtA", "jwt", "JWT done"),
    u("cookie", "a1", "Implement cookie"),
    a("cookieA", "cookie", "Cookie done"),
  ];

  test("active path nodes are buttons; inactive branch collapses to a summary", () => {
    const { panel } = makePanel({ onNavigateLeaf: vi.fn() });
    const info = new InfoPanel({
      panel,
      actions: { copyWorkspacePath: async () => "" },
      t,
    });
    info.updateTree({ entries, leafId: "jwtA" });

    const activeRows = [...panel.querySelectorAll(".info-panel-row.active")];
    expect(activeRows.map((r) => r.dataset.entryId)).toEqual(["u1", "a1", "jwt", "jwtA"]);
    expect(activeRows.every((r) => r.tagName === "BUTTON")).toBe(true);
    expect(activeRows.every((r) => r.getAttribute("role") === "treeitem")).toBe(true);

    const summary = panel.querySelector(".info-panel-branch-summary");
    expect(summary).not.toBeNull();
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.textContent).toContain("1 turns");
    expect(panel.querySelector(".info-panel-row.inactive")).toBeNull();
    expect(panel.querySelector(".info-panel-resume")).toBeNull();
  });

  test("expanding a branch reveals inactive rows with a Resume action on leaves", () => {
    const onNavigateLeaf = vi.fn();
    const { info, panel } = makePanel({
      onNavigateLeaf,
      actions: { copyWorkspacePath: async () => "" },
    });
    info.updateTree({ entries, leafId: "jwtA" });
    panel.querySelector(".info-panel-branch-summary").click();

    const summary = panel.querySelector(".info-panel-branch-summary");
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    const inactive = [...panel.querySelectorAll(".info-panel-row.inactive")];
    expect(inactive.map((r) => r.dataset.entryId)).toEqual(["cookie", "cookieA"]);
    expect(inactive.every((r) => r.tagName === "DIV")).toBe(true);
    expect(inactive.every((r) => r.getAttribute("aria-disabled") === "true")).toBe(true);
    const resume = panel.querySelector('.info-panel-resume[aria-label*="Cookie done"]');
    expect(resume).not.toBeNull();
    resume.click();
    expect(onNavigateLeaf).toHaveBeenCalledWith("cookieA");
  });

  test("disables Resume while the runtime is streaming", () => {
    const { info, panel } = makePanel({
      isStreaming: () => true,
      onNavigateLeaf: vi.fn(),
    });
    info.updateTree({ entries, leafId: "jwtA" });
    panel.querySelector(".info-panel-branch-summary").click();
    const resume = panel.querySelector(".info-panel-resume");
    expect(resume.disabled).toBe(true);
    expect(resume.title).toBe("Resume unavailable while streaming");
  });

  test("clicking an active node selects the Info row and scrolls the anchored message", () => {
    const scrollIntoView = vi.fn();
    const target = document.createElement("div");
    target.dataset.entryId = "jwt";
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);
    try {
      const info = new InfoPanel({
        panel: document.createElement("aside"),
        actions: { copyWorkspacePath: async () => "" },
        t,
      });
      info.updateTree({ entries, leafId: "jwtA" });
      const row = [...info.panel.querySelectorAll(".info-panel-row.active")].find(
        (r) => r.dataset.entryId === "jwt",
      );
      row.click();
      expect(row.classList.contains("selected")).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    } finally {
      target.remove();
    }
  });

  test("clicking an active assistant node scrolls the anchored assistant message", () => {
    const scrollIntoView = vi.fn();
    const target = document.createElement("div");
    target.dataset.entryId = "jwtA";
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);
    try {
      const info = new InfoPanel({
        panel: document.createElement("aside"),
        actions: { copyWorkspacePath: async () => "" },
        t,
      });
      info.updateTree({ entries, leafId: "jwtA" });
      const row = [...info.panel.querySelectorAll(".info-panel-row.active")].find(
        (r) => r.dataset.entryId === "jwtA",
      );
      row.click();
      expect(row.classList.contains("selected")).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    } finally {
      target.remove();
    }
  });

  test("empty tree renders the empty state", () => {
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { copyWorkspacePath: async () => "" },
      t,
    });
    info.updateTree({ entries: [], leafId: null });
    expect(info.panel.querySelector(".info-panel-tree-empty").textContent).toBe("No messages yet");
  });

  test("history heading leaves refresh control to the panel header", () => {
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { copyWorkspacePath: async () => "" },
      t,
    });
    expect(info.panel.querySelector(".info-panel-refresh-btn")).toBeNull();
  });

  test("stale expand state is pruned when the tree changes", () => {
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { copyWorkspacePath: async () => "" },
      t,
    });
    info.updateTree({ entries, leafId: "jwtA" });
    info.expandedBranches.add("cookie");
    info.expandedBranches.add("vanished-branch");
    info.updateTree({ entries, leafId: "cookieA" });
    expect(info.expandedBranches.has("vanished-branch")).toBe(false);
    expect(info.expandedBranches.has("cookie")).toBe(false);
  });

  test("current leaf row carries the marker class", () => {
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { copyWorkspacePath: async () => "" },
      t,
    });
    info.updateTree({ entries, leafId: "jwtA" });
    const current = info.panel.querySelector(".info-panel-row.current-leaf");
    expect(current.dataset.entryId).toBe("jwtA");
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(
      [...info.panel.querySelectorAll(".info-panel-row")].filter(
        (r) => r.getAttribute("aria-current") === "true",
      ).length,
    ).toBe(1);
  });
});
