// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import {
  closeSshControlMaster,
  createRemoteBashOps,
  createRemoteReadOps,
  createRemoteWriteOps,
  listSshRemoteDirectories,
  setSshRemoteSessionPassword,
  sshControlPath,
  sshExec,
  testSshRemoteConnection,
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

function makeStalledChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => child.emit("close", null));
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

function controlArgs(settings: Parameters<typeof sshControlPath>[0]) {
  const controlPath = sshControlPath(settings);
  return controlPath
    ? ["-o", "ControlMaster=auto", "-o", `ControlPath=${controlPath}`, "-o", "ControlPersist=600"]
    : [];
}

describe("sshExec", () => {
  it("resolves stdout and passes BatchMode/ConnectTimeout/host-key flags", async () => {
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "hello\n" }) as never);
    const result = await sshExec({ enabled: true, host: "example.com", user: "alice" }, "pwd");
    expect(result.toString("utf8")).toBe("hello\n");
    const [bin, args] = vi.mocked(spawn).mock.calls[0];
    expect(bin).toBe("ssh");
    expect(args).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=4",
      "-o",
      "StrictHostKeyChecking=accept-new",
      ...controlArgs({ enabled: true, host: "example.com", user: "alice" }),
      "alice@example.com",
      "pwd",
    ]);
  });

  it("adds -p and -i when port/identityFile are set", async () => {
    vi.mocked(spawn).mockReturnValue(makeFakeChild() as never);
    await sshExec({ enabled: true, host: "example.com", port: 2222, identityFile: "/k/id" }, "pwd");
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toEqual(
      expect.arrayContaining(["-p", "2222", "-i", "/k/id", "example.com", "pwd"]),
    );
  });

  it("uses an ephemeral askpass helper when a password is supplied", async () => {
    vi.mocked(spawn).mockReturnValue(makeFakeChild() as never);
    await sshExec({ enabled: true, host: "example.com" }, "pwd", { password: "test-password" });
    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining([
        "BatchMode=no",
        "PasswordAuthentication=yes",
        "PreferredAuthentications=password,keyboard-interactive",
        "IdentitiesOnly=yes",
        "NumberOfPasswordPrompts=1",
      ]),
    );
    expect(options?.env).toMatchObject({ SSH_ASKPASS_REQUIRE: "force", DISPLAY: "picot" });
    expect(options?.env?.PICOT_SSH_PASSWORD).toBe("test-password");
  });

  it("starts from the password Picot injected at spawn, before anything sets one", async () => {
    vi.resetModules();
    vi.stubEnv("PICOT_SSH_PASSWORD", "from-picot");
    try {
      const fresh = await import("./ssh-remote");
      vi.mocked(spawn).mockReturnValue(makeFakeChild() as never);
      await fresh.sshExec({ enabled: true, host: "example.com" }, "pwd");
      const [, args, options] = vi.mocked(spawn).mock.calls[0];
      expect(args).toEqual(expect.arrayContaining(["BatchMode=no"]));
      expect(options?.env?.PICOT_SSH_PASSWORD).toBe("from-picot");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("gives remote bash the session password too, like every other remote call", async () => {
    setSshRemoteSessionPassword("test-password");
    vi.mocked(spawn).mockReturnValue(makeFakeChild() as never);
    const ops = createRemoteBashOps({ enabled: true, host: "example.com" }, "/srv/app", "/local");
    await ops.exec("ls", "/local", { onData: vi.fn() });
    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(["BatchMode=no", "PasswordAuthentication=yes"]));
    expect(options?.env?.PICOT_SSH_PASSWORD).toBe("test-password");
  });

  it("says which side the denial came from instead of echoing ssh's method list", async () => {
    const denied = "user@host: Permission denied (publickey,password,keyboard-interactive).";
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stderr: denied, code: 255 }) as never);
    await expect(sshExec({ enabled: true, host: "example.com" }, "pwd")).rejects.toThrow(
      /no password was given and no usable key was found/,
    );

    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stderr: denied, code: 255 }) as never);
    await expect(
      sshExec({ enabled: true, host: "example.com" }, "pwd", { password: "wrong" }),
    ).rejects.toThrow(/the password was rejected by the host/);
  });

  it("kills a stalled command instead of hanging its caller forever", async () => {
    vi.useFakeTimers();
    try {
      const child = makeStalledChild();
      vi.mocked(spawn).mockReturnValue(child as never);
      const pending = sshExec({ enabled: true, host: "example.com" }, "pwd");
      const assertion = expect(pending).rejects.toThrow(/timed out after \d+s/);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with stderr on non-zero exit", async () => {
    vi.mocked(spawn).mockReturnValue(
      makeFakeChild({ stderr: "Permission denied", code: 255 }) as never,
    );
    await expect(sshExec({ enabled: true, host: "h" }, "pwd")).rejects.toThrow(
      /exit 255.*Permission denied/s,
    );
  });

  it("kills and rejects a child process without the requested output pipes", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: null;
      stderr: null;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = null;
    child.stderr = null;
    child.kill = vi.fn();
    vi.mocked(spawn).mockReturnValue(child as never);

    await expect(sshExec({ enabled: true, host: "example.com" }, "pwd")).rejects.toThrow(
      "SSH process did not provide output streams",
    );
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("pipes input to stdin when provided", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    await sshExec({ enabled: true, host: "h" }, "cat > f", { input: Buffer.from("payload") });
    expect(child.stdin.end).toHaveBeenCalledWith(Buffer.from("payload"));
  });
});

