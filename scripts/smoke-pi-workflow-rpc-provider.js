import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const nodeMetaCandidate = {
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

export function startWorkflowSmokeMockProvider() {
  const state = {
    providerRequests: 0,
    providerSawWorkflowTool: false,
    providerSawWorkflowResult: false,
    providerSawRecentChanges: false,
    providerSawRunSummary: false,
    providerSawProposalApproval: false,
    providerSawNodeMetaApproval: false,
    providerRequestSummaries: [],
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions")
        return new Response("Not found", { status: 404 });
      const body = await request.json();
      if (body.stream !== true)
        return Response.json({ error: "Streaming is required." }, { status: 400 });
      state.providerRequests += 1;
      const hasWorkflowTool =
        body.tools?.some((tool) => tool.function?.name === "pipline_workflow") ?? false;
      state.providerSawWorkflowTool ||= hasWorkflowTool;

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
      state.providerSawWorkflowResult ||= toolResultText.includes("pipline.filter");
      state.providerSawRecentChanges ||=
        toolResultText.includes('"recentChanges"') &&
        toolResultText.includes('"actor":"user"') &&
        toolResultText.includes('"type":"set_param"') &&
        !toolResultText.includes("smoke-private-value");
      state.providerSawRunSummary ||=
        toolResultText.includes('"status":"success"') &&
        toolResultText.includes('"succeeded":3') &&
        toolResultText.includes('"summary":{}');
      state.providerSawProposalApproval ||=
        hasProposalRequest &&
        toolResultText.includes('"operation":"propose"') &&
        toolResultText.includes('"applied":true');
      state.providerSawNodeMetaApproval ||=
        hasNodeCandidateRequest &&
        toolResultText.includes('"custom.slugify"') &&
        toolResultText.includes('"executable":false');
      state.providerRequestSummaries.push({
        hasWorkflowTool,
        hasSearchRequest,
        hasReadRequest,
        hasRunReadRequest,
        hasProposalRequest,
        hasNodeCandidateRequest,
        hasWorkflowResult: toolResultText.includes("pipline.filter"),
        hasRecentChanges: state.providerSawRecentChanges,
        hasRunSummary: state.providerSawRunSummary,
        lastUserMessage: messages[lastUserIndex]?.content,
        roles: messages.map((message) => message.role),
      });

      if (hasWorkflowTool && hasSearchRequest && !hasCurrentToolResult) {
        return streamResponse(
          toolCallChunk("call_pipline_workflow_search", "pipline_workflow", {
            operation: "search_node_templates",
            query: "数组筛选",
            searchLimit: 4,
          }),
        );
      }
      if (hasWorkflowTool && hasReadRequest && !hasCurrentToolResult) {
        return streamResponse(
          toolCallChunk("call_pipline_workflow_read", "pipline_workflow", {
            operation: "read",
          }),
        );
      }
      if (hasWorkflowTool && hasRunReadRequest && !hasCurrentToolResult) {
        return streamResponse(
          toolCallChunk("call_pipline_workflow_run_read", "pipline_workflow", {
            operation: "read",
          }),
        );
      }
      if (hasWorkflowTool && hasProposalRequest && !hasCurrentToolResult) {
        return streamResponse(
          toolCallChunk("call_pipline_workflow_proposal_read", "pipline_workflow", {
            operation: "read",
          }),
        );
      }
      if (
        hasWorkflowTool &&
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
      if (hasWorkflowTool && hasNodeCandidateRequest && !hasCurrentToolResult) {
        return streamResponse(
          toolCallChunk("call_pipline_workflow_search_node_candidate", "pipline_workflow", {
            operation: "search_node_templates",
            query: "英文文本 URL slug",
            searchLimit: 4,
          }),
        );
      }
      if (
        hasWorkflowTool &&
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
          id: `chatcmpl-pipline-workflow-aux-${state.providerRequests}`,
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
          id: `chatcmpl-pipline-workflow-aux-${state.providerRequests}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "workflow-smoke-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ]);
    },
  });

  return { server, state };
}

export async function writeWorkflowSmokeAgentFixtures({ agentDir, port }) {
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "pipline-workflow-smoke": {
          baseUrl: `http://127.0.0.1:${port}/v1`,
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
}
