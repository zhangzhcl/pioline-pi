import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadWorkflowSnapshotForAgentRead } from "../public/native/workflow/workflow-agent-read-snapshot.js";
import { summarizeWorkflowChanges } from "../public/native/workflow/workflow-change-summary.js";

const root = resolve(import.meta.dir, "..");
const { version: piVersion } = await Bun.file(join(root, "scripts", "pi-version.json")).json();
const binary = join(
  root,
  "src-tauri",
  "resources",
  "pi",
  process.platform === "win32" ? "pi.exe" : "pi",
);
const workflowExtension = join(root, "extensions", "dist", "picot-bridge.mjs");
const temp = await mkdtemp(join(tmpdir(), "pipline-workflow-rpc-smoke-"));
const agentDir = join(temp, "pi-agent");
const sessionDir = join(temp, "sessions");
const nodeMetaCandidate = {
  schemaVersion: 1,
  id: "custom.slugify",
  version: "1.0.0",
  type: "custom",
  label: "Slugify",
  description: "Convert English text to a URL slug.",
  inputs: [{ name: "text", label: "Text", type: "string", required: true, allowStaticValue: true }],
  outputs: [{ name: "slug", label: "Slug", type: "string", required: true }],
  params: [],
  execution: { kind: "user-code", entrypoint: "slugify" },
  permissions: { filesystem: "none", network: "none", shell: "none" },
  implementationDraft: {
    language: "typescript",
    source: "export function slugify(text: string) { return text.toLowerCase(); }",
    entryFn: "slugify",
  },
  i18n: Object.fromEntries(
    ["en", "zh", "es", "ja"].map((locale) => [
      locale,
      {
        label: `Slugify ${locale}`,
        description: `Convert text ${locale}.`,
        inputs: { text: `Text ${locale}` },
        outputs: { slug: `Slug ${locale}` },
        params: {},
      },
    ]),
  ),
};
let providerRequests = 0;
let providerSawWorkflowTool = false;
let providerSawWorkflowResult = false;
let providerSawRecentChanges = false;
let providerSawRunSummary = false;
let providerSawProposalApproval = false;
let providerSawNodeMetaApproval = false;
let workflowSearchCalls = 0;
let workflowReadCalls = 0;
let workflowProposalCalls = 0;
let workflowNodeMetaProposalCalls = 0;
const providerRequestSummaries = [];

