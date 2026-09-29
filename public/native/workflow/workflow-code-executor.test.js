import { describe, expect, it, vi } from "vitest";
import { createWorkflowCodeExecutor } from "./workflow-code-executor.js";

describe("workflow code executor bridge", () => {
  it("sends only the active Run node and resolved inputs through Host", async () => {
    const executeWorkflowCode = vi.fn().mockResolvedValue({
      output: { result: "done" },
      logs: ["step 1"],
    });
    const log = vi.fn();
    const execute = createWorkflowCodeExecutor({ executeWorkflowCode });
    const controller = new AbortController();

    await expect(
      execute({
        node: { instanceId: "node-1" },
        workflow: { workspaceId: "workspace-1" },
        runId: "run-1",
        inputs: { prompt: "hello" },
        params: { ignored: "Host reads frozen params" },
        signal: controller.signal,
        log,
      }),
    ).resolves.toEqual({ result: "done" });

    expect(executeWorkflowCode).toHaveBeenCalledWith({
      runId: "run-1",
      workspaceId: "workspace-1",
      nodeId: "node-1",
      inputs: { prompt: "hello" },
      signal: controller.signal,
    });
    expect(log).toHaveBeenCalledWith("step 1");
  });
});
