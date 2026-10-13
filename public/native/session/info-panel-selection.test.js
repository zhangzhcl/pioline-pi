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

describe("InfoPanel selection", () => {
  const entries = [
    u("u1", null, "JWT or cookie?"),
    a("a1", "u1", "Recommendation"),
    u("jwt", "a1", "Implement JWT"),
    a("jwtA", "jwt", "JWT done"),
    u("cookie", "a1", "Implement cookie"),
    a("cookieA", "cookie", "Cookie done"),
  ];

  function makeSelectionPanel(overrides = {}) {
    return makePanel({
      actions: { copyWorkspacePath: async () => "" },
      ...overrides,
    });
  }

  function rowEl(panel, id) {
    return panel.querySelector(`.info-panel-row[data-entry-id="${id}"]`);
  }

  function withScrollIntoViewStub(fn) {
    const proto = Element.prototype;
    const original = proto.scrollIntoView;
    const stub = vi.fn();
    proto.scrollIntoView = stub;
    try {
      return fn(stub);
    } finally {
      if (original === undefined) delete proto.scrollIntoView;
      else proto.scrollIntoView = original;
    }
  }

  test("selectEntry applies .selected to the matching row and moves it between rows", () => {
    const { info, panel } = makeSelectionPanel();
    info.updateTree({ entries, leafId: "jwtA" });

    info.selectEntry("jwt");
    expect(rowEl(panel, "jwt").classList.contains("selected")).toBe(true);
    expect(rowEl(panel, "u1").classList.contains("selected")).toBe(false);

    info.selectEntry("u1");
    expect(rowEl(panel, "u1").classList.contains("selected")).toBe(true);
    expect(rowEl(panel, "jwt").classList.contains("selected")).toBe(false);
  });

  test("selectEntry(null) clears the selection from every row", () => {
    const { info, panel } = makeSelectionPanel();
    info.updateTree({ entries, leafId: "jwtA" });
    info.selectEntry("jwt");
    info.selectEntry(null);
    expect(info.selectedEntryId).toBeNull();
    expect(panel.querySelectorAll(".info-panel-row.selected")).toHaveLength(0);
  });

  test("clicking an active row selects it; clicking another moves the selection", () => {
    const { info, panel } = makeSelectionPanel();
    info.updateTree({ entries, leafId: "jwtA" });

    rowEl(panel, "jwt").click();
    expect(rowEl(panel, "jwt").classList.contains("selected")).toBe(true);

    rowEl(panel, "u1").click();
    expect(rowEl(panel, "u1").classList.contains("selected")).toBe(true);
    expect(rowEl(panel, "jwt").classList.contains("selected")).toBe(false);
  });

  test("clicking an inactive row changes nothing", () => {
    const { info, panel } = makeSelectionPanel();
    info.updateTree({ entries, leafId: "jwtA" });
    info.expandedBranches.add("cookie");
    info._renderTree();

    const inactive = rowEl(panel, "cookie");
    expect(inactive).not.toBeNull();
    inactive.click();
    expect(panel.querySelectorAll(".info-panel-row.selected")).toHaveLength(0);
  });

  test("scrollToSelectedEntry scrolls the selected row into view", () => {
    withScrollIntoViewStub(() => {
      const { info, panel } = makeSelectionPanel();
      info.updateTree({ entries, leafId: "jwtA" });
      info.selectEntry("u1");

      const scrollIntoView = vi.fn();
      rowEl(panel, "u1").scrollIntoView = scrollIntoView;
      info.scrollToSelectedEntry();
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
      expect(info._pendingSelectedScroll).toBe(false);
    });
  });

  test("hidden panel defers the scroll; the next full rebuild consumes it", () => {
    withScrollIntoViewStub((scrollIntoView) => {
      const { info, panel } = makeSelectionPanel();
      panel.classList.add("hidden");
      info.updateTree({ entries, leafId: "jwtA" });

      info.selectEntry("u1");
      info.scrollToSelectedEntry();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(info._pendingSelectedScroll).toBe(true);

      panel.classList.remove("hidden");
      info.updateTree({ entries, leafId: "jwtA" });
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(info._pendingSelectedScroll).toBe(false);
      expect(rowEl(panel, "u1").classList.contains("selected")).toBe(true);
    });
  });

  test("unknown entry id marks no row and never throws", () => {
    const { info, panel } = makeSelectionPanel();
    info.updateTree({ entries, leafId: "jwtA" });
    info.selectEntry("ghost-id");
    expect(panel.querySelectorAll(".info-panel-row.selected")).toHaveLength(0);

    expect(() => info.scrollToSelectedEntry()).not.toThrow();
    expect(() => info.updateTree({ entries, leafId: "jwtA" })).not.toThrow();
  });
});
