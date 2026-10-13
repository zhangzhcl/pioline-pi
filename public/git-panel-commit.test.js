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

describe("GitPanel commit and AI dialogs", () => {
  it("re-enables the submit button after a confirmation-required token arrives", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), commit: vi.fn() },
    });
    panel.aiSnapshot = { snapshotId: "ai-snap" };
    panel.commitMessage = "feat: x";
    panel.openCommitDialog();
    panel.setCommitInProgress(true);
    expect(document.body.querySelector(".git-commit-submit").disabled).toBe(true);
    panel.applyConfirmationToken("token-123");
    expect(panel.commitInProgress).toBe(false);
    expect(document.body.querySelector(".git-commit-submit").disabled).toBe(false);
    expect(panel.pendingConfirmationToken).toBe("token-123");
    panel.closeCommitDialog();
  });

  it("keeps the dialog open with the error when commit result is failed", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), commit: vi.fn() },
    });
    panel.aiSnapshot = { snapshotId: "ai-snap" };
    panel.commitMessage = "my message";
    panel.openCommitDialog();
    panel.setCommitInProgress(true);
    panel.applyCommitResult({ status: "failed", error: "hook says no" });
    expect(panel.commitInProgress).toBe(false);
    expect(panel.commitMessage).toBe("my message");
    expect(document.body.querySelector(".git-commit-dialog")).not.toBeNull();
    expect(document.body.querySelector(".git-commit-error").textContent).toContain("hook says no");
    panel.closeCommitDialog();
  });

  it("prefills the commit dialog when AI succeeds", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), commit: vi.fn() },
    });
    panel.applyAiResult({ snapshotId: "ai-snap" }, "feat: add thing");
    expect(document.body.querySelector(".git-commit-dialog")).not.toBeNull();
    expect(document.body.querySelector(".git-commit-textarea").value).toBe("feat: add thing");
    panel.closeCommitDialog();
  });

  it("closes the commit dialog on Escape", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), commit: vi.fn() },
    });
    panel.applyAiResult({ snapshotId: "ai-snap" }, "feat: add thing");
    expect(document.body.querySelector(".git-commit-dialog")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.body.querySelector(".git-commit-dialog")).toBeNull();
  });

  it("cancels the discard confirm dialog on Escape", async () => {
    const write = vi.fn();
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), write },
    });
    const pending = panel.discard([{ displayPath: "a.js" }]);
    expect(document.body.querySelector(".git-confirm-dialog")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(pending).resolves.toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(document.body.querySelector(".git-confirm-dialog")).toBeNull();
  });

  it("opens the commit dialog with an error and empty message when AI fails", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), commit: vi.fn() },
    });
    panel.aiSnapshot = { snapshotId: "ai-snap" };
    panel.applyAiFailure("timeout");
    expect(document.body.querySelector(".git-commit-error").textContent).toBe("timeout");
    expect(document.body.querySelector(".git-commit-textarea").value).toBe("");
    panel.closeCommitDialog();
  });

  it("falls back to the status snapshot when AI fails before any AI snapshot exists", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), commit: vi.fn() },
    });
    panel.setSnapshot({ snapshotId: "status-snap", entries: [] });
    expect(panel.aiSnapshot).toBeNull();
    panel.applyAiFailure("timeout");
    expect(document.body.querySelector(".git-commit-dialog")).not.toBeNull();
    expect(panel.aiSnapshot.snapshotId).toBe("status-snap");
    panel.closeCommitDialog();
  });

  it("tracks pendingAiRequestId so requestAiCommitMessage records it", () => {
    const aiCommitMessage = vi.fn(() => "ai-req-1");
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), aiCommitMessage },
    });
    panel.setSnapshot({ snapshotId: "snap", entries: [], counts: { staged: 1, conflicted: 0 } });
    const returned = panel.requestAiCommitMessage();
    expect(returned).toBe("ai-req-1");
    expect(panel.pendingAiRequestId).toBe("ai-req-1");
  });

  it("clears pendingAiRequestId on applyAiResult so a stale later response cannot match", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.pendingAiRequestId = "ai-req-1";
    panel.applyAiResult({ snapshotId: "ai-snap" }, "msg");
    expect(panel.pendingAiRequestId).toBeNull();
    panel.closeCommitDialog();
  });

  it("clears pendingAiRequestId on applyAiFailure so a stale later failure cannot match", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.pendingAiRequestId = "ai-req-1";
    panel.applyAiFailure("err");
    expect(panel.pendingAiRequestId).toBeNull();
    panel.closeCommitDialog();
  });

  it("clears pendingCommitRequestId when applyCommitResult succeeds", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.aiSnapshot = { snapshotId: "ai-snap" };
    panel.commitInProgress = true;
    panel.pendingCommitRequestId = "commit-B";
    panel.applyCommitResult({ status: "succeeded", requestId: "commit-B" });
    expect(panel.commitInProgress).toBe(false);
    expect(panel.aiSnapshot).toBeNull();
    expect(panel.pendingCommitRequestId).toBeNull();
  });

  it("clears pendingCommitRequestId when applyCommitResult fails", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.aiSnapshot = { snapshotId: "ai-snap" };
    panel.commitMessage = "my msg";
    panel.pendingCommitRequestId = "commit-B";
    panel.applyCommitResult({ status: "failed", requestId: "commit-B", error: "hook" });
    expect(panel.pendingCommitRequestId).toBeNull();
    expect(panel.aiError).toContain("hook");
    panel.closeCommitDialog();
  });
});

