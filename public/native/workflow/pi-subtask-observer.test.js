import { describe, expect, it } from "vitest";
import { PiSubtaskObserver } from "./pi-subtask-observer.js";

function startEvent(toolCallId, args) {
  return { type: "tool_execution_start", toolCallId, toolName: "subagent", args };
}

function result(agent, task, exitCode, text, extra = {}) {
  return {
    agent,
    task,
    exitCode,
    messages: text ? [{ role: "assistant", content: [{ type: "text", text }] }] : [],
    ...extra,
  };
}

describe("PiSubtaskObserver", () => {
  it("ignores ordinary Pi tools and malformed subagent calls", () => {
    const observer = new PiSubtaskObserver();

    expect(
      observer.consume({
        type: "tool_execution_start",
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "README.md" },
      }),
    ).toBe(false);
    expect(observer.consume(startEvent("bad-1", { agent: "planner" }))).toBe(false);
    expect(observer.snapshot()).toEqual({ nodes: [], edges: [] });
  });

  it("maps a single subagent lifecycle and its structured summaries", () => {
    const observer = new PiSubtaskObserver();
    const args = { agent: "planner", task: "Inspect the graph" };
    expect(observer.consume(startEvent("single-1", args))).toBe(true);

    let graph = observer.snapshot();
    expect(graph.nodes.map(({ kind, status }) => [kind, status])).toEqual([
      ["invocation", "running"],
      ["subtask", "running"],
    ]);
    expect(graph.edges).toEqual([
      {
        id: "pi-subagent:single-1:spawn:0",
        source: "pi-subagent:single-1",
        target: "pi-subtask:single-1:0",
      },
    ]);

    expect(
      observer.consume({
        type: "tool_execution_update",
        toolCallId: "single-1",
        toolName: "subagent",
        args,
        partialResult: { details: { results: [result("planner", args.task, -1, "Working")] } },
      }),
    ).toBe(true);
    graph = observer.snapshot();
    expect(graph.nodes[1]).toMatchObject({ status: "running", summary: "Working" });

    expect(
      observer.consume({
        type: "tool_execution_end",
        toolCallId: "single-1",
        toolName: "subagent",
        result: { details: { results: [result("planner", args.task, 0, "Plan ready")] } },
        isError: false,
      }),
    ).toBe(true);
    graph = observer.snapshot();
    expect(graph.nodes[0].status).toBe("success");
    expect(graph.nodes[1]).toMatchObject({ status: "success", summary: "Plan ready" });
  });

  it("maps parallel results to fan-out edges and task states", () => {
    const observer = new PiSubtaskObserver();
    const args = {
      tasks: [
        { agent: "scout", task: "Find the caller" },
        { agent: "reviewer", task: "Check the schema" },
      ],
    };
    expect(observer.consume(startEvent("parallel-1", args))).toBe(true);
    expect(observer.snapshot().edges).toHaveLength(2);

    observer.consume({
      type: "tool_execution_update",
      toolCallId: "parallel-1",
      toolName: "subagent",
      args,
      partialResult: {
        details: {
          results: [
            result("scout", args.tasks[0].task, -1, "Searching"),
            result("reviewer", args.tasks[1].task, 0, "Schema checked"),
          ],
        },
      },
    });
    expect(
      observer
        .snapshot()
        .nodes.slice(1)
        .map((node) => node.status),
    ).toEqual(["running", "success"]);

    observer.consume({
      type: "tool_execution_end",
      toolCallId: "parallel-1",
      toolName: "subagent",
      result: {
        details: {
          results: [
            result("scout", args.tasks[0].task, 0, "Caller found"),
            result("reviewer", args.tasks[1].task, 1, "", { stderr: "Invalid schema" }),
          ],
        },
      },
      isError: true,
    });
    expect(observer.snapshot().nodes.map((node) => node.status)).toEqual([
      "error",
      "success",
      "error",
    ]);
    expect(observer.snapshot().nodes[2].summary).toBe("Invalid schema");
  });

  it("maps a chain into sequential task edges", () => {
    const observer = new PiSubtaskObserver();
    const args = {
      chain: [
        { agent: "scout", task: "Find the API" },
        { agent: "planner", task: "Plan around {previous}" },
        { agent: "reviewer", task: "Review {previous}" },
      ],
    };
    expect(observer.consume(startEvent("chain-1", args))).toBe(true);
    expect(observer.snapshot().edges).toEqual([
      {
        id: "pi-subagent:chain-1:spawn:0",
        source: "pi-subagent:chain-1",
        target: "pi-subtask:chain-1:0",
      },
      {
        id: "pi-subagent:chain-1:chain:1",
        source: "pi-subtask:chain-1:0",
        target: "pi-subtask:chain-1:1",
      },
      {
        id: "pi-subagent:chain-1:chain:2",
        source: "pi-subtask:chain-1:1",
        target: "pi-subtask:chain-1:2",
      },
    ]);

    observer.consume({
      type: "tool_execution_end",
      toolCallId: "chain-1",
      toolName: "subagent",
      result: {
        details: {
          results: args.chain.map(({ agent, task }) => result(agent, task, 0, "Done")),
        },
      },
      isError: false,
    });
    expect(observer.snapshot().nodes.map((node) => node.status)).toEqual([
      "success",
      "success",
      "success",
      "success",
    ]);
  });

  it("caps concurrent in-flight invocations at twenty", () => {
    const observer = new PiSubtaskObserver();

    for (let index = 0; index < 20; index += 1) {
      expect(
        observer.consume(startEvent(`active-${index}`, { agent: "worker", task: `Task ${index}` })),
      ).toBe(true);
    }
    expect(
      observer.consume(startEvent("active-overflow", { agent: "worker", task: "Overflow" })),
    ).toBe(false);
    expect(observer.snapshot().nodes.filter((node) => node.kind === "invocation")).toHaveLength(20);
  });
});