function toolCallChunk(callId, name, args) {
  return [
    {
      id: "chatcmpl-pipline-workflow-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "workflow-smoke-model",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-pipline-workflow-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "workflow-smoke-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-pipline-workflow-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "workflow-smoke-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

function streamResponse(chunks) {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

const mockProvider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions")
      return new Response("Not found", { status: 404 });
    const body = await request.json();
    if (body.stream !== true)
      return Response.json({ error: "Streaming is required." }, { status: 400 });
    providerRequests += 1;
    providerSawWorkflowTool ||=
      body.tools?.some((tool) => tool.function?.name === "pipline_workflow") ?? false;

    const messages = body.messages ?? [];
    const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
    const currentTurnMessages = messages.slice(lastUserIndex + 1);
    const hasCurrentToolResult = currentTurnMessages.some((message) => message.role === "tool");
    const currentUserTurn = JSON.stringify(messages.slice(Math.max(0, lastUserIndex)));
    const hasSearchRequest = currentUserTurn.includes("请根据需求查找现成的数组筛选工作流节点。");
    const hasReadRequest = currentUserTurn.includes("请概括用户最近对画布做了什么修改。");
    const hasRunReadRequest = currentUserTurn.includes("请查看当前工作流运行状态和结果。");
    const hasProposalRequest = currentUserTurn.includes(
      "请把当前工作流中的 Pi 节点任务改为整理输入，并先向我提议修改。",
    );
    const hasNodeCandidateRequest = currentUserTurn.includes(
      "请为英文文本转 URL slug 查找或生成节点模板，只保存可复用模板，不要加到画布。",
    );
    const toolResultText = currentTurnMessages
      .filter((message) => message.role === "tool")
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");
    providerSawWorkflowResult ||= toolResultText.includes("pipline.filter");
    providerSawRecentChanges ||=
      toolResultText.includes('"recentChanges"') &&
      toolResultText.includes('"actor":"user"') &&
      toolResultText.includes('"type":"set_param"') &&
      !toolResultText.includes("smoke-private-value");
    providerSawRunSummary ||=
      toolResultText.includes('"status":"success"') &&
      toolResultText.includes('"succeeded":3') &&
      toolResultText.includes('"summary":{}');
    providerSawProposalApproval ||=
      hasProposalRequest &&
      toolResultText.includes('"operation":"propose"') &&
      toolResultText.includes('"applied":true');
    providerSawNodeMetaApproval ||=
      hasNodeCandidateRequest &&
      toolResultText.includes('"custom.slugify"') &&
      toolResultText.includes('"executable":false');
    providerRequestSummaries.push({
      hasWorkflowTool:
        body.tools?.some((tool) => tool.function?.name === "pipline_workflow") ?? false,
      hasSearchRequest,
      hasReadRequest,
      hasRunReadRequest,
      hasProposalRequest,
      hasNodeCandidateRequest,
      hasWorkflowResult: toolResultText.includes("pipline.filter"),
      hasRecentChanges: providerSawRecentChanges,
      hasRunSummary: providerSawRunSummary,
      lastUserMessage: messages[lastUserIndex]?.content,
      roles: messages.map((message) => message.role),
    });

    if (
      body.tools?.some((tool) => tool.function?.name === "pipline_workflow") &&
      hasSearchRequest &&
      !hasCurrentToolResult
    ) {
      return streamResponse(
        toolCallChunk("call_pipline_workflow_search", "pipline_workflow", {
          operation: "search_node_templates",
          query: "数组筛选",
          searchLimit: 4,
        }),
      );
    }
    if (
      body.tools?.some((tool) => tool.function?.name === "pipline_workflow") &&
      hasReadRequest &&
      !hasCurrentToolResult
    ) {
      return streamResponse(
        toolCallChunk("call_pipline_workflow_read", "pipline_workflow", {
          operation: "read",
        }),
      );
    }
    if (
      body.tools?.some((tool) => tool.function?.name === "pipline_workflow") &&
      hasRunReadRequest &&
      !hasCurrentToolResult
    ) {
      return streamResponse(
        toolCallChunk("call_pipline_workflow_run_read", "pipline_workflow", {
          operation: "read",
        }),
      );
    }
    if (
      body.tools?.some((tool) => tool.function?.name === "pipline_workflow") &&
      hasProposalRequest &&
      !hasCurrentToolResult
    ) {
      return streamResponse(
        toolCallChunk("call_pipline_workflow_proposal_read", "pipline_workflow", {
          operation: "read",
        }),
      );
    }
    if (
      body.tools?.some((tool) => tool.function?.name === "pipline_workflow") &&
      hasProposalRequest &&
      hasCurrentToolResult &&
      !toolResultText.includes('"applied":true')
    ) {
      return streamResponse(
        toolCallChunk("call_pipline_workflow_propose", "pipline_workflow", {
          operation: "propose",
          baseRevision: 9,
          expectedCatalogRevision: "catalog-smoke-r4",
          operations: [
            {
              type: "set_param",
              instanceId: "pi-node",
              name: "prompt",
              value: "整理输入并输出要点",
            },
          ],
        }),
      );
    }
    if (
      body.tools?.some((tool) => tool.function?.name === "pipline_workflow") &&
      hasNodeCandidateRequest &&
      !hasCurrentToolResult
    ) {
      return streamResponse(
        toolCallChunk("call_pipline_workflow_search_node_candidate", "pipline_workflow", {
          operation: "search_node_templates",
          query: "英文文本 URL slug",
          searchLimit: 4,
        }),
      );
    }
    if (
      body.tools?.some((tool) => tool.function?.name === "pipline_workflow") &&
      hasNodeCandidateRequest &&
      hasCurrentToolResult &&
      !toolResultText.includes('"custom.slugify"')
    ) {
      return streamResponse(
        toolCallChunk("call_pipline_workflow_propose_node_meta", "pipline_workflow", {
          operation: "propose_node_meta",
          expectedCatalogRevision: "catalog-smoke-r4",
          meta: nodeMetaCandidate,
        }),
      );
    }
    if (hasCurrentToolResult) {
      const answer = toolResultText.includes('"applied":true')
        ? "已按你的要求将 Pi 节点调整为整理输入，并通过桌面确认应用。"
        : toolResultText.includes('"custom.slugify"')
          ? "Slugify 模板已保存为可复用节点；其中的源码只是草稿，当前不会执行。"
          : toolResultText.includes('"succeeded":3')
            ? "最近一次 Run 已成功，3/3 个节点完成，结果包含 summary。"
            : toolResultText.includes('"recentChanges"')
              ? "用户最近调整了筛选节点的 predicate 参数，并新增了一条节点连线。"
              : "我找到了筛选节点 pipline.filter@1.0.0。";
      return streamResponse([
        {
          id: "chatcmpl-pipline-workflow-2",
          object: "chat.completion.chunk",
          created: 1,
          model: "workflow-smoke-model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: answer,
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl-pipline-workflow-2",
          object: "chat.completion.chunk",
          created: 1,
          model: "workflow-smoke-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ]);
    }
    return streamResponse([
      {
        id: `chatcmpl-pipline-workflow-aux-${providerRequests}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "workflow-smoke-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Pipline workflow smoke." },
            finish_reason: null,
          },
        ],
      },
      {
        id: `chatcmpl-pipline-workflow-aux-${providerRequests}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "workflow-smoke-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]);
  },
});

await mkdir(agentDir, { recursive: true });
await writeFile(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      "pipline-workflow-smoke": {
        baseUrl: `http://127.0.0.1:${mockProvider.port}/v1`,
        api: "openai-completions",
        apiKey: "pipline-workflow-smoke-key",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [
          {
            id: "workflow-smoke-model",
            name: "Pipline Workflow Smoke Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 256,
          },
        ],
      },
    },
  }),
);

const subprocess = Bun.spawn(
  [
    binary,
    "--mode",
    "rpc",
    "--provider",
    "pipline-workflow-smoke",
    "--model",
    "workflow-smoke-model",
    "--session-dir",
    sessionDir,
    "--extension",
    workflowExtension,
  ],
  {
    cwd: temp,
    env: {
      ...process.env,
      APPDATA: join(temp, "AppData", "Roaming"),
      HOME: temp,
      PI_CODING_AGENT_DIR: agentDir,
      USERPROFILE: temp,
      XDG_CONFIG_HOME: join(temp, ".config"),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  },
);

const pending = new Map();
const observedEvents = [];
let stdoutBuffer = "";
let stderr = "";
let nextId = 1;

const reader = (async () => {
  for await (const chunk of subprocess.stdout) {
    stdoutBuffer += new TextDecoder().decode(chunk, { stream: true });
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      const waiter = frame.id && pending.get(frame.id);
      if (waiter && frame.type === "response") {
        pending.delete(frame.id);
        waiter.resolve(frame);
      } else observedEvents.push(frame);
    }
  }
})();

const stderrReader = (async () => {
  for await (const chunk of subprocess.stderr) stderr += new TextDecoder().decode(chunk);
})();

function request(command, timeoutMs = 15_000) {
  const id = `workflow-smoke-${nextId++}`;
  subprocess.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  return new Promise((resolveRequest, rejectRequest) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`Timed out waiting for ${command.type}. ${stderr}`));
    }, timeoutMs);
    pending.set(id, {
      resolve(value) {
        clearTimeout(timeout);
        resolveRequest(value);
      },
    });
  });
}

