// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import {
  assertSshRemoteSettingsValid,
  collectSshConfigAliases,
  DEFAULT_SSH_REMOTE_SETTINGS,
  parseSshConfigHosts,
  parseSshConfigQuery,
  parseSshHosts,
  parseSshRemoteSettings,
  readProjectSshRemoteSettings,
  readResolvedProjectSshRemoteSettings,
  resolveSshRemoteSettings,
  serializeSshRemoteSettings,
  setSshRemoteSessionPassword,
  shQuote,
  sshExec,
  sshTarget,
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

describe("parseSshRemoteSettings", () => {
  it("normalizes valid input and drops empty optional fields", () => {
    expect(
      parseSshRemoteSettings({
        enabled: true,
        host: "  example.com  ",
        port: 2222,
        user: " root ",
        remotePath: " /srv/app ",
        identityFile: " ~/.ssh/id_ed25519 ",
      }),
    ).toEqual({
      enabled: true,
      host: "example.com",
      port: 2222,
      user: "root",
      remotePath: "/srv/app",
      identityFile: "~/.ssh/id_ed25519",
    });
  });

  it("never throws and falls back to defaults for garbage input", () => {
    expect(parseSshRemoteSettings(undefined)).toEqual(DEFAULT_SSH_REMOTE_SETTINGS);
    expect(parseSshRemoteSettings(null)).toEqual(DEFAULT_SSH_REMOTE_SETTINGS);
    expect(parseSshRemoteSettings("nonsense")).toEqual(DEFAULT_SSH_REMOTE_SETTINGS);
    expect(parseSshRemoteSettings([1, 2, 3])).toEqual(DEFAULT_SSH_REMOTE_SETTINGS);
  });

  it("rejects an out-of-range or non-integer port", () => {
    expect(parseSshRemoteSettings({ host: "h", port: 0 }).port).toBeUndefined();
    expect(parseSshRemoteSettings({ host: "h", port: 70000 }).port).toBeUndefined();
    expect(parseSshRemoteSettings({ host: "h", port: 22.5 }).port).toBeUndefined();
  });
});

describe("serializeSshRemoteSettings / assertSshRemoteSettingsValid", () => {
  it("round-trips through serialize", () => {
    const settings = parseSshRemoteSettings({ enabled: true, host: "h" });
    expect(serializeSshRemoteSettings(settings)).toEqual(settings);
  });

  it("throws when enabled without a host", () => {
    expect(() => assertSshRemoteSettingsValid({ enabled: true, host: "" })).toThrow(/Host/);
  });

  it("allows disabled settings without a host", () => {
    expect(() => assertSshRemoteSettingsValid({ enabled: false, host: "" })).not.toThrow();
  });

  it("stores only the binding when a host alias is used", () => {
    expect(
      serializeSshRemoteSettings({
        enabled: true,
        hostRef: "gpu-box",
        host: "10.0.0.5",
        identityFile: "~/.ssh/id_ed25519",
        remotePath: "/srv/app",
      }),
    ).toEqual({ enabled: true, hostRef: "gpu-box", remotePath: "/srv/app" });
  });
});

describe("shQuote / sshTarget", () => {
  it("single-quotes plain values", () => {
    expect(shQuote("/srv/app")).toBe("'/srv/app'");
  });

  it("escapes embedded single quotes so no shell expansion survives", () => {
    expect(shQuote("it's $(rm -rf /)")).toBe("'it'\\''s $(rm -rf /)'");
  });

  it("builds user@host only when a user is set", () => {
    expect(sshTarget({ enabled: true, host: "example.com" })).toBe("example.com");
    expect(sshTarget({ enabled: true, host: "example.com", user: "root" })).toBe(
      "root@example.com",
    );
  });
});

