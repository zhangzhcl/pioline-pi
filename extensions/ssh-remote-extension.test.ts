// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

vi.mock("@earendil-works/pi-coding-agent", () => {
  const makeLocalTool = (name: string) => ({
    name,
    label: name,
    description: name,
    parameters: {},
    execute: vi.fn(async () => ({ kind: name, remote: false })),
  });
  const makeFactory = (name: string) =>
    vi.fn((_cwd: string, options?: { operations?: unknown }) =>
      options?.operations
        ? {
            name,
            label: name,
            description: name,
            parameters: {},
            execute: vi.fn(async () => ({ kind: name, remote: true, ops: options.operations })),
          }
        : makeLocalTool(name),
    );
  return {
    createReadTool: makeFactory("read"),
    createWriteTool: makeFactory("write"),
    createEditTool: makeFactory("edit"),
    createBashTool: makeFactory("bash"),
  };
});

import { spawn } from "node:child_process";
import {
  registerSshRemoteExtension,
  SSH_AUTH_REQUIRED_MARKER,
  SSH_PROJECT_DISCONNECTED_MARKER,
  setSshRemoteSessionPassword,
  sshControlPath,
} from "./ssh-remote";

type FakeChildOptions = { stdout?: string; stderr?: string; code?: number | null };

function makeFakeChild({ stdout = "", stderr = "", code = 0 }: FakeChildOptions = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn(), write: vi.fn() };
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

let fakeHome = "";
let controlDir = "";

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  setSshRemoteSessionPassword(undefined);
  fakeHome = mkdtempSync(join(tmpdir(), "ssh-remote-home-"));
  vi.stubEnv("HOME", fakeHome);
  vi.stubEnv("USERPROFILE", fakeHome);
  controlDir = mkdtempSync("/tmp/pct-");
  vi.stubEnv("PICOT_SSH_CONTROL_DIR", controlDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(controlDir, { recursive: true, force: true });
});

