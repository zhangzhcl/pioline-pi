import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowModeTargetSynchronizer,
  getWorkflowModeTargetTransition,
} from "./workflow-mode-target.js";

const makeTarget = (workspaceId, sessionId, instanceId = `instance-${sessionId}`) => ({
  workspaceId,
  sessionId,
  instanceId,
});

describe("workflow mode session target transitions", () => {
  it("disables the previous session when the next target is missing", () => {
    const previousTarget = makeTarget("workspace-a", "session-a");

    expect(getWorkflowModeTargetTransition(previousTarget, null, "workspace-a")).toEqual({
      disableTarget: previousTarget,
      enableTarget: null,
      nextTarget: null,
    });
  });

  it("disables the previous session when the target belongs to another workspace", () => {
    const previousTarget = makeTarget("workspace-a", "session-a");
    const foreignTarget = makeTarget("workspace-b", "session-b");

    expect(getWorkflowModeTargetTransition(previousTarget, foreignTarget, "workspace-a")).toEqual({
      disableTarget: previousTarget,
      enableTarget: null,
      nextTarget: null,
    });
  });

  it("rejects targets without non-empty string workspace and session ids", () => {
    const invalidTargets = [
      makeTarget(null, "session-a"),
      makeTarget("workspace-a", 42),
      makeTarget("", "session-a"),
      { ...makeTarget("workspace-a", "session-a"), instanceId: null },
    ];

    for (const target of invalidTargets) {
      expect(getWorkflowModeTargetTransition(null, target, target.workspaceId)).toEqual({
        disableTarget: null,
        enableTarget: null,
        nextTarget: null,
      });
    }
  });

  it("switches the enabled workflow tool from the old session to the new one", () => {
    const previousTarget = makeTarget("workspace-a", "session-a");
    const nextTarget = makeTarget("workspace-a", "session-b");

    expect(getWorkflowModeTargetTransition(previousTarget, nextTarget, "workspace-a")).toEqual({
      disableTarget: previousTarget,
      enableTarget: nextTarget,
      nextTarget,
    });
  });

  it("switches instances when the same session is rebound to a new Pi runtime", () => {
    const previousTarget = {
      workspaceId: "workspace-a",
      sessionId: "session-a",
      instanceId: "instance-old",
    };
    const nextTarget = { ...previousTarget, instanceId: "instance-new" };

    expect(getWorkflowModeTargetTransition(previousTarget, nextTarget, "workspace-a")).toEqual({
      disableTarget: previousTarget,
      enableTarget: nextTarget,
      nextTarget,
    });
  });

  it("moves workflow tools when the Pi instance restarts within the same session", async () => {
    const previous = makeTarget("workspace-a", "session-a", "instance-old");
    const next = makeTarget("workspace-a", "session-a", "instance-new");
    let target = previous;
    const setToolsEnabled = vi.fn(async () => {});
    const synchronizer = createWorkflowModeTargetSynchronizer({
      getTarget: () => target,
      getWorkspaceId: () => "workspace-a",
      isOpen: () => true,
      setToolsEnabled,
    });

    await synchronizer.sync();
    target = next;
    await synchronizer.sync();

    expect(setToolsEnabled.mock.calls).toEqual([
      [true, previous],
      [false, previous],
      [true, next],
    ]);
  });

  it("does not toggle tools when the enabled target is unchanged", () => {
    const currentTarget = makeTarget("workspace-a", "session-a");

    expect(
      getWorkflowModeTargetTransition(currentTarget, { ...currentTarget }, "workspace-a"),
    ).toEqual({
      disableTarget: null,
      enableTarget: null,
      nextTarget: currentTarget,
    });
  });

  it("disables the old session then enables the newly selected one", async () => {
    const current = makeTarget("workspace-a", "session-a");
    const next = makeTarget("workspace-a", "session-b");
    let target = current;
    const setToolsEnabled = vi.fn(async () => {});
    const synchronizer = createWorkflowModeTargetSynchronizer({
      getTarget: () => target,
      getWorkspaceId: () => "workspace-a",
      isOpen: () => true,
      setToolsEnabled,
    });

    await synchronizer.sync();
    target = next;
    await synchronizer.sync();

    expect(setToolsEnabled.mock.calls).toEqual([
      [true, current],
      [false, current],
      [true, next],
    ]);
  });

  it("disables a target whose enable completes after the workflow window closes", async () => {
    const target = makeTarget("workspace-a", "session-a");
    let open = true;
    let finishEnable;
    const enablePending = new Promise((resolve) => {
      finishEnable = resolve;
    });
    const setToolsEnabled = vi.fn((enabled) => (enabled ? enablePending : Promise.resolve()));
    const synchronizer = createWorkflowModeTargetSynchronizer({
      getTarget: () => target,
      getWorkspaceId: () => "workspace-a",
      isOpen: () => open,
      setToolsEnabled,
    });

    const syncing = synchronizer.sync();
    await vi.waitFor(() => expect(setToolsEnabled).toHaveBeenCalledWith(true, target));
    open = false;
    const closing = synchronizer.close();
    finishEnable();
    await Promise.all([syncing, closing]);

    expect(setToolsEnabled.mock.calls).toEqual([
      [true, target],
      [false, target],
    ]);
  });

  it("skips stale queued targets when the foreground session changes rapidly", async () => {
    const first = makeTarget("workspace-a", "session-a");
    const skipped = makeTarget("workspace-a", "session-b");
    const latest = makeTarget("workspace-a", "session-c");
    let target = first;
    let finishFirstEnable;
    const firstEnable = new Promise((resolve) => {
      finishFirstEnable = resolve;
    });
    const setToolsEnabled = vi.fn((enabled, modeTarget) =>
      enabled && modeTarget === first ? firstEnable : Promise.resolve(),
    );
    const synchronizer = createWorkflowModeTargetSynchronizer({
      getTarget: () => target,
      getWorkspaceId: () => "workspace-a",
      isOpen: () => true,
      setToolsEnabled,
    });

    const firstSync = synchronizer.sync();
    await vi.waitFor(() => expect(setToolsEnabled).toHaveBeenCalledWith(true, first));
    target = skipped;
    const skippedSync = synchronizer.sync();
    target = latest;
    const latestSync = synchronizer.sync();
    finishFirstEnable();
    await Promise.all([firstSync, skippedSync, latestSync]);

    expect(setToolsEnabled.mock.calls).toEqual([
      [true, first],
      [false, first],
      [true, latest],
    ]);
  });

  it("retries enabling the same session after close and reopen", async () => {
    const target = makeTarget("workspace-a", "session-a");
    let open = true;
    const setToolsEnabled = vi.fn(async () => {});
    const synchronizer = createWorkflowModeTargetSynchronizer({
      getTarget: () => target,
      getWorkspaceId: () => "workspace-a",
      isOpen: () => open,
      setToolsEnabled,
    });

    await synchronizer.sync();
    open = false;
    await synchronizer.close();
    open = true;
    await synchronizer.sync();

    expect(setToolsEnabled.mock.calls).toEqual([
      [true, target],
      [false, target],
      [true, target],
    ]);
  });

  it("retries a failed close cleanup before reopening workflow mode", async () => {
    const target = makeTarget("workspace-a", "session-a");
    let open = true;
    let failDisable = true;
    const setToolsEnabled = vi.fn(async (enabled) => {
      if (!enabled && failDisable) {
        failDisable = false;
        throw new Error("Pi session is reconnecting");
      }
    });
    const synchronizer = createWorkflowModeTargetSynchronizer({
      getTarget: () => target,
      getWorkspaceId: () => "workspace-a",
      isOpen: () => open,
      setToolsEnabled,
    });

    await synchronizer.sync();
    open = false;
    await expect(synchronizer.close()).rejects.toThrow("Pi session is reconnecting");
    open = true;
    await synchronizer.sync();

    expect(setToolsEnabled.mock.calls).toEqual([
      [true, target],
      [false, target],
      [false, target],
      [true, target],
    ]);
  });

  it("keeps the current session usable when disabling the stale session fails", async () => {
    const current = makeTarget("workspace-a", "session-a");
    const next = makeTarget("workspace-a", "session-b");
    let target = current;
    let failFirstDisable = true;
    const setToolsEnabled = vi.fn(async (enabled, modeTarget) => {
      if (!enabled && modeTarget === current && failFirstDisable) {
        failFirstDisable = false;
        throw new Error("old session disconnected");
      }
    });
    const synchronizer = createWorkflowModeTargetSynchronizer({
      getTarget: () => target,
      getWorkspaceId: () => "workspace-a",
      isOpen: () => true,
      setToolsEnabled,
    });

    await synchronizer.sync();
    target = next;
    await synchronizer.sync();
    await synchronizer.sync();

    expect(setToolsEnabled.mock.calls).toEqual([
      [true, current],
      [false, current],
      [true, next],
      [false, current],
    ]);
  });
});