describe("readProjectSshRemoteSettings", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the sshRemote block from .pi/settings.json", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ssh-remote-project-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ sshRemote: { enabled: true, host: "example.com" } }),
      "utf8",
    );
    expect(readProjectSshRemoteSettings(cwd)).toEqual({ enabled: true, host: "example.com" });
  });

  it("returns defaults when settings.json is missing or malformed", () => {
    const missing = mkdtempSync(join(tmpdir(), "ssh-remote-missing-"));
    dirs.push(missing);
    expect(readProjectSshRemoteSettings(missing)).toEqual(DEFAULT_SSH_REMOTE_SETTINGS);

    const malformed = mkdtempSync(join(tmpdir(), "ssh-remote-malformed-"));
    dirs.push(malformed);
    mkdirSync(join(malformed, ".pi"), { recursive: true });
    writeFileSync(join(malformed, ".pi", "settings.json"), "{not json", "utf8");
    expect(readProjectSshRemoteSettings(malformed)).toEqual(DEFAULT_SSH_REMOTE_SETTINGS);
  });
});

describe("parseSshHosts", () => {
  it("normalizes a registry and drops entries without a host", () => {
    expect(
      parseSshHosts({
        "gpu-box": { host: " 10.0.0.5 ", user: " ubuntu ", port: 2222, enabled: true },
        broken: { user: "ubuntu" },
        "  ": { host: "10.0.0.6" },
      }),
    ).toEqual({ "gpu-box": { host: "10.0.0.5", port: 2222, user: "ubuntu" } });
  });

  it("reads a non-object as an empty registry", () => {
    expect(parseSshHosts(null)).toEqual({});
    expect(parseSshHosts([1, 2])).toEqual({});
  });
});

describe("resolveSshRemoteSettings", () => {
  const hosts = {
    "gpu-box": { host: "10.0.0.5", user: "ubuntu", port: 2222, identityFile: "~/.ssh/id_ed25519" },
  };

  it("fills the connection in from the referenced host", () => {
    expect(
      resolveSshRemoteSettings(
        { enabled: true, host: "", hostRef: "gpu-box", remotePath: "/srv/app" },
        hosts,
      ),
    ).toEqual({
      enabled: true,
      host: "10.0.0.5",
      hostRef: "gpu-box",
      port: 2222,
      user: "ubuntu",
      remotePath: "/srv/app",
      identityFile: "~/.ssh/id_ed25519",
    });
  });

  it("lets the project override a single field of a shared host", () => {
    const resolved = resolveSshRemoteSettings(
      { enabled: true, host: "", hostRef: "gpu-box", port: 2200 },
      hosts,
    );
    expect(resolved.port).toBe(2200);
    expect(resolved.host).toBe("10.0.0.5");
  });

  it("leaves an inline binding untouched", () => {
    const inline = { enabled: true, host: "example.com" };
    expect(resolveSshRemoteSettings(inline, hosts)).toEqual(inline);
  });

  it("does not invent a connection for an alias that is gone", () => {
    const binding = { enabled: true, host: "", hostRef: "deleted" };
    expect(resolveSshRemoteSettings(binding, hosts)).toEqual(binding);
  });
});

describe("connecting through a ~/.ssh/config alias", () => {
  const settings = {
    enabled: true,
    host: "10.0.0.5",
    user: "ubuntu",
    port: 2222,
    identityFile: "/k/id",
    configAlias: "gpu-box",
  };

  it("targets the alias so ssh applies the user's own Host block", () => {
    expect(sshTarget(settings)).toBe("gpu-box");
  });

  it("passes no -p/-i/user of its own, which would shadow that block", async () => {
    vi.mocked(spawn).mockReturnValue(makeFakeChild() as never);
    await sshExec(settings, "pwd");
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).not.toContain("-p");
    expect(args).not.toContain("-i");
    expect(args.at(-2)).toBe("gpu-box");
  });

  it("survives the settings round-trip so a bound project keeps using it", () => {
    const parsed = parseSshRemoteSettings(serializeSshRemoteSettings(settings));
    expect(parsed.configAlias).toBe("gpu-box");
  });

  it("comes along with a host resolved from the registry by alias", () => {
    const resolved = resolveSshRemoteSettings(
      { enabled: true, host: "", hostRef: "gpu" },
      { gpu: { host: "10.0.0.5", configAlias: "gpu-box" } },
    );
    expect(resolved.configAlias).toBe("gpu-box");
  });
});

