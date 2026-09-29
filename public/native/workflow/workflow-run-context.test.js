import { describe, expect, it } from "vitest";
import { workflowRunContextSummary } from "./workflow-run-context.js";

const localizeNodeMeta = (meta) => (meta ? { label: meta.label } : undefined);
const nodeMetaKey = (meta) => `${meta.id}@${meta.version}`;

describe("workflowRunContextSummary", () => {
  it("gives Pi the authoritative Run status, progress, active nodes, errors, logs, and events", () => {
    const run = {
      id: "run-1",
      status: "running",
      workflowRevision: 7,
      maxConcurrency: 2,
      snapshot: {
        nodes: [
          { instanceId: "start-1", meta: { id: "pipline.start", version: "1" } },
          { instanceId: "agent-1", meta: { id: "pipline.agent", version: "1" } },
          { instanceId: "end-1", meta: { id: "pipline.end", version: "1" } },
        ],
      },
      nodeStates: {
        "start-1": { status: "success", output: { value: "input" } },
        "agent-1": { status: "running", logs: ["Calling Pi", "Waiting for response"] },
        "end-1": { status: "idle" },
      },
      events: [
        { type: "node_completed", nodeId: "start-1", message: "Start completed" },
        { type: "node_started", nodeId: "agent-1", message: "Agent started" },
      ],
    };
    const activeNodeMetas = new Map([
      ["pipline.start@1", { id: "pipline.start", version: "1", label: "Start" }],
      ["pipline.agent@1", { id: "pipline.agent", version: "1", label: "Pi Agent" }],
      ["pipline.end@1", { id: "pipline.end", version: "1", label: "End" }],
    ]);

    const summary = workflowRunContextSummary({
      run,
      activeNodeMetas,
      localizeNodeMeta,
      nodeMetaKey,
    });

    expect(summary).toMatchObject({
      id: "run-1",
      status: "running",
      workflowRevision: 7,
      maxConcurrency: 2,
      progress: { total: 3, running: 1, waiting: 1, succeeded: 1, failed: 0 },
      activeNodes: [{ instanceId: "agent-1", label: "Pi Agent", type: "unknown" }],
      nodes: [
        { instanceId: "start-1", label: "Start", status: "success", output: { value: "input" } },
        {
          instanceId: "agent-1",
          label: "Pi Agent",
          status: "running",
          recentLogs: ["Calling Pi", "Waiting for response"],
        },
        { instanceId: "end-1", label: "End", status: "idle" },
      ],
      recentEvents: [
        {
          type: "node_completed",
          nodeId: "start-1",
          nodeLabel: "Start",
          message: "Start completed",
        },
        {
          type: "node_started",
          nodeId: "agent-1",
          nodeLabel: "Pi Agent",
          message: "Agent started",
        },
      ],
    });
  });

  it("bounds node and event history and clips untrusted error and log text", () => {
    const nodes = Array.from({ length: 105 }, (_, index) => ({
      instanceId: `node-${index}`,
      meta: { id: "custom.node", version: "1" },
    }));
    const events = Array.from({ length: 20 }, (_, index) => ({
      type: `event-${index}`,
      message: "m".repeat(500),
    }));
    const summary = workflowRunContextSummary({
      run: {
        id: "run-bounded",
        status: "error",
        snapshot: { nodes },
        nodeStates: {
          "node-0": { status: "error", error: "e".repeat(1200), logs: ["l".repeat(500)] },
        },
        events,
        error: "r".repeat(2500),
      },
      activeNodeMetas: new Map(),
      localizeNodeMeta,
      nodeMetaKey,
    });

    expect(summary.nodes).toHaveLength(100);
    expect(summary.omittedNodeCount).toBe(5);
    expect(summary.recentEvents).toHaveLength(16);
    expect(summary.recentEvents[0].type).toBe("event-4");
    expect(summary.recentEvents[0].message).toHaveLength(400);
    expect(summary.nodes[0].error).toHaveLength(1000);
    expect(summary.nodes[0].recentLogs[0]).toHaveLength(400);
    expect(summary.error).toHaveLength(2000);
  });

  it("shares the final Run result with Pi and bounds oversized results", () => {
    const summary = workflowRunContextSummary({
      run: {
        id: "run-result",
        status: "success",
        result: { answer: 42, text: "<b>literal</b>" },
        snapshot: { nodes: [] },
        nodeStates: {},
        events: [],
      },
      activeNodeMetas: new Map(),
      localizeNodeMeta,
      nodeMetaKey,
    });
    const oversized = workflowRunContextSummary({
      run: {
        id: "run-large-result",
        status: "success",
        result: "x".repeat(10_000),
        snapshot: { nodes: [] },
        nodeStates: {},
        events: [],
      },
      activeNodeMetas: new Map(),
      localizeNodeMeta,
      nodeMetaKey,
    });

    expect(summary.result).toEqual({ answer: 42, text: "<b>literal</b>" });
    expect(oversized.result).toMatchObject({ truncated: true });
    expect(oversized.result.preview).toHaveLength(8_000);
  });

  it("returns null when there is no Run to report", () => {
    expect(
      workflowRunContextSummary({
        run: null,
        activeNodeMetas: new Map(),
        localizeNodeMeta,
        nodeMetaKey,
      }),
    ).toBeNull();
  });
});