async function waitForEvent(type, startIndex = 0, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const index = observedEvents.findIndex(
      (event, offset) => offset >= startIndex && event.type === type,
    );
    if (index >= 0) return { event: observedEvents[index], index };
    if (subprocess.exitCode !== null)
      throw new Error(`Pi exited before ${type} (code ${subprocess.exitCode}). ${stderr}`);
    await Bun.sleep(20);
  }
  throw new Error(
    `Timed out waiting for Pi event ${type}. Events: ${JSON.stringify(observedEvents.map((event) => event.type))}. UI requests: ${JSON.stringify(observedEvents.filter((event) => event.type === "extension_ui_request"))}. Provider: ${JSON.stringify(providerRequestSummaries)}. ${stderr}`,
  );
}

function parseWorkflowRequest(event) {
  const marker = "__PIPLINE_WORKFLOW_TOOL_V1__";
  if (
    event.type !== "extension_ui_request" ||
    event.method !== "input" ||
    event.title !== "Pipline workflow bridge" ||
    typeof event.placeholder !== "string" ||
    !event.placeholder.startsWith(marker)
  )
    return undefined;
  return JSON.parse(event.placeholder.slice(marker.length));
}

async function waitForWorkflowRequest(startIndex, handledIds) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (let index = startIndex; index < observedEvents.length; index += 1) {
      const event = observedEvents[index];
      if (handledIds.has(event.id)) continue;
      const request = parseWorkflowRequest(event);
      if (request) return { event, index, request };
    }
    if (subprocess.exitCode !== null)
      throw new Error(
        `Pi exited before workflow tool request (code ${subprocess.exitCode}). ${stderr}`,
      );
    await Bun.sleep(20);
  }
  throw new Error(
    `Timed out waiting for workflow tool request. UI requests: ${JSON.stringify(observedEvents.filter((event) => event.type === "extension_ui_request"))}. Provider: ${JSON.stringify(providerRequestSummaries)}. ${stderr}`,
  );
}