describe("collectSshConfigAliases", () => {
  it("follows Include and skips wildcards, so ssh -G can be asked about each", () => {
    const sshDir = join(fakeHome, ".ssh");
    mkdirSync(join(sshDir, "config.d"), { recursive: true });
    writeFileSync(
      join(sshDir, "config"),
      ["Include config.d/*.conf", "Host gpu-box build-box", "  HostName 10.0.0.5", "Host *"].join(
        "\n",
      ),
      "utf8",
    );
    writeFileSync(join(sshDir, "config.d", "work.conf"), "Host work-jump\n", "utf8");
    writeFileSync(join(sshDir, "config.d", "notes.txt"), "Host ignored\n", "utf8");
    expect(collectSshConfigAliases(join(sshDir, "config")).sort()).toEqual([
      "build-box",
      "gpu-box",
      "work-jump",
    ]);
  });

  it("returns nothing for a config that is not there", () => {
    expect(collectSshConfigAliases(join(fakeHome, ".ssh", "nope"))).toEqual([]);
  });
});

describe("parseSshConfigQuery", () => {
  const dump = (lines: string[]) => lines.join("\n");

  it("takes the resolved values ssh reports", () => {
    expect(
      parseSshConfigQuery(
        "gpu-box",
        dump([
          "host gpu-box",
          "hostname 10.0.0.5",
          "user ubuntu",
          "port 2222",
          "identityfile /keys/gpu",
          "proxyjump bastion",
        ]),
      ),
    ).toEqual({
      alias: "gpu-box",
      configAlias: "gpu-box",
      host: "10.0.0.5",
      user: "ubuntu",
      port: 2222,
      identityFile: "/keys/gpu",
    });
  });

  it("drops ssh's own defaults instead of echoing them back as configuration", () => {
    const entry = parseSshConfigQuery(
      "plain",
      dump([
        "hostname plain",
        `user ${os.userInfo().username}`,
        "port 22",
        "identityfile ~/.ssh/id_rsa",
        "identityfile ~/.ssh/id_ed25519",
      ]),
    );
    expect(entry).toEqual({ alias: "plain", configAlias: "plain", host: "plain" });
  });
});

describe("parseSshConfigHosts", () => {
  it("reads host blocks, honouring keyword case and = separators", () => {
    expect(
      parseSshConfigHosts(
        [
          "# a comment",
          "Host gpu-box",
          "  HostName 10.0.0.5",
          "  user ubuntu",
          "  Port 2222",
          "  IdentityFile ~/.ssh/id_ed25519",
          "",
          "host plain",
          "",
          "Host wild-*",
          "  HostName ignored.example.com",
          "Host eq",
          "  HostName=10.0.0.9",
        ].join("\n"),
      ),
    ).toEqual([
      {
        alias: "gpu-box",
        configAlias: "gpu-box",
        host: "10.0.0.5",
        user: "ubuntu",
        port: 2222,
        identityFile: "~/.ssh/id_ed25519",
      },
      { alias: "plain", configAlias: "plain", host: "plain" },
      { alias: "eq", configAlias: "eq", host: "10.0.0.9" },
    ]);
  });

  it("returns nothing for an empty config", () => {
    expect(parseSshConfigHosts("")).toEqual([]);
  });
});

describe("readResolvedProjectSshRemoteSettings", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("joins the project binding to the global registry", () => {
    const home = mkdtempSync(join(tmpdir(), "ssh-remote-home-"));
    dirs.push(home);
    vi.stubEnv("HOME", home);
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ sshHosts: { "gpu-box": { host: "10.0.0.5", user: "ubuntu" } } }),
      "utf8",
    );
    const cwd = join(home, "anchor");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ sshRemote: { enabled: true, hostRef: "gpu-box", remotePath: "/srv/app" } }),
      "utf8",
    );

    expect(readResolvedProjectSshRemoteSettings(cwd)).toEqual({
      enabled: true,
      host: "10.0.0.5",
      hostRef: "gpu-box",
      user: "ubuntu",
      remotePath: "/srv/app",
    });
  });
});
