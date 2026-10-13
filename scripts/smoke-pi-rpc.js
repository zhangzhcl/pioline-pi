import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BUILTIN_NODE_METAS,
  createStarterWorkflow,
  nodeMetaKey,
} from "../public/native/workflow/builtin-node-registry.js";
import { createPiAgentExecutor } from "../public/native/workflow/pi-agent-executor.js";
import { createWorkflowRun, WorkflowRunner } from "../public/native/workflow/workflow-runner.js";
import {
  startSmokeMockProvider,
  verifySmokeSessionAndTools,
  writeSmokeAgentFixtures,
} from "./smoke-pi-rpc-helpers.js";

const root = resolve(import.meta.dir, "..");
const { version: piVersion } = await Bun.file(join(root, "scripts", "pi-version.json")).json();
const binary = join(
  root,
  "src-tauri",
  "resources",
  "pi",
  process.platform === "win32" ? "pi.exe" : "pi",
);
const fixtureDir = join(root, "tests", "fixtures", "pi-rpc", piVersion);
const update = process.argv.includes("--update");
const temp = await mkdtemp(join(tmpdir(), "pipline-rpc-smoke-"));
const extension = join(temp, "smoke-extension.ts");
const agentDir = join(temp, "pi-agent");
const sessionDir = join(temp, "sessions");
const shellToolName = process.platform === "win32" ? "powershell" : null;
const windowsShellFallback = process.platform === "win32";
const bundledBridge = join(root, "extensions", "dist", "picot-bridge.mjs");

const { server: mockProvider, stats } = startSmokeMockProvider({ shellToolName });
await writeSmokeAgentFixtures({
  agentDir,
  extension,
  port: mockProvider.port,
  shellToolName,
});

const subprocess = Bun.spawn(
  [
    binary,
    "--mode",
    "rpc",
    "--provider",
    "pipline-smoke",
    "--model",
    "smoke-model",
    "--session-dir",
    sessionDir,
    "--extension",
    extension,
    ...(windowsShellFallback ? ["--extension", bundledBridge] : []),
  ],
  {
    cwd: temp,
    env: {
      ...process.env,
      APPDATA: join(temp, "AppData", "Roaming"),
      HOME: temp,
      PI_CODING_AGENT_DIR: agentDir,
      ...(windowsShellFallback ? { PIPLINE_WINDOWS_POWERSHELL_FALLBACK: "1" } : {}),
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
const runtimeListeners = new Set();
const piRuntimeTarget = {
  workspaceId: "pipline-rpc-smoke-workspace",
  sessionId: "pipline-rpc-smoke-session",
  instanceId: "pipline-rpc-smoke-instance",
};
let piAgentWorkflowResult = false;
let workflowRunnerCompleted = false;
let stdoutBuffer = "";
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
      } else {
        observedEvents.push(frame);
        for (const listener of runtimeListeners) {
          listener({ type: "runtime_event", target: piRuntimeTarget, event: frame });
        }
      }
    }
  }
})();

function request(command, timeoutMs = 5_000) {
  const id = `smoke-${nextId++}`;
  const frame = { id, ...command };
  subprocess.stdin.write(`${JSON.stringify(frame)}\n`);
  return new Promise((resolveRequest, rejectRequest) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`Timed out waiting for ${command.type}`));
    }, timeoutMs);
    pending.set(id, {
      resolve(value) {
        clearTimeout(timeout);
        resolveRequest(value);
      },
    });
  });
}

