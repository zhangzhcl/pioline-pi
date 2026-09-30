import { describe, expect, it, vi } from "vitest";

vi.mock("../../i18n.js", () => ({ t: (key) => key }));

import { createPiAgentExecutor } from "./pi-agent-executor.js";

function createRuntime(responseText, onPrompt) {
  let listener;
  let snapshotCount = 0;
  const assistantMessage = {
    id: "assistant-response",
    role: "assistant",
    content: [{ type: "text", text: responseText }],
  };
  return {
    subscribe(callback) {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    async request(request, target) {
      if (request.type !== "prompt") return {};
      onPrompt?.(request.message);
      for (const type of ["agent_start", "agent_end", "agent_settled"])
        listener?.({ type: "runtime_event", target, event: { type } });
      return {};
    },
    async snapshot() {
      snapshotCount += 1;
      return { state: { messages: snapshotCount === 1 ? [] : [assistantMessage] } };
    },
  };
}

async function execute(
  responseText,
  outputs,
  edges = [],
  onPrompt,
  { workflowOverrides = {}, nodeMetas = new Map() } = {},
) {
  const target = { workspaceId: "workspace", sessionId: "session", instanceId: "target" };
  const executor = createPiAgentExecutor({
    runtime: createRuntime(responseText, onPrompt),
    getTarget: () => target,
  });
  return executor({
    node: { instanceId: "pi-node" },
    meta: { outputs },
    inputs: { context: {} },
    params: { prompt: "Return the requested result." },
    workflow: {
      id: "workflow",
      name: "Workflow",
      revision: 1,
      nodes: [],
      edges,
      ...workflowOverrides,
    },
    nodeMetas,
    signal: new AbortController().signal,
    log: () => {},
  });
}

describe("Pi Agent structured output", () => {
  it("shares graph identity without exposing NodeMeta source or parameter values", async () => {
    const prompts = [];
    await execute("done", [{ name: "content" }], [], (prompt) => prompts.push(prompt), {
      workflowOverrides: {
        nodes: [
          {
            instanceId: "custom-node",
            meta: { id: "custom.lookup", version: "1.0.0" },
            paramValues: { token: "SECRET_PARAMETER_MARKER" },
          },
        ],
        edges: [],
      },
      nodeMetas: new Map([
        [
          "custom.lookup@1.0.0",
          {
            id: "custom.lookup",
            version: "1.0.0",
            type: "custom",
            label: "Lookup",
            runnableCode: { source: "SECRET_SOURCE_MARKER" },
            implementationDraft: { source: "SECRET_DRAFT_MARKER" },
          },
        ],
      ]),
    });

    expect(prompts[0]).toContain('"id":"custom.lookup"');
    expect(prompts[0]).toContain('"label":"Lookup"');
    expect(prompts[0]).not.toContain("SECRET_SOURCE_MARKER");
    expect(prompts[0]).not.toContain("SECRET_DRAFT_MARKER");
    expect(prompts[0]).not.toContain("SECRET_PARAMETER_MARKER");
  });

  it("returns parsed JSON objects when the node declares a JSON output", async () => {
    const value = { answer: 42, labels: ["pi", "workflow"] };
    await expect(
      execute(JSON.stringify(value), [{ name: "content" }, { name: "json" }]),
    ).resolves.toEqual({
      content: JSON.stringify(value),
      json: value,
    });
  });

  it("keeps text output when the response is not JSON", async () => {
    await expect(execute("plain text", [{ name: "content" }, { name: "json" }])).resolves.toEqual({
      content: "plain text",
    });
  });

  it("does not add undeclared outputs to legacy Pi Agent nodes", async () => {
    await expect(execute('{"ok":true}', [{ name: "content" }])).resolves.toEqual({
      content: '{"ok":true}',
    });
  });

  it("requests a JSON object when a downstream node consumes the JSON output", async () => {
    const prompts = [];
    await execute(
      '{"ok":true}',
      [{ name: "content" }, { name: "json" }],
      [{ sourceNodeId: "pi-node", sourcePort: "json" }],
      (prompt) => prompts.push(prompt),
    );

    expect(prompts[0]).toContain("workflow.piAgentPromptJsonOnly");
  });

  it("aborts the active Pi session and settles the node as cancelled", async () => {
    let listener;
    let promptStarted;
    const started = new Promise((resolve) => {
      promptStarted = resolve;
    });
    const requests = [];
    const runtime = {
      subscribe(callback) {
        listener = callback;
        return () => {
          listener = null;
        };
      },
      async request(request, target) {
        requests.push(request.type);
        if (request.type === "prompt") {
          listener?.({ type: "runtime_event", target, event: { type: "agent_start" } });
          promptStarted();
        }
        return {};
      },
      async snapshot() {
        return { state: { messages: [] } };
      },
    };
    const target = { workspaceId: "workspace", sessionId: "session", instanceId: "target" };
    let piRunning = false;
    const executor = createPiAgentExecutor({
      runtime,
      getTarget: () => target,
      onPiRunningChange: (running) => {
        piRunning = running;
      },
    });
    const controller = new AbortController();
    const resultPromise = executor({
      node: { instanceId: "pi-node" },
      meta: { outputs: [{ name: "content" }] },
      inputs: { context: {} },
      params: { prompt: "Do work" },
      workflow: { id: "workflow", name: "Workflow", revision: 1, nodes: [], edges: [] },
      signal: controller.signal,
      log: () => {},
    });

    await started;
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toContain("abort");
    expect(piRunning).toBe(false);
    expect(listener).toBeNull();
  });

  it("does not send the Pi prompt when cancelled while preparing the session snapshot", async () => {
    let resolveSnapshot;
    let snapshotStarted;
    const started = new Promise((resolve) => {
      snapshotStarted = resolve;
    });
    const snapshot = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    const requests = [];
    const runtime = {
      subscribe: () => () => {},
      async request(request) {
        requests.push(request.type);
        return {};
      },
      async snapshot() {
        snapshotStarted();
        return snapshot;
      },
    };
    const controller = new AbortController();
    const executor = createPiAgentExecutor({
      runtime,
      getTarget: () => ({ workspaceId: "workspace", sessionId: "session", instanceId: "target" }),
    });
    const result = executor({
      node: { instanceId: "pi-node" },
      meta: { outputs: [{ name: "content" }] },
      inputs: { context: {} },
      params: { prompt: "Do work" },
      workflow: { id: "workflow", name: "Workflow", revision: 1, nodes: [], edges: [] },
      signal: controller.signal,
      log: () => {},
    });

    await started;
    controller.abort();
    resolveSnapshot({ state: { messages: [] } });

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toContain("abort");
    expect(requests).not.toContain("prompt");
  });
});
