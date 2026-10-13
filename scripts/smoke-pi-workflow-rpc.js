import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createWorkflowBridgeHandler,
  parseWorkflowRequest,
} from "./smoke-pi-workflow-rpc-bridge.js";
import {
  startWorkflowSmokeMockProvider,
  writeWorkflowSmokeAgentFixtures,
} from "./smoke-pi-workflow-rpc-provider.js";

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

const { server: mockProvider, state: providerState } = startWorkflowSmokeMockProvider();
await writeWorkflowSmokeAgentFixtures({ agentDir, port: mockProvider.port });

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

const { counts: bridgeCounts, returnWorkflowResult } = createWorkflowBridgeHandler({
  writeStdin: (line) => subprocess.stdin.write(line),
});

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
    `Timed out waiting for Pi event ${type}. Events: ${JSON.stringify(observedEvents.map((event) => event.type))}. UI requests: ${JSON.stringify(observedEvents.filter((event) => event.type === "extension_ui_request"))}. Provider: ${JSON.stringify(providerState.providerRequestSummaries)}. ${stderr}`,
  );
}

async function waitForWorkflowRequest(startIndex, handledIds) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (let index = startIndex; index < observedEvents.length; index += 1) {
      const event = observedEvents[index];
      if (handledIds.has(event.id)) continue;
      const workflowReq = parseWorkflowRequest(event);
      if (workflowReq) return { event, index, request: workflowReq };
    }
    if (subprocess.exitCode !== null)
      throw new Error(
        `Pi exited before workflow tool request (code ${subprocess.exitCode}). ${stderr}`,
      );
    await Bun.sleep(20);
  }
  throw new Error(
    `Timed out waiting for workflow tool request. UI requests: ${JSON.stringify(observedEvents.filter((event) => event.type === "extension_ui_request"))}. Provider: ${JSON.stringify(providerState.providerRequestSummaries)}. ${stderr}`,
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
  const ordinarySessionHasWorkflowTool =
    providerState.providerRequestSummaries.at(-1)?.hasWorkflowTool === true;
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
  const switchedSessionHasWorkflowTool =
    providerState.providerRequestSummaries.at(-1)?.hasWorkflowTool === true;
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
    providerState.providerRequestSummaries.at(-1)?.hasWorkflowTool === true;
  if (ordinarySessionHasWorkflowTool)
    throw new Error(
      `Ordinary Pi session inherited workflow tools: ${JSON.stringify(providerState.providerRequestSummaries.slice(-3))}`,
    );
  if (
    !providerState.providerSawWorkflowTool ||
    !providerState.providerSawWorkflowResult ||
    !providerState.providerSawRecentChanges ||
    !providerState.providerSawRunSummary ||
    !providerState.providerSawProposalApproval ||
    !providerState.providerSawNodeMetaApproval ||
    bridgeCounts.workflowSearchCalls !== 2 ||
    bridgeCounts.workflowReadCalls !== 3 ||
    bridgeCounts.workflowProposalCalls !== 1 ||
    bridgeCounts.workflowNodeMetaProposalCalls !== 1 ||
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
        ...providerState,
        ...bridgeCounts,
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
        desktopSearchResultReturnedToPi: providerState.providerSawWorkflowResult,
        recentChangesReturnedToPi: providerState.providerSawRecentChanges,
        runResultReturnedToPi: providerState.providerSawRunSummary,
        desktopApprovalRoundTripReturnedToPi: providerState.providerSawProposalApproval,
        nodeMetaCandidateRoundTripReturnedToPi: providerState.providerSawNodeMetaApproval,
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