describe("testSshRemoteConnection", () => {
  it("fails fast without spawning when host is empty", async () => {
    const result = await testSshRemoteConnection({ enabled: true, host: "" });
    expect(result).toEqual({ ok: false, message: "Host is required", latencyMs: 0 });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports ok with the resolved remote path", async () => {
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "/srv/app\n" }) as never);
    const result = await testSshRemoteConnection({
      enabled: true,
      host: "h",
      remotePath: "/srv/app",
    });
    expect(result.ok).toBe(true);
    expect(result.remotePath).toBe("/srv/app");
    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect((args as string[]).at(-1)).toBe("cd '/srv/app' && pwd");
  });

  it("reports the failure message when the connection fails", async () => {
    vi.mocked(spawn).mockReturnValue(
      makeFakeChild({ stderr: "Could not resolve hostname", code: 255 }) as never,
    );
    const result = await testSshRemoteConnection({ enabled: true, host: "nope.invalid" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not resolve hostname/);
  });
});

describe("remote operations factories", () => {
  const settings = { enabled: true, host: "h" };

  it("createRemoteReadOps translates local paths to remote paths", async () => {
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "content" }) as never);
    const ops = createRemoteReadOps(settings, "/remote/app", "/local/app");
    await ops.readFile("/local/app/src/index.ts");
    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect((args as string[]).at(-1)).toBe("cat -- '/remote/app/src/index.ts'");
  });

  it("createRemoteWriteOps base64-encodes content over stdin", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const ops = createRemoteWriteOps(settings, "/remote/app", "/local/app");
    await ops.writeFile("/local/app/out.txt", "hello world");
    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect((args as string[]).at(-1)).toBe("base64 -d > '/remote/app/out.txt'");
    expect(child.stdin.end).toHaveBeenCalledWith(
      Buffer.from(Buffer.from("hello world").toString("base64")),
    );
  });

  it("createRemoteBashOps prefixes the command with a cd into the mapped cwd", async () => {
    const onData = vi.fn();
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "ok" }) as never);
    const ops = createRemoteBashOps(settings, "/remote/app", "/local/app");
    const result = await ops.exec("ls -la", "/local/app/sub", { onData });
    expect(result).toEqual({ exitCode: 0 });
    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect((args as string[]).at(-1)).toBe("cd '/remote/app/sub' && ls -la");
    expect(onData).toHaveBeenCalledWith(Buffer.from("ok"));
  });

  it("createRemoteBashOps kills the child and rejects on abort", async () => {
    const child = makeFakeChild({ code: null });
    vi.mocked(spawn).mockReturnValue(child as never);
    const controller = new AbortController();
    const ops = createRemoteBashOps(settings, "/remote/app", "/local/app");
    const promise = ops.exec("sleep 100", "/local/app", {
      onData: vi.fn(),
      signal: controller.signal,
    });
    controller.abort();
    child.emit("close", null);
    await expect(promise).rejects.toThrow("aborted");
    expect(child.kill).toHaveBeenCalled();
  });
});

describe("connection multiplexing", () => {
  const supported = process.platform !== "win32";

  it.runIf(supported)("reuses one socket per connection and separates different ones", () => {
    const a = sshControlPath({ enabled: true, host: "example.com", user: "alice" });
    const b = sshControlPath({ enabled: true, host: "example.com", user: "alice" });
    const c = sshControlPath({ enabled: true, host: "example.com", user: "bob" });
    const d = sshControlPath({ enabled: true, host: "example.com", user: "alice", port: 2222 });
    expect(a).toBeTruthy();
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(d).not.toBe(a);
    expect(statSync(controlDir).mode & 0o077).toBe(0);
  });

  it.runIf(supported)("keeps the socket path inside the OS limit", () => {
    const controlPath = sshControlPath({ enabled: true, host: "example.com" }) as string;
    expect(controlPath.length).toBeLessThan(104);
  });

  it("never passes ControlMaster on Windows, whose OpenSSH rejects it", () => {
    if (supported) {
      expect(controlArgs({ enabled: true, host: "example.com" })).not.toEqual([]);
    } else {
      expect(controlArgs({ enabled: true, host: "example.com" })).toEqual([]);
    }
  });

  it.runIf(supported)("hangs up the shared connection on request", () => {
    const settings = { enabled: true, host: "example.com" };
    const controlPath = sshControlPath(settings) as string;
    writeFileSync(controlPath, "", "utf8");
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    closeSshControlMaster(settings);
    const [bin, args] = vi.mocked(spawn).mock.calls[0];
    expect(bin).toBe("ssh");
    expect(args).toEqual(["-O", "exit", "-o", `ControlPath=${controlPath}`, "example.com"]);
  });

  it("does nothing when there is no master to close", () => {
    closeSshControlMaster({ enabled: true, host: "example.com" });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("listSshRemoteDirectories", () => {
  it("lists only directories, relative to the resolved path", async () => {
    vi.mocked(spawn).mockReturnValue(
      makeFakeChild({ stdout: "/home/ubuntu\ncode/\nnotes.md\n.config/\n" }) as never,
    );
    await expect(
      listSshRemoteDirectories({ enabled: true, host: "example.com" }, "/home/ubuntu"),
    ).resolves.toEqual({ path: "/home/ubuntu", directories: [".config", "code"] });
    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect(args?.at(-1)).toBe("cd '/home/ubuntu' && pwd && ls -1pA");
  });

  it("falls back to the login home when no path is given", async () => {
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "/home/ubuntu\n" }) as never);
    await listSshRemoteDirectories({ enabled: true, host: "example.com" });
    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect(args?.at(-1)).toBe('cd "$HOME" && pwd && ls -1pA');
  });

  it("requires a host", async () => {
    await expect(listSshRemoteDirectories({ enabled: true, host: "" })).rejects.toThrow(
      "Host is required",
    );
  });
});
