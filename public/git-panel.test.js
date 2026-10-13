// ABOUTME: Verifies Git panel rendering, grouping, and safe text handling.
// ABOUTME: Covers the panel's explicit four-group projection without filesystem side effects.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitPanel } from "./git-panel.js";
import { initI18n } from "./i18n.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

beforeEach(async () => {
  document.body.replaceChildren();
  const panel = document.createElement("div");
  panel.id = "panel";
  document.body.append(panel);
  globalThis.fetch = vi.fn(async (input) => {
    if (String(input).includes("/locales/en.json")) {
      return new Response(JSON.stringify(enMessages));
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  await initI18n();
});

describe("GitPanel rendering and staging actions", () => {
  it("renders four groups and repository paths as text", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.setSnapshot({
      entries: [
        { entryKind: "ordinary", xy: "M.", displayPath: "<unsafe>.js" },
        { entryKind: "ordinary", xy: ".M", displayPath: "changed.js" },
        { entryKind: "untracked", displayPath: "new.js" },
        { entryKind: "unmerged", displayPath: "conflict.js" },
      ],
    });
    expect(panel.container.textContent).toContain("<unsafe>.js");
    expect(panel.container.querySelectorAll("section")).toHaveLength(4);
    expect(panel.container.querySelector("script")).toBeNull();
  });

  it("shows the not-a-repository message instead of no-status when setNotGitRepo is set", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.setNotGitRepo(true);
    expect(panel.container.textContent).toContain("This workspace is not a Git repository");
    expect(panel.container.textContent).not.toContain("No Git status loaded");

    panel.setSnapshot({ entries: [{ entryKind: "ordinary", xy: ".M", displayPath: "app.js" }] });
    expect(panel.container.textContent).toContain("app.js");
    expect(panel.container.textContent).not.toContain("This workspace is not a Git repository");
  });

  it("only treats the most recent status probe failure as not-a-repository", () => {
    const command = vi.fn().mockReturnValue("git-7");
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command },
    });
    void panel.refresh();
    expect(panel.isStatusFailure("git-7")).toBe(true);
    expect(panel.isStatusFailure("git-6")).toBe(false);
    expect(panel.isStatusFailure(null)).toBe(false);
    expect(panel.isStatusFailure(undefined)).toBe(false);

    panel.setSnapshot({ entries: [] });
    expect(panel.isStatusFailure("git-7")).toBe(false);
  });

  it("renders commit controls but leaves status refresh to the shared sidebar header", () => {
    const command = vi.fn();
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command },
    });
    panel.setSnapshot({
      branch: "feature/panel",
      upstream: "origin/feature/panel",
      ahead: 2,
      behind: 1,
      counts: { staged: 1, changes: 2, untracked: 3 },
      changeStats: { additions: 5, deletions: 4 },
      entries: [],
    });

    const toolbar = panel.container.querySelector(".git-panel-toolbar");
    expect(toolbar?.querySelector(".git-panel-summary")?.textContent).toContain("feature/panel");
    expect(toolbar?.querySelector(".git-panel-refresh")).toBeNull();
    expect(panel.container.querySelector(".git-panel-commit")).not.toBeNull();
    expect(panel.container.querySelector(".git-panel-stats")).not.toBeNull();
  });

  it("renders group headers as session-list style section headers with a disclosure chevron", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.setSnapshot({
      entries: [
        { entryKind: "ordinary", xy: ".M", displayPath: "src/app.js", pathBytesBase64: "YQ==" },
      ],
    });

    const header = panel.container.querySelector(".git-group-heading");
    expect(header.classList.contains("sidebar-section-header")).toBe(true);
    expect(header.getAttribute("role")).toBe("button");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    const chevron = header.querySelector(".section-chevron");
    expect(chevron).not.toBeNull();
    expect(chevron.querySelector("svg")).not.toBeNull();
    expect(header.querySelector(".sidebar-section-title")?.textContent).toBe("Staged");
    expect(header.querySelector(".sidebar-section-count")?.textContent).toBe("0");
  });

  it("renders directories and files as distinct tree rows", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.setSnapshot({
      entries: [
        { entryKind: "ordinary", xy: ".M", displayPath: "src/app.js", pathBytesBase64: "YQ==" },
      ],
    });

    expect(
      panel.container.querySelector(".git-directory-heading")?.classList.contains("git-tree-row"),
    ).toBe(true);
    expect(panel.container.querySelector(".git-entry")?.classList.contains("git-tree-row")).toBe(
      true,
    );
    expect(
      panel.container.querySelector(".git-directory-heading .git-tree-folder-icon svg"),
    ).not.toBeNull();
    expect(panel.container.querySelector(".git-directory-heading.collapsed")).toBeNull();
  });

  it("shows a mixed index/worktree entry in both actionable groups", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.setSnapshot({
      entries: [
        {
          entryKind: "ordinary",
          xy: "MM",
          displayPath: "mixed.js",
          pathBytesBase64: "bWl4ZWQuanM=",
        },
      ],
    });
    expect(panel.container.querySelectorAll(".git-entry")).toHaveLength(2);
  });

  it("requests only the allowed write operation for each group", () => {
    const write = vi.fn();
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), write },
    });
    const staged = {
      entryKind: "ordinary",
      xy: "M.",
      displayPath: "staged.js",
      pathBytesBase64: "c3RhZ2VkLmpz",
    };
    const changed = {
      entryKind: "ordinary",
      xy: ".M",
      displayPath: "changed.js",
      pathBytesBase64: "Y2hhbmdlZC5qcw==",
    };
    panel.setSnapshot({ snapshotId: "snapshot", entries: [staged, changed] });
    expect(panel.write("stage", [staged])).toBeNull();
    panel.write("unstage", [staged]);
    panel.write("discard", [changed]);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("stages a partial-stage file from the changes group with group=changes", () => {
    const write = vi.fn();
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), write },
    });
    const partial = {
      entryKind: "ordinary",
      xy: "MM",
      displayPath: "partial.js",
      pathBytesBase64: "cGFydGlhbC5qcw==",
    };
    panel.setSnapshot({ snapshotId: "snapshot", entries: [partial] });
    panel.write("stage", [partial], "changes");
    expect(write).toHaveBeenCalledTimes(1);
    const sent = write.mock.calls[0][2];
    expect(sent).toHaveLength(1);
    expect(sent[0].group).toBe("changes");
  });

  it("passes the clicked entry alongside a correlated diff request", () => {
    const openDiff = vi.fn();
    const onDiffRequest = vi.fn();
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      openDiff,
      onDiffRequest,
      client: { diff: vi.fn(() => "git-diff-1") },
    });
    const entry = {
      entryKind: "untracked",
      displayPath: "new.js",
      pathBytesBase64: "bmV3Lmpz",
    };
    panel.setSnapshot({ snapshotId: "snapshot", entries: [entry] });
    [...panel.container.querySelectorAll(".git-entry")][0].click();
    expect(onDiffRequest).toHaveBeenCalledWith("git-diff-1", {
      ...entry,
      comparison: "untracked",
    });
    expect(openDiff).not.toHaveBeenCalled();
  });

  it("renders nested directory tree and truncation notice", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.setSnapshot({
      snapshotId: "snap",
      totalEntryCount: 1500,
      returnedEntryCount: 1200,
      entries: [
        {
          entryKind: "ordinary",
          xy: ".M",
          displayPath: "src/a.js",
          pathBytesBase64: "c3JjL2EuanM=",
        },
        {
          entryKind: "ordinary",
          xy: ".M",
          displayPath: "src/b.js",
          pathBytesBase64: "c3JjL2IuanM=",
        },
      ],
    });
    expect(panel.container.querySelectorAll(".git-directory-heading")).toHaveLength(1);
    expect(panel.container.querySelectorAll(".git-entry")).toHaveLength(2);
    const notice = panel.container.querySelector(".git-truncation-notice");
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain("300");
  });

  it("accumulates shift-selection and batch-stages only selected", () => {
    const write = vi.fn();
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), write },
    });
    const e1 = {
      entryKind: "ordinary",
      xy: ".M",
      displayPath: "a.js",
      pathBytesBase64: "YWE=",
    };
    const e2 = {
      entryKind: "ordinary",
      xy: ".M",
      displayPath: "b.js",
      pathBytesBase64: "YmI=",
    };
    panel.setSnapshot({ snapshotId: "snap", entries: [e1, e2] });
    const rows = panel.container.querySelectorAll(".git-entry");
    const shiftClick = new MouseEvent("click", { bubbles: true, shiftKey: true });
    rows[0].dispatchEvent(shiftClick);
    rows[1].dispatchEvent(shiftClick);
    const stageBtn = [...panel.container.querySelectorAll(".git-group-actions button")].find((b) =>
      b.textContent.toLowerCase().includes("stage"),
    );
    stageBtn.click();
    expect(write).toHaveBeenCalledTimes(1);
    const batch = write.mock.calls[0][2];
    expect(batch).toHaveLength(2);
  });
});
