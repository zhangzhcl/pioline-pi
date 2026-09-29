import { describe, expect, it } from "vitest";
import { shouldApplyInitialDiskHistory } from "./initial-session-history.js";

describe("shouldApplyInitialDiskHistory", () => {
  const current = {
    expectedSessionId: "session-a",
    currentSessionId: "session-a",
    diskMessages: [{ role: "user" }, { role: "assistant" }],
    currentSequence: 12,
  };

  it("accepts disk history before the Pi snapshot has rendered", () => {
    expect(shouldApplyInitialDiskHistory(current)).toBe(true);
  });

  it("does not replace an active Pi turn before the initial snapshot", () => {
    expect(
      shouldApplyInitialDiskHistory({
        ...current,
        currentLifecycle: "working",
      }),
    ).toBe(false);
  });

  it("waits until an in-flight Pi snapshot has finished applying", () => {
    expect(
      shouldApplyInitialDiskHistory({
        ...current,
        snapshotStarted: true,
      }),
    ).toBe(false);
  });

  it("accepts a longer disk history after an unchanged Pi snapshot", () => {
    expect(
      shouldApplyInitialDiskHistory({
        ...current,
        snapshot: { messageCount: 1, sequence: 12 },
      }),
    ).toBe(true);
  });

  it("does not replace the Pi snapshot with shorter or equal disk history", () => {
    expect(
      shouldApplyInitialDiskHistory({
        ...current,
        diskMessages: [{ role: "user" }],
        snapshot: { messageCount: 1, sequence: 12 },
      }),
    ).toBe(false);
    expect(
      shouldApplyInitialDiskHistory({
        ...current,
        snapshot: { messageCount: 2, sequence: 12 },
      }),
    ).toBe(false);
  });

  it("does not replace history after the Pi state has advanced or the session changed", () => {
    expect(
      shouldApplyInitialDiskHistory({
        ...current,
        currentSequence: 13,
        snapshot: { messageCount: 1, sequence: 12 },
      }),
    ).toBe(false);
    expect(
      shouldApplyInitialDiskHistory({
        ...current,
        currentSessionId: "session-b",
      }),
    ).toBe(false);
  });

  it("does not replace history while Pi is working", () => {
    expect(
      shouldApplyInitialDiskHistory({
        ...current,
        currentLifecycle: "working",
        snapshot: { messageCount: 1, sequence: 12 },
      }),
    ).toBe(false);
  });

  it("ignores empty or invalid disk results", () => {
    expect(shouldApplyInitialDiskHistory({ ...current, diskMessages: [] })).toBe(false);
    expect(shouldApplyInitialDiskHistory({ ...current, diskMessages: null })).toBe(false);
  });
});