async function waitForEvent(type, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = observedEvents.find((item) => item.type === type);
    if (event) return event;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for Pi event ${type}.`);
}

function assertSuccess(frame, command) {
  if (frame.type !== "response" || frame.command !== command || frame.success !== true) {
    throw new Error(`Unexpected ${command} response: ${JSON.stringify(frame)}`);
  }
}

try {
  const state = await request({ type: "get_state" });
  const commands = await request({ type: "get_commands" });
  const steering = await request({ type: "set_steering_mode", mode: "all" });
  const followUp = await request({ type: "set_follow_up_mode", mode: "one-at-a-time" });
  const sessionName = await request({ type: "set_session_name", name: "Pipline RPC smoke" });
  const prompt = await request({ type: "prompt", message: "/pipline-smoke" });
  await waitForEvent("extension_ui_request");
  const normalPrompt = await request({
    type: "prompt",
    message: "Pipline session persistence check",
  });
  await waitForEvent("agent_end");
  const piAgentExecutor = createPiAgentExecutor({
    runtime: {
      request(command) {
        return request(command);
      },
      async snapshot(sessionId) {
        if (sessionId !== piRuntimeTarget.sessionId) {
          throw new Error(`Unexpected workflow Pi session: ${sessionId}`);
        }
        const frame = await request({ type: "get_messages" });
        assertSuccess(frame, "get_messages");
        return { state: { messages: frame.data?.messages ?? [] } };
      },
      subscribe(listener) {
        runtimeListeners.add(listener);
        return () => runtimeListeners.delete(listener);
      },
    },
    getTarget: () => piRuntimeTarget,
  });
  let nodeSequence = 0;
  const workflow = createStarterWorkflow({
    id: "pipline-smoke-workflow",
    workspaceId: piRuntimeTarget.workspaceId,
    makeId: () => `pipline-smoke-node-${++nodeSequence}`,
    timestamp: "2026-09-28T00:00:00.000Z",
    workflowName: "Pipline Pi Agent smoke",
    initialPiTask: "Complete the smoke workflow node.",
  });
  const piNode = workflow.nodes.find((node) => node.meta.id === "pipline.pi-agent");
  const piNodeKey = nodeMetaKey(piNode.meta);
  const workflowRunEvents = [];
  const workflowRun = await new WorkflowRunner({
    nodeMetas: BUILTIN_NODE_METAS,
    executors: new Map([[piNodeKey, piAgentExecutor]]),
  }).run(
    createWorkflowRun(
      workflow,
      {},
      {
        id: "pipline-smoke-run",
        createdAt: "2026-09-28T00:00:00.000Z",
        nodeMetas: BUILTIN_NODE_METAS,
      },
    ),
    { onEvent: (event) => workflowRunEvents.push(event) },
  );
  const piNodeOutput = workflowRun.nodeStates[piNode.instanceId]?.output;
  piAgentWorkflowResult = piNodeOutput?.content === "Pipline fake provider response.";
  workflowRunnerCompleted =
    workflowRun.status === "success" &&
    workflowRunEvents.some(
      (event) => event.type === "node_completed" && event.nodeId === piNode.instanceId,
    ) &&
    workflowRunEvents.some((event) => event.type === "run_completed");
  if (!piAgentWorkflowResult || !workflowRunnerCompleted) {
    throw new Error(
      `WorkflowRunner did not persist the Pi Agent node result: ${JSON.stringify({
        status: workflowRun.status,
        output: piNodeOutput,
        events: workflowRunEvents.map((event) => event.type),
      })}`,
    );
  }
  const messages = await request({ type: "get_messages" });
  const abort = await request({ type: "abort" });
  const persistedState = await request({ type: "get_state" });
  for (const [name, frame] of Object.entries({
    get_state: state,
    get_commands: commands,
    set_steering_mode: steering,
    set_follow_up_mode: followUp,
    set_session_name: sessionName,
    prompt,
    get_messages: messages,
    abort,
  })) {
    assertSuccess(frame, name);
  }
  assertSuccess(persistedState, "get_state");
  if (
    normalPrompt.command !== "prompt" ||
    normalPrompt.type !== "response" ||
    normalPrompt.success !== true
  ) {
    throw new Error(`Unexpected ordinary prompt response: ${JSON.stringify(normalPrompt)}`);
  }

  const { savedAssistantReply, savedWriteCall, savedWriteResult } =
    await verifySmokeSessionAndTools({
      messages,
      persistedState,
      sessionDir,
      temp,
      shellToolName,
      windowsShellFallback,
      stats,
    });

  const contract = {
    version: piVersion,
    commands: [
      "get_state",
      "get_commands",
      "set_steering_mode",
      "set_follow_up_mode",
      "set_session_name",
      "prompt",
      "get_messages",
      "abort",
    ],
    stateFields: Object.keys(state.data ?? {}).sort(),
    commandSources: [...new Set((commands.data?.commands ?? []).map((item) => item.source))].sort(),
    eventTypes: [
      ...new Set(
        observedEvents
          .map((event) => event.type)
          .filter((type) =>
            [
              "agent_end",
              "agent_settled",
              "agent_start",
              "entry_appended",
              "extension_ui_request",
              "message_end",
              "message_start",
              "message_update",
              "session_info_changed",
              "tool_execution_end",
              "tool_execution_start",
              "turn_end",
              "turn_start",
            ].includes(type),
          ),
      ),
    ].sort(),
    promptAcceptance: prompt.success,
    ordinaryPromptAcceptance: normalPrompt.success,
    agentTurn: savedAssistantReply,
    piAgentWorkflowNode: piAgentWorkflowResult,
    nativeWriteTool: savedWriteCall && savedWriteResult,
    persistedSession: true,
  };
  const fixture = join(fixtureDir, "contract.json");
  if (update) {
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(fixture, `${JSON.stringify(contract, null, 2)}\n`);
  } else {
    const expected = await Bun.file(fixture).json();
    if (JSON.stringify(contract) !== JSON.stringify(expected)) {
      throw new Error(
        `Pi RPC contract drifted. Run bun run smoke:pi-rpc --update after review.\n${JSON.stringify(contract, null, 2)}`,
      );
    }
  }
  console.log(`Pi ${contract.version} RPC smoke passed (${contract.commands.length} commands)`);
} finally {
  subprocess.stdin.end();
  await subprocess.exited;
  await reader;
  mockProvider.stop(true);
  await rm(temp, { recursive: true, force: true });
}
