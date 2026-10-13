import { describe, expect, it, vi } from "vitest";
import { createSubagentCatalog, parseSubagentTask, SUBAGENTS } from "./subagent-catalog.js";

describe("subagent-catalog", () => {
  it("parses complete and incomplete subagent commands", () => {
    expect(parseSubagentTask("#claude review diff")).toEqual({
      agent: SUBAGENTS[0],
      task: "review diff",
    });
    expect(parseSubagentTask("/codex fix failing tests")).toEqual({
      agent: SUBAGENTS[2],
      task: "fix failing tests",
    });
    expect(parseSubagentTask("#gemini   ")).toEqual({
      agent: SUBAGENTS[1],
      incomplete: true,
    });
    expect(parseSubagentTask("hello world")).toBeNull();
  });

  it("lazily filters agents by host ACP detection and returns empty when SSH remote is active", async () => {
    const listAcpAgents = vi.fn().mockResolvedValue([{ id: "claude-code" }, { id: "codex" }]);
    let remote = false;
    const catalog = createSubagentCatalog({
      control: { listAcpAgents },
      isSshRemoteActive: () => remote,
    });

    // 首次调用触发异步探测，尚未完成前返回全量列表
    expect(catalog.getAgents()).toHaveLength(SUBAGENTS.length);
    expect(listAcpAgents).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    expect(catalog.getAgents().map((a) => a.id)).toEqual(["claude-code", "codex"]);

    remote = true;
    expect(catalog.getAgents()).toEqual([]);
  });
});