async function returnWorkflowResult(event, workflowRequest) {
  if (typeof workflowRequest.requestId !== "string")
    throw new Error(`Pi sent a request without an id: ${JSON.stringify(workflowRequest)}`);
  let result;
  if (workflowRequest.operation === "search_node_templates") {
    if (!["数组筛选", "英文文本 URL slug"].includes(workflowRequest.query))
      throw new Error(
        `Pi sent an invalid workflow search request: ${JSON.stringify(workflowRequest)}`,
      );
    workflowSearchCalls += 1;
    result = {
      ok: true,
      operation: "search_node_templates",
      catalogRevision: "catalog-smoke-r4",
      matches:
        workflowRequest.query === "数组筛选"
          ? [{ id: "pipline.filter", version: "1.0.0", label: "筛选" }]
          : [],
    };
  } else if (workflowRequest.operation === "read") {
    workflowReadCalls += 1;
    if (workflowReadCalls === 3) {
      result = {
        ok: true,
        operation: "read",
        workflow: {
          id: "workflow-smoke",
          name: "Pipline proposal smoke",
          workspaceId: "workspace-smoke",
          revision: 9,
          nodes: [
            { instanceId: "start", meta: { id: "pipline.start", version: "1.0.0" } },
            { instanceId: "pi-node", meta: { id: "pipline.pi-agent", version: "2.0.0" } },
            { instanceId: "end", meta: { id: "pipline.end", version: "1.0.0" } },
          ],
          edges: [
            {
              id: "start-pi",
              sourceNodeId: "start",
              sourcePort: "input",
              targetNodeId: "pi-node",
              targetPort: "context",
            },
            {
              id: "pi-end",
              sourceNodeId: "pi-node",
              sourcePort: "content",
              targetNodeId: "end",
              targetPort: "result",
            },
          ],
          graph: {
            revision: 9,
            totalNodes: 3,
            totalEdges: 2,
            nextNodeOffset: null,
            nextEdgeOffset: null,
          },
          nodeCatalog: { revision: "catalog-smoke-r4", total: 9, nextOffset: null },
        },
      };
      subprocess.stdin.write(
        `${JSON.stringify({
          type: "extension_ui_response",
          id: event.id,
          value: JSON.stringify(result),
        })}\n`,
      );
      return;
    }
    if (workflowReadCalls === 2) {
      result = {
        ok: true,
        operation: "read",
        workflow: {
          id: "workflow-smoke",
          revision: 9,
          run: {
            id: "run-smoke",
            status: "success",
            workflowRevision: 9,
            progress: {
              total: 3,
              running: 0,
              waiting: 0,
              succeeded: 3,
              failed: 0,
              skipped: 0,
              interrupted: 0,
            },
            activeNodes: [],
            nodes: [
              { instanceId: "start", status: "success", output: { input: {} } },
              { instanceId: "assign", status: "success", output: { value: {} } },
              { instanceId: "end", status: "success", output: { result: {} } },
            ],
            result: { summary: {} },
            recentEvents: [
              { type: "run_started" },
              { type: "node_completed", instanceId: "start" },
              { type: "node_completed", instanceId: "assign" },
              { type: "node_completed", instanceId: "end" },
              { type: "run_completed" },
            ],
          },
        },
      };
      subprocess.stdin.write(
        `${JSON.stringify({
          type: "extension_ui_response",
          id: event.id,
          value: JSON.stringify(result),
        })}\n`,
      );
      return;
    }
    let pendingWritesWaited = false;
    const freshRecord = await loadWorkflowSnapshotForAgentRead({
      currentRecord: { workflow: { id: "workflow-smoke", revision: 8 } },
      workspaceId: "workspace-smoke",
      waitForPendingWrites: async () => {
        pendingWritesWaited = true;
      },
      workflowService: {
        async load(workflowId, workspaceId) {
          if (workflowId !== "workflow-smoke" || workspaceId !== "workspace-smoke")
            throw new Error("Agent read used the wrong workflow target.");
          return {
            workflow: { id: workflowId, workspaceId, revision: 9 },
            events: [
              {
                revision: 9,
                actor: "user",
                timestamp: "2026-09-27T10:00:00.000Z",
                command: {
                  type: "apply_batch",
                  operations: [
                    {
                      type: "set_param",
                      instanceId: "filter-node",
                      name: "predicate",
                      value: "smoke-private-value",
                    },
                    {
                      type: "connect",
                      edge: {
                        sourceNodeId: "map-node",
                        sourcePort: "items",
                        targetNodeId: "filter-node",
                        targetPort: "items",
                      },
                    },
                  ],
                },
              },
            ],
          };
        },
      },
    });
    if (!pendingWritesWaited || freshRecord.workflow.revision !== 9)
      throw new Error("Pi read did not refresh the Host-authoritative workflow record.");
    const recentChanges = summarizeWorkflowChanges(freshRecord.events);
    const serialized = JSON.stringify(recentChanges);
    if (serialized.includes("smoke-private-value"))
      throw new Error("Recent change summary leaked an edited parameter value.");
    result = {
      ok: true,
      operation: "read",
      workflow: { id: "workflow-smoke", revision: 9, recentChanges },
    };
  } else if (workflowRequest.operation === "propose_node_meta") {
    const meta = workflowRequest.meta;
    if (
      workflowRequest.expectedCatalogRevision !== "catalog-smoke-r4" ||
      meta?.id !== nodeMetaCandidate.id ||
      meta?.version !== nodeMetaCandidate.version ||
      meta?.implementationDraft?.source !== nodeMetaCandidate.implementationDraft.source ||
      !["en", "zh", "es", "ja"].every((locale) => typeof meta.i18n?.[locale]?.label === "string")
    )
      throw new Error(
        `Pi sent an incomplete NodeMeta candidate: ${JSON.stringify(workflowRequest)}`,
      );
    workflowNodeMetaProposalCalls += 1;
    result = {
      ok: true,
      operation: "propose_node_meta",
      meta: {
        id: meta.id,
        version: meta.version,
        implementation: { compiled: true, executable: false },
      },
      nodeCatalog: { revision: "catalog-smoke-r5" },
      approval: "approved",
    };
  } else if (workflowRequest.operation === "propose") {
    if (
      workflowRequest.baseRevision !== 9 ||
      workflowRequest.expectedCatalogRevision !== "catalog-smoke-r4" ||
      workflowRequest.operations?.length !== 1 ||
      workflowRequest.operations[0]?.type !== "set_param" ||
      workflowRequest.operations[0]?.instanceId !== "pi-node" ||
      workflowRequest.operations[0]?.value !== "整理输入并输出要点"
    )
      throw new Error(
        `Pi sent an invalid revision-bound graph proposal: ${JSON.stringify(workflowRequest)}`,
      );
    workflowProposalCalls += 1;
    result = {
      ok: true,
      operation: "propose",
      applied: true,
      revision: 10,
      approval: "approved",
    };
  } else {
    throw new Error(`Pi sent an unexpected workflow operation: ${workflowRequest.operation}`);
  }
  subprocess.stdin.write(
    `${JSON.stringify({
      type: "extension_ui_response",
      id: event.id,
      value: JSON.stringify(result),
    })}\n`,
  );
}

