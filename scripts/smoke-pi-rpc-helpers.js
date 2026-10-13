import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

const shellCommand =
  "$path = Join-Path (Get-Location) 'pipline-smoke-powershell.txt'; [System.IO.File]::WriteAllText($path, 'Pipline PowerShell tool completed.'); Write-Output 'PIPLINE_POWERSHELL_SMOKE'";

function toolCallChunks(requestCount, callId, name, args) {
  return [
    {
      id: `chatcmpl-pipline-${requestCount}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "smoke-model",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    {
      id: `chatcmpl-pipline-${requestCount}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "smoke-model",
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
      id: `chatcmpl-pipline-${requestCount}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "smoke-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

function streamResponse(chunks) {
  const stream = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

export function startSmokeMockProvider({ shellToolName }) {
  const stats = {
    chatRequestCount: 0,
    providerReceivedWriteTool: false,
    providerReceivedShellTool: false,
    providerReceivedBashTool: false,
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response("Not found", { status: 404 });
      }
      const body = await request.json();
      if (body.stream !== true) {
        return Response.json(
          { error: "The smoke provider requires streaming requests." },
          { status: 400 },
        );
      }
      stats.chatRequestCount += 1;
      stats.providerReceivedWriteTool ||=
        body.tools?.some((tool) => tool.function?.name === "write") ?? false;
      if (shellToolName) {
        stats.providerReceivedShellTool ||=
          body.tools?.some((tool) => tool.function?.name === shellToolName) ?? false;
        stats.providerReceivedBashTool ||=
          body.tools?.some((tool) => tool.function?.name === "bash") ?? false;
      }
      if (stats.chatRequestCount === 1) {
        return streamResponse(
          toolCallChunks(stats.chatRequestCount, "call_pipline_smoke_write", "write", {
            path: "pipline-smoke-write.txt",
            content: "Pipline native Pi write tool completed.\n",
          }),
        );
      }
      if (shellToolName && stats.chatRequestCount === 2) {
        return streamResponse(
          toolCallChunks(stats.chatRequestCount, "call_pipline_smoke_shell", shellToolName, {
            command: shellCommand,
            timeout: 10_000,
          }),
        );
      }
      return streamResponse([
        {
          id: `chatcmpl-pipline-${stats.chatRequestCount}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "smoke-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Pipline fake provider response." },
              finish_reason: null,
            },
          ],
        },
        {
          id: `chatcmpl-pipline-${stats.chatRequestCount}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "smoke-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ]);
    },
  });

  return { server, stats };
}

export async function writeSmokeAgentFixtures({ agentDir, extension, port, shellToolName }) {
  await mkdir(agentDir, { recursive: true });
  if (shellToolName) {
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultTools: ["read", "bash", "edit", "write"] }),
    );
  }
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "pipline-smoke": {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "pipline-smoke-key",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [
            {
              id: "smoke-model",
              name: "Pipline Smoke Model",
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

  await writeFile(
    extension,
    `export default function (pi) {
    pi.registerCommand("pipline-smoke", {
      description: "Pipline RPC contract smoke command",
      handler: async (_args, ctx) => {
        pi.appendEntry("pipline-smoke", { marker: "persisted" });
        ctx.ui.notify("Pipline smoke accepted", "info");
      },
    });
  }\n`,
  );
}

export async function verifySmokeSessionAndTools({
  messages,
  persistedState,
  sessionDir,
  temp,
  shellToolName,
  windowsShellFallback,
  stats,
}) {
  const messageList = messages.data?.messages ?? [];
  const savedUserPrompt = messageList.some(
    (message) =>
      message.role === "user" &&
      (typeof message.content === "string"
        ? message.content
        : message.content?.some?.((part) => part.text === "Pipline session persistence check")),
  );
  if (!savedUserPrompt) {
    throw new Error(
      `Pi did not retain the ordinary prompt in the session message history: ${JSON.stringify(messages.data)}`,
    );
  }
  const savedAssistantReply = messageList.some(
    (message) =>
      message.role === "assistant" &&
      message.content?.some?.(
        (part) => part.type === "text" && part.text === "Pipline fake provider response.",
      ),
  );
  const savedWriteCall = messageList.some(
    (message) =>
      message.role === "assistant" &&
      message.content?.some?.((part) => part.type === "toolCall" && part.name === "write"),
  );
  const savedWriteResult = messageList.some(
    (message) => message.role === "toolResult" && message.toolName === "write" && !message.isError,
  );
  const writtenFile = await Bun.file(join(temp, "pipline-smoke-write.txt")).text();
  const savedShellCall = shellToolName
    ? messageList.some(
        (message) =>
          message.role === "assistant" &&
          message.content?.some?.(
            (part) => part.type === "toolCall" && part.name === shellToolName,
          ),
      )
    : true;
  const savedShellResult = shellToolName
    ? messageList.some(
        (message) =>
          message.role === "toolResult" && message.toolName === shellToolName && !message.isError,
      )
    : true;
  if (
    !savedAssistantReply ||
    !savedWriteCall ||
    !savedWriteResult ||
    writtenFile !== "Pipline native Pi write tool completed.\n" ||
    !savedShellCall ||
    !savedShellResult ||
    stats.chatRequestCount !== (shellToolName ? 4 : 3) ||
    !stats.providerReceivedWriteTool ||
    (shellToolName && !stats.providerReceivedShellTool) ||
    (windowsShellFallback && stats.providerReceivedBashTool)
  ) {
    throw new Error(
      `Pi did not finish the native tool-call loop (PowerShell advertised: ${stats.providerReceivedShellTool}, Bash advertised: ${stats.providerReceivedBashTool}).`,
    );
  }
  if (shellToolName) {
    const shellOutput = await Bun.file(join(temp, "pipline-smoke-powershell.txt")).text();
    if (shellOutput !== "Pipline PowerShell tool completed.") {
      throw new Error("Pi PowerShell tool did not create the expected temporary output file.");
    }
  }

  const sessionFile = persistedState.data?.sessionFile;
  if (typeof sessionFile !== "string") {
    throw new Error("Pi did not expose the persisted session file.");
  }
  if (persistedState.data?.sessionName !== "Pipline RPC smoke") {
    throw new Error("Pi did not retain the session name in its active session state.");
  }
  const sessionRelativePath = relative(sessionDir, sessionFile);
  if (
    !sessionRelativePath ||
    sessionRelativePath.startsWith("..") ||
    isAbsolute(sessionRelativePath)
  ) {
    throw new Error(`Pi session escaped the isolated session directory: ${sessionFile}`);
  }
  const sessionContents = await Bun.file(sessionFile).text();
  if (!sessionContents.includes("Pipline RPC smoke")) {
    throw new Error("Pi session file does not contain the saved session name.");
  }
  if (!sessionContents.includes("Pipline session persistence check")) {
    throw new Error("Pi session file does not contain the ordinary prompt.");
  }
  if (!sessionContents.includes("Pipline fake provider response.")) {
    throw new Error("Pi session file does not contain the assistant response.");
  }
  if (!sessionContents.includes("pipline-smoke-write.txt")) {
    throw new Error("Pi session file does not contain the native write-tool call.");
  }
  if (shellToolName && !sessionContents.includes("pipline-smoke-powershell.txt")) {
    throw new Error("Pi session file does not contain the PowerShell tool call.");
  }

  return { savedAssistantReply, savedWriteCall, savedWriteResult };
}