describe("registerSshRemoteExtension", () => {
  function createHarness() {
    const registeredTools: Record<string, { execute: (...args: unknown[]) => Promise<unknown> }> =
      {};
    const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
    const pi = {
      registerTool: vi.fn((tool: { name: string; execute: (...args: unknown[]) => unknown }) => {
        registeredTools[tool.name] = tool as never;
      }),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      }),
    };
    const trigger = (event: string, ...args: unknown[]) =>
      Promise.all((handlers[event] ?? []).map((handler) => handler(...args)));
    return { pi, registeredTools, trigger };
  }

  function fakeUiCtx(overrides: Record<string, unknown> = {}) {
    return {
      cwd: "/workspace",
      isProjectTrusted: () => true,
      ui: {
        setStatus: vi.fn(),
        notify: vi.fn(),
        setEditorText: vi.fn(),
        theme: { fg: (_: string, text: string) => text },
      },
      ...overrides,
    };
  }

  it("falls back to the local tool when no settings resolve", async () => {
    const { pi, registeredTools } = createHarness();
    registerSshRemoteExtension(pi as never, () => null);

    const result = await registeredTools.read.execute("id", {}, undefined, undefined, {});
    expect(result).toEqual({ kind: "read", remote: false });
  });

  it("delegates to remote operations once session_start resolves settings", async () => {
    const { pi, registeredTools, trigger } = createHarness();
    registerSshRemoteExtension(pi as never, () => ({
      enabled: true,
      host: "example.com",
      remotePath: "/remote/app",
    }));

    const ctx = fakeUiCtx();
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "/remote/app\n" }) as never);
    await trigger("session_start", { type: "session_start", reason: "startup" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ssh-remote", "Connected");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("SSH: example.com:/remote/app"),
      "info",
    );
    const readResult = (await registeredTools.read.execute("id", {}, undefined, undefined, {})) as {
      remote: boolean;
    };
    expect(readResult.remote).toBe(true);
    const bashResult = (await registeredTools.bash.execute("id", {}, undefined, undefined, {})) as {
      remote: boolean;
    };
    expect(bashResult.remote).toBe(true);
  });

  it("rewrites the system prompt cwd line only while a remote is resolved", async () => {
    const { pi, trigger } = createHarness();
    registerSshRemoteExtension(pi as never, () => ({
      enabled: true,
      host: "example.com",
      remotePath: "/remote/app",
    }));
    const localCwd = process.cwd();
    const event = {
      type: "before_agent_start" as const,
      prompt: "hi",
      systemPrompt: `Some header\nCurrent working directory: ${localCwd}\nMore text`,
      systemPromptOptions: {} as never,
    };

    const [beforeUnresolved] = await trigger("before_agent_start", event);
    expect(beforeUnresolved).toBeUndefined();

    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "/remote/app\n" }) as never);
    await trigger("session_start", { type: "session_start", reason: "startup" }, fakeUiCtx());
    const [resolvedResult] = (await trigger("before_agent_start", event)) as [
      { systemPrompt: string } | undefined,
    ];
    expect(resolvedResult?.systemPrompt).toContain(
      `Current working directory: /remote/app (via SSH: example.com)`,
    );
  });

  it("routes ! user_bash commands to the remote only while resolved", async () => {
    const { pi, trigger } = createHarness();
    registerSshRemoteExtension(pi as never, () => ({
      enabled: true,
      host: "example.com",
      remotePath: "/remote/app",
    }));

    const [unresolved] = await trigger("user_bash", {
      type: "user_bash",
      command: "ls",
      excludeFromContext: false,
      cwd: "/workspace",
    });
    expect(unresolved).toBeUndefined();

    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "/remote/app\n" }) as never);
    await trigger("session_start", { type: "session_start", reason: "startup" }, fakeUiCtx());
    const [resolved] = (await trigger("user_bash", {
      type: "user_bash",
      command: "ls",
      excludeFromContext: false,
      cwd: "/workspace",
    })) as [{ operations: unknown } | undefined];
    expect(resolved?.operations).toBeDefined();
  });

  it("hangs up the shared connection when the session shuts down", async () => {
    if (process.platform === "win32") return;
    const { pi, registeredTools, trigger } = createHarness();
    registerSshRemoteExtension(pi as never, () => ({
      enabled: true,
      host: "example.com",
      remotePath: "/remote/app",
    }));
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "/remote/app\n" }) as never);
    await trigger("session_start", { type: "session_start", reason: "startup" }, fakeUiCtx());

    writeFileSync(sshControlPath({ enabled: true, host: "example.com" }) as string, "", "utf8");
    vi.mocked(spawn).mockClear();
    await trigger("session_shutdown", { type: "session_shutdown" });

    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["-O", "exit", "example.com"]),
    );
    const readResult = (await registeredTools.read.execute("id", {}, undefined, undefined, {})) as {
      remote: boolean;
    };
    expect(readResult.remote).toBe(false);
  });

  it("never applies settings for an untrusted project", async () => {
    const { pi, registeredTools, trigger } = createHarness();
    const resolveSettings = vi.fn(() => ({ enabled: true, host: "example.com" }));
    registerSshRemoteExtension(pi as never, (_cwd, trusted) =>
      trusted ? resolveSettings() : null,
    );

    await trigger(
      "session_start",
      { type: "session_start", reason: "startup" },
      fakeUiCtx({ isProjectTrusted: () => false }),
    );

    const result = await registeredTools.read.execute("id", {}, undefined, undefined, {});
    expect(result).toEqual({ kind: "read", remote: false });
  });

  it("refuses to run a remote tool in the local anchor when the host is unreachable", async () => {
    vi.mocked(spawn).mockImplementation(
      () => makeFakeChild({ stderr: "boom", code: 255 }) as never,
    );
    const { pi, registeredTools, trigger } = createHarness();
    registerSshRemoteExtension(pi as never, () => ({ enabled: true, host: "example.com" }));

    const ctx = fakeUiCtx();
    await trigger("session_start", { type: "session_start", reason: "startup" }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("could not connect"),
      "error",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(SSH_PROJECT_DISCONNECTED_MARKER),
      "error",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining(SSH_AUTH_REQUIRED_MARKER),
      "error",
    );
    await expect(registeredTools.read.execute("id", {}, undefined, undefined, {})).rejects.toThrow(
      /not connected/,
    );
  });

  it("blocks a continuation until the host is reachable, then lets it through", async () => {
    const { pi, trigger } = createHarness();
    registerSshRemoteExtension(pi as never, () => ({
      enabled: true,
      host: "example.com",
      remotePath: "/remote/app",
    }));

    vi.mocked(spawn).mockImplementation(
      () => makeFakeChild({ stderr: "boom", code: 255 }) as never,
    );
    const ctx = fakeUiCtx();
    await trigger("session_start", { type: "session_start", reason: "startup" }, ctx);

    const [blocked] = await trigger("input", { type: "input", text: "hi", source: "rpc" }, ctx);
    expect(blocked).toEqual({ action: "handled" });
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("hi");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("[picot:ssh-auth-required]"),
      "error",
    );

    vi.mocked(spawn).mockImplementation(() => makeFakeChild({ stdout: "/remote/app\n" }) as never);
    const [allowed] = await trigger("input", { type: "input", text: "hi", source: "rpc" }, ctx);
    expect(allowed).toBeUndefined();
  });

  it("fails a ! command instead of running it in the local anchor while offline", async () => {
    vi.mocked(spawn).mockImplementation(
      () => makeFakeChild({ stderr: "boom", code: 255 }) as never,
    );
    const { pi, trigger } = createHarness();
    registerSshRemoteExtension(pi as never, () => ({ enabled: true, host: "example.com" }));
    await trigger("session_start", { type: "session_start", reason: "startup" }, fakeUiCtx());

    const [result] = (await trigger("user_bash", {
      type: "user_bash",
      command: "ls",
      excludeFromContext: false,
      cwd: "/workspace",
    })) as [{ result?: { output: string; exitCode: number } } | undefined];
    expect(result?.result?.exitCode).toBe(1);
    expect(result?.result?.output).toContain("not connected");
  });
});