function assertSuccess(frame, command) {
  if (frame.type !== "response" || frame.command !== command || frame.success !== true)
    throw new Error(`Unexpected ${command} response: ${JSON.stringify(frame)}. ${stderr}`);
}

try {
  const commandList = await request({ type: "get_commands" });
  assertSuccess(commandList, "get_commands");
  if (!(commandList.data?.commands ?? []).some((item) => item.name === "pipline-workflow-mode"))
    throw new Error("The bundled Pi bridge did not register pipline-workflow-mode.");

  const enabled = await request({ type: "prompt", message: "/pipline-workflow-mode on" });
  assertSuccess(enabled, "prompt");
  async function runWorkflowTurn(message, expectedOperation) {
    const startedAt = observedEvents.length;
    const prompt = await request({ type: "prompt", message });
    assertSuccess(prompt, "prompt");
    const {
      event,
      index,
      request: workflowRequest,
    } = await waitForWorkflowRequest(startedAt, new Set());
    if (workflowRequest.operation !== expectedOperation)
      throw new Error(`Pi requested ${workflowRequest.operation}; expected ${expectedOperation}.`);
    await returnWorkflowResult(event, workflowRequest);
    await waitForEvent("turn_end", index + 1);
    return workflowRequest;
  }

  const searchRequest = await runWorkflowTurn(
    "请根据需求查找现成的数组筛选工作流节点。",
    "search_node_templates",
  );
  const readRequest = await runWorkflowTurn("请概括用户最近对画布做了什么修改。", "read");
  const runReadRequest = await runWorkflowTurn("请查看当前工作流运行状态和结果。", "read");
  const proposalStartedAt = observedEvents.length;
  const proposalPrompt = await request({
    type: "prompt",
    message: "请把当前工作流中的 Pi 节点任务改为整理输入，并先向我提议修改。",
  });
  assertSuccess(proposalPrompt, "prompt");
  const firstProposalStep = await waitForWorkflowRequest(proposalStartedAt, new Set());
  if (firstProposalStep.request.operation !== "read")
    throw new Error(
      `Pi must read before proposing; received ${firstProposalStep.request.operation}.`,
    );
  await returnWorkflowResult(firstProposalStep.event, firstProposalStep.request);
  const secondProposalStep = await waitForWorkflowRequest(firstProposalStep.index + 1, new Set());
  if (secondProposalStep.request.operation !== "propose")
    throw new Error(
      `Pi should propose after reading; received ${secondProposalStep.request.operation}.`,
    );
  await returnWorkflowResult(secondProposalStep.event, secondProposalStep.request);
  await waitForEvent("turn_end", secondProposalStep.index + 1);
  const candidateStartedAt = observedEvents.length;
  const candidatePrompt = await request({
    type: "prompt",
    message: "请为英文文本转 URL slug 查找或生成节点模板，只保存可复用模板，不要加到画布。",
  });
  assertSuccess(candidatePrompt, "prompt");
  const candidateSearchStep = await waitForWorkflowRequest(candidateStartedAt, new Set());
  if (candidateSearchStep.request.operation !== "search_node_templates")
    throw new Error("Pi must search the node catalog before proposing a new NodeMeta.");
  await returnWorkflowResult(candidateSearchStep.event, candidateSearchStep.request);
  const candidateProposalStep = await waitForWorkflowRequest(
    candidateSearchStep.index + 1,
    new Set(),
  );
  if (candidateProposalStep.request.operation !== "propose_node_meta")
    throw new Error("Pi should propose a NodeMeta after the catalog search found no match.");
  await returnWorkflowResult(candidateProposalStep.event, candidateProposalStep.request);
  await waitForEvent("turn_end", candidateProposalStep.index + 1);
  const messages = await request({ type: "get_messages" });
  assertSuccess(messages, "get_messages");
  const sessionMessages = messages.data?.messages ?? [];
  const savedWorkflowCall = sessionMessages.some(
    (message) =>
      message.role === "assistant" &&
      message.content?.some?.(
        (part) => part.type === "toolCall" && part.name === "pipline_workflow",
      ),
  );
  const savedWorkflowResult = sessionMessages.some(
    (message) =>
      message.role === "toolResult" &&
      message.toolName === "pipline_workflow" &&
      !message.isError &&
      JSON.stringify(message.content).includes("catalog-smoke-r4"),
  );
  const savedRecentChangesResult = sessionMessages.some(
    (message) =>
      message.role === "toolResult" &&
      message.toolName === "pipline_workflow" &&
      !message.isError &&
      JSON.stringify(message.content).includes("recentChanges") &&
      JSON.stringify(message.content).includes("actor") &&
      JSON.stringify(message.content).includes("set_param") &&
      !JSON.stringify(message.content).includes("smoke-private-value"),
  );
  const savedRunResult = sessionMessages.some(
    (message) =>
      message.role === "toolResult" &&
      message.toolName === "pipline_workflow" &&
      !message.isError &&
      JSON.stringify(message.content).includes("run-smoke") &&
      JSON.stringify(message.content).includes('succeeded\\":3') &&
      JSON.stringify(message.content).includes('summary\\":{}'),
  );
  const savedSearchReply = sessionMessages.some(
    (message) =>
      message.role === "assistant" &&
      message.content?.some?.(
        (part) => part.type === "text" && part.text.includes("pipline.filter@1.0.0"),
      ),
  );
  const savedRecentChangesReply = sessionMessages.some(
    (message) =>
      message.role === "assistant" &&
      message.content?.some?.(
        (part) => part.type === "text" && part.text.includes("predicate 参数"),
      ),
  );
  const savedRunReply = sessionMessages.some(
    (message) =>
      message.role === "assistant" &&
      message.content?.some?.(
        (part) => part.type === "text" && part.text.includes("3/3 个节点完成"),
      ),
  );
  const savedProposalResult = sessionMessages.some(
    (message) =>
      message.role === "toolResult" &&
      message.toolName === "pipline_workflow" &&
      !message.isError &&
      message.content?.some?.((part) => {
        if (part.type !== "text") return false;
        try {
          const response = JSON.parse(part.text);
          return response.applied === true && response.revision === 10;
        } catch {
          return false;
        }
      }),
  );
  const savedProposalReply = sessionMessages.some(
    (message) =>
      message.role === "assistant" &&
      message.content?.some?.(
        (part) => part.type === "text" && part.text.includes("通过桌面确认应用"),
      ),
  );
  const savedNodeMetaResult = sessionMessages.some(
    (message) =>
      message.role === "toolResult" &&
      message.toolName === "pipline_workflow" &&
      !message.isError &&
      JSON.stringify(message.content).includes("custom.slugify") &&
      JSON.stringify(message.content).includes("executable") &&
      JSON.stringify(message.content).includes("false"),
  );
  const savedNodeMetaReply = sessionMessages.some(
    (message) =>
      message.role === "assistant" &&
      message.content?.some?.(
        (part) => part.type === "text" && part.text.includes("可复用节点；其中的源码只是草稿"),
      ),
  );
  const originalState = await request({ type: "get_state" });
  assertSuccess(originalState, "get_state");
  const originalSessionFile = originalState.data?.sessionFile;
  if (typeof originalSessionFile !== "string")
    throw new Error("Pi did not report the workflow session file before switching sessions.");
  const newSession = await request({ type: "new_session" });
  assertSuccess(newSession, "new_session");
  if (newSession.data?.cancelled !== false)
    throw new Error(
      `Pi did not create a new session for the workflow isolation check: ${JSON.stringify(newSession)}`,
    );
  const ordinaryTurnStartedAt = observedEvents.length;
  const ordinaryPrompt = await request({
    type: "prompt",
    message: "普通会话检查：请用一句话打招呼。",
  });
  assertSuccess(ordinaryPrompt, "prompt");
  await waitForEvent("turn_end", ordinaryTurnStartedAt);
  const ordinarySessionHasWorkflowTool = providerRequestSummaries.at(-1)?.hasWorkflowTool === true;
  const switchBack = await request({ type: "switch_session", sessionPath: originalSessionFile });
  assertSuccess(switchBack, "switch_session");
  if (switchBack.data?.cancelled !== false)
    throw new Error("Pi cancelled the isolated workflow session switch-back check.");
  const switchedTurnStartedAt = observedEvents.length;
  const switchedPrompt = await request({
    type: "prompt",
    message: "切换回来的普通会话检查：请用一句话打招呼。",
  });
  assertSuccess(switchedPrompt, "prompt");
  await waitForEvent("turn_end", switchedTurnStartedAt);
  const switchedSessionHasWorkflowTool = providerRequestSummaries.at(-1)?.hasWorkflowTool === true;
  const reenabled = await request({ type: "prompt", message: "/pipline-workflow-mode on" });
  assertSuccess(reenabled, "prompt");
  const reenabledTurnStartedAt = observedEvents.length;
  const reenabledPrompt = await request({
    type: "prompt",
    message: "重新开启工作流模式后请用一句话打招呼。",
  });
  assertSuccess(reenabledPrompt, "prompt");
  await waitForEvent("turn_end", reenabledTurnStartedAt);
  const switchedSessionReenabledWorkflowTool =
    providerRequestSummaries.at(-1)?.hasWorkflowTool === true;
  if (ordinarySessionHasWorkflowTool)
    throw new Error(
      `Ordinary Pi session inherited workflow tools: ${JSON.stringify(providerRequestSummaries.slice(-3))}`,
    );
  if (
    !providerSawWorkflowTool ||
    !providerSawWorkflowResult ||
    !providerSawRecentChanges ||
    !providerSawRunSummary ||
    !providerSawProposalApproval ||
    !providerSawNodeMetaApproval ||
    workflowSearchCalls !== 2 ||
    workflowReadCalls !== 3 ||
    workflowProposalCalls !== 1 ||
    workflowNodeMetaProposalCalls !== 1 ||
    !savedWorkflowCall ||
    !savedWorkflowResult ||
    !savedRecentChangesResult ||
    !savedRunResult ||
    !savedSearchReply ||
    !savedRecentChangesReply ||
    !savedRunReply ||
    !savedProposalResult ||
    !savedProposalReply ||
    !savedNodeMetaResult ||
    !savedNodeMetaReply ||
    ordinarySessionHasWorkflowTool ||
    switchedSessionHasWorkflowTool ||
    !switchedSessionReenabledWorkflowTool
  ) {
    throw new Error(
      `Pi workflow RPC flow was incomplete: ${JSON.stringify({
        providerRequests,
        workflowSearchCalls,
        providerSawWorkflowTool,
        providerSawWorkflowResult,
        providerSawRecentChanges,
        providerSawRunSummary,
        providerSawProposalApproval,
        providerSawNodeMetaApproval,
        workflowReadCalls,
        workflowProposalCalls,
        workflowNodeMetaProposalCalls,
        providerRequestSummaries,
        savedWorkflowCall,
        savedWorkflowResult,
        savedRecentChangesResult,
        savedRunResult,
        savedSearchReply,
        savedRecentChangesReply,
        savedRunReply,
        savedProposalResult,
        savedProposalReply,
        savedNodeMetaResult,
        savedNodeMetaReply,
        ordinarySessionHasWorkflowTool,
        switchedSessionHasWorkflowTool,
        switchedSessionReenabledWorkflowTool,
        sessionMessages: sessionMessages.map((message) => ({
          role: message.role,
          toolName: message.toolName,
          content: message.content,
          isError: message.isError,
        })),
      })}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        piVersion,
        extension: "extensions/dist/picot-bridge.mjs",
        operations: [
          searchRequest.operation,
          readRequest.operation,
          runReadRequest.operation,
          firstProposalStep.request.operation,
          secondProposalStep.request.operation,
          candidateSearchStep.request.operation,
          candidateProposalStep.request.operation,
        ],
        desktopSearchResultReturnedToPi: providerSawWorkflowResult,
        recentChangesReturnedToPi: providerSawRecentChanges,
        runResultReturnedToPi: providerSawRunSummary,
        desktopApprovalRoundTripReturnedToPi: providerSawProposalApproval,
        nodeMetaCandidateRoundTripReturnedToPi: providerSawNodeMetaApproval,
        newSessionDidNotInheritWorkflowTools: !ordinarySessionHasWorkflowTool,
        switchedSessionDidNotInheritWorkflowTools: !switchedSessionHasWorkflowTool,
        explicitWorkflowEnableAfterSwitch: switchedSessionReenabledWorkflowTool,
        editedParameterValueOmitted: true,
        assistantResponses: [
          "Pi returned the selected existing node.",
          "Pi summarized the user's canvas edits.",
          "Pi summarized the most recent workflow run.",
          "Pi acknowledged the desktop-approved graph proposal.",
          "Pi described the saved non-executable NodeMeta candidate.",
        ],
        network: "loopback fake provider only",
      },
      null,
      2,
    ),
  );
} finally {
  mockProvider.stop(true);
  subprocess.kill();
  await Promise.allSettled([reader, stderrReader, subprocess.exited]);
  await rm(temp, { recursive: true, force: true });
}