describe("GitPanel push", () => {
  const snapshotWithBranch = (overrides = {}) => ({
    snapshotId: "snap-1",
    branch: "feature",
    upstream: "origin/feature",
    ahead: 2,
    behind: 0,
    entries: [],
    counts: { staged: 0, changes: 0, untracked: 0, conflicted: 0 },
    ...overrides,
  });

  it("sends a push command and disables the button while in flight", () => {
    const push = vi.fn(() => "git-7");
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), push },
    });
    panel.setSnapshot(snapshotWithBranch());
    panel.container.querySelector(".git-panel-push").click();
    expect(push).toHaveBeenCalledTimes(1);
    expect(panel.pushInProgress).toBe(true);
    expect(panel.container.querySelector(".git-panel-push").disabled).toBe(true);
  });

  it("ignores a second click while a push is already running", () => {
    const push = vi.fn(() => "git-7");
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), push },
    });
    panel.setSnapshot(snapshotWithBranch());
    panel.push();
    panel.push();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("disables push on a detached HEAD", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), push: vi.fn() },
    });
    panel.setSnapshot(snapshotWithBranch({ branch: null, headState: "detached" }));
    expect(panel.container.querySelector(".git-panel-push").disabled).toBe(true);
  });

  it("clears the in-flight state and shows no error after a successful push", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), push: vi.fn(() => "git-7") },
    });
    panel.setSnapshot(snapshotWithBranch());
    panel.push();
    panel.applyPushResult({ status: "succeeded", remote: "origin", branch: "feature" });
    expect(panel.pushInProgress).toBe(false);
    expect(panel.container.querySelector(".git-panel-push-error")).toBeNull();
    expect(panel.container.querySelector(".git-panel-push").disabled).toBe(false);
  });

  it("maps backend failure codes onto localized copy", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), push: vi.fn(() => "git-7") },
    });
    panel.setSnapshot(snapshotWithBranch());
    panel.applyPushResult({ status: "failed", error: "push_no_remote" });
    expect(panel.container.querySelector(".git-panel-push-error").textContent).toBe(
      enMessages.git.pushNoRemote,
    );
  });

  it("passes an unrecognized git error through as text", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), push: vi.fn(() => "git-7") },
    });
    panel.setSnapshot(snapshotWithBranch());
    panel.applyPushResult({ status: "failed", error: "! [rejected] feature -> feature" });
    const error = panel.container.querySelector(".git-panel-push-error");
    expect(error.textContent).toBe("! [rejected] feature -> feature");
    expect(panel.container.querySelector("script")).toBeNull();
  });

  it("drops a stale error when the next push starts", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), push: vi.fn(() => "git-7") },
    });
    panel.setSnapshot(snapshotWithBranch());
    panel.applyPushResult({ status: "failed", error: "push_no_remote" });
    panel.push();
    expect(panel.container.querySelector(".git-panel-push-error")).toBeNull();
  });
});
