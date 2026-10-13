import { describe, expect, it } from "vitest";
import { isTransientConnectionError, provisionalTargetFromRoute } from "./session-hydration.js";

describe("session-hydration helpers", () => {
  it("builds provisional bootstrap target from route", () => {
    expect(provisionalTargetFromRoute({ workspaceId: "ws-1", sessionId: "s-1" })).toEqual({
      workspaceId: "ws-1",
      sessionId: "s-1",
      instanceId: "pending-bootstrap",
    });
  });

  it("identifies transient WebSocket connection errors", () => {
    expect(isTransientConnectionError(new Error("Pipline Host runtime is disconnected"))).toBe(
      true,
    );
    expect(
      isTransientConnectionError(new Error("Runtime disconnected before the request completed")),
    ).toBe(true);
    expect(isTransientConnectionError(new Error("Host disconnected before the snapshot"))).toBe(
      true,
    );
    expect(isTransientConnectionError(new Error("Permanent syntax error"))).toBe(false);
  });
});
