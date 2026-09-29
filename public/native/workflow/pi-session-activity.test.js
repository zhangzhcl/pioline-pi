import { describe, expect, it } from "vitest";
import { createPiSessionActivity } from "./pi-session-activity.js";

const firstTarget = { workspaceId: "workspace", sessionId: "first", instanceId: "agent" };
const secondTarget = { workspaceId: "workspace", sessionId: "second", instanceId: "agent" };

function createRuntime(resolveState) {
  let listener = null;
  const requests = [];
  return {
    requests,
    subscribe(callback) {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    request(command, target) {
      requests.push({ command, target });
      return resolveState(target);
    },
    emit(frame) {
      listener?.(frame);
    },
  };
}

function stateResponse(isStreaming, isCompacting = false) {
  return {
    type: "runtime_response",
    response: { success: true, data: { isStreaming, isCompacting } },
  };
}

describe("Pi session activity", () => {
  it("reads current stream and compaction state when attaching to a session", async () => {
    const runtime = createRuntime(async () => stateResponse(false, true));
    const activity = createPiSessionActivity(runtime);

    const sync = activity.setTarget(firstTarget);
    expect(activity.getBusy()).toBe(true);
    await sync;

    expect(runtime.requests).toEqual([{ command: { type: "get_state" }, target: firstTarget }]);
    expect(activity.getBusy()).toBe(true);
  });

  it("follows agent_start through agent_end until agent_settled", async () => {
    const runtime = createRuntime(async () => stateResponse(false));
    const activity = createPiSessionActivity(runtime);
    await activity.setTarget(firstTarget);

    runtime.emit({
      type: "runtime_event",
      target: firstTarget,
      event: { type: "agent_start" },
    });
    expect(activity.getBusy()).toBe(true);

    runtime.emit({
      type: "runtime_event",
      target: firstTarget,
      event: { type: "agent_end", willRetry: true },
    });
    expect(activity.getBusy()).toBe(true);

    runtime.emit({
      type: "runtime_event",
      target: firstTarget,
      event: { type: "agent_settled" },
    });
    expect(activity.getBusy()).toBe(false);
  });

  it("ignores events from sessions other than the selected target", async () => {
    const runtime = createRuntime(async () => stateResponse(false));
    const activity = createPiSessionActivity(runtime);
    await activity.setTarget(firstTarget);

    runtime.emit({
      type: "runtime_event",
      target: secondTarget,
      event: { type: "agent_start" },
    });

    expect(activity.getBusy()).toBe(false);
  });

  it("does not let a stale idle snapshot overwrite a newer agent_start event", async () => {
    let resolveSnapshot;
    const runtime = createRuntime(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const activity = createPiSessionActivity(runtime);

    const sync = activity.setTarget(firstTarget);
    runtime.emit({
      type: "runtime_event",
      target: firstTarget,
      event: { type: "agent_start" },
    });
    resolveSnapshot(stateResponse(false));
    await sync;

    expect(activity.getBusy()).toBe(true);
  });

  it("ignores an old session snapshot after the workflow window switches sessions", async () => {
    const resolvers = new Map();
    const runtime = createRuntime(
      (target) =>
        new Promise((resolve) => {
          resolvers.set(target.sessionId, resolve);
        }),
    );
    const activity = createPiSessionActivity(runtime);

    const firstSync = activity.setTarget(firstTarget);
    const secondSync = activity.setTarget(secondTarget);
    resolvers.get("first")(stateResponse(true));
    await firstSync;
    expect(activity.getBusy()).toBe(true);

    resolvers.get("second")(stateResponse(false));
    await secondSync;
    expect(activity.getBusy()).toBe(false);
  });

  it("resynchronizes on reconnect and fails closed while the runtime is disconnected", async () => {
    const runtime = createRuntime(async () => stateResponse(false));
    const activity = createPiSessionActivity(runtime);
    await activity.setTarget(firstTarget);
    expect(activity.getBusy()).toBe(false);

    runtime.emit({ type: "runtime_connection", connected: false });
    expect(activity.getBusy()).toBe(true);

    runtime.emit({ type: "runtime_connection", connected: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.requests).toHaveLength(2);
    expect(activity.getBusy()).toBe(false);
  });

  it("disposes its listener and clears the target", async () => {
    const runtime = createRuntime(async () => stateResponse(true));
    const activity = createPiSessionActivity(runtime);
    await activity.setTarget(firstTarget);
    expect(activity.getBusy()).toBe(true);

    activity.dispose();
    runtime.emit({
      type: "runtime_event",
      target: firstTarget,
      event: { type: "agent_start" },
    });

    expect(activity.getBusy()).toBe(false);
  });
});
