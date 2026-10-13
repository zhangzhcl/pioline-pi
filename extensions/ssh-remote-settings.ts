// ABOUTME: SSH remote settings types, registry resolution, ControlMaster multiplexing, and sshExec transport.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePiAgentRoot } from "./pi-agent-paths";

export type SshRemoteSettings = {
  enabled: boolean;
  host: string;
  port?: number;
  user?: string;
  remotePath?: string;
  identityFile?: string;
  hostRef?: string;
  configAlias?: string;
};

export type SshHostEntry = {
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
  configAlias?: string;
};

export type SshConfigHost = SshHostEntry & { alias: string };

export const DEFAULT_SSH_REMOTE_SETTINGS: SshRemoteSettings = { enabled: false, host: "" };

const SSH_CONNECT_TIMEOUT_SECONDS = 4;
const SSH_EXEC_TIMEOUT_SECONDS = 25;
const SSH_CONTROL_PERSIST_SECONDS = 600;
const SSH_CONTROL_PATH_MAX_BYTES = 96;
export const SSH_CONFIG_QUERY_TIMEOUT_MS = 3000;
export const SSH_PROBE_TIMEOUT_MS = 4000;
const PROJECT_CONFIG_DIR_NAME = ".pi";

let sessionPassword: string | undefined = process.env.PICOT_SSH_PASSWORD || undefined;

export function setSshRemoteSessionPassword(password: unknown): void {
  sessionPassword = typeof password === "string" && password ? password : undefined;
}

export function getSshRemoteSessionPassword(): string | undefined {
  return sessionPassword;
}

function globalSettingsPath(): string {
  return path.join(resolvePiAgentRoot(), "settings.json");
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readProjectSshRemoteSettings(cwd: string): SshRemoteSettings {
  const settingsPath = path.join(cwd, PROJECT_CONFIG_DIR_NAME, "settings.json");
  const settings = readJsonObject(settingsPath);
  if (!("sshRemote" in settings)) return DEFAULT_SSH_REMOTE_SETTINGS;
  return parseSshRemoteSettings(settings.sshRemote);
}

export function parseSshHostEntry(value: unknown): SshHostEntry {
  const settings = parseSshRemoteSettings(value);
  return {
    host: settings.host,
    ...(settings.port !== undefined ? { port: settings.port } : {}),
    ...(settings.user ? { user: settings.user } : {}),
    ...(settings.identityFile ? { identityFile: settings.identityFile } : {}),
    ...(settings.configAlias ? { configAlias: settings.configAlias } : {}),
  };
}

export function parseSshHosts(value: unknown): Record<string, SshHostEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const hosts: Record<string, SshHostEntry> = {};
  for (const [alias, raw] of Object.entries(value as Record<string, unknown>)) {
    const trimmedAlias = alias.trim();
    if (!trimmedAlias) continue;
    const entry = parseSshHostEntry(raw);
    if (entry.host) hosts[trimmedAlias] = entry;
  }
  return hosts;
}

export function readGlobalSshHosts(): Record<string, SshHostEntry> {
  return parseSshHosts(readJsonObject(globalSettingsPath()).sshHosts);
}

export function resolveSshRemoteSettings(
  binding: SshRemoteSettings,
  hosts: Record<string, SshHostEntry>,
): SshRemoteSettings {
  const entry = binding.hostRef ? hosts[binding.hostRef] : undefined;
  if (!entry) return binding;
  const host = binding.host || entry.host;
  const port = binding.port ?? entry.port;
  const user = binding.user || entry.user;
  const identityFile = binding.identityFile || entry.identityFile;
  const configAlias = binding.configAlias || entry.configAlias;
  return {
    enabled: binding.enabled,
    host,
    hostRef: binding.hostRef,
    ...(port !== undefined ? { port } : {}),
    ...(user ? { user } : {}),
    ...(binding.remotePath ? { remotePath: binding.remotePath } : {}),
    ...(identityFile ? { identityFile } : {}),
    ...(configAlias ? { configAlias } : {}),
  };
}

export function readResolvedProjectSshRemoteSettings(cwd: string): SshRemoteSettings {
  return resolveSshRemoteSettings(readProjectSshRemoteSettings(cwd), readGlobalSshHosts());
}

export function parseSshRemoteSettings(value: unknown): SshRemoteSettings {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const host = typeof raw.host === "string" ? raw.host.trim() : "";
  const user = typeof raw.user === "string" ? raw.user.trim() : "";
  const remotePath = typeof raw.remotePath === "string" ? raw.remotePath.trim() : "";
  const identityFile = typeof raw.identityFile === "string" ? raw.identityFile.trim() : "";
  const hostRef = typeof raw.hostRef === "string" ? raw.hostRef.trim() : "";
  const configAlias = typeof raw.configAlias === "string" ? raw.configAlias.trim() : "";
  const port =
    typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536
      ? raw.port
      : undefined;
  return {
    enabled: raw.enabled === true,
    host,
    ...(hostRef ? { hostRef } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(user ? { user } : {}),
    ...(remotePath ? { remotePath } : {}),
    ...(identityFile ? { identityFile } : {}),
    ...(configAlias ? { configAlias } : {}),
  };
}

export function serializeSshRemoteSettings(settings: SshRemoteSettings): Record<string, unknown> {
  if (settings.hostRef) {
    return {
      enabled: settings.enabled,
      hostRef: settings.hostRef,
      ...(settings.remotePath ? { remotePath: settings.remotePath } : {}),
    };
  }
  const { hostRef: _hostRef, ...inline } = settings;
  return { ...inline };
}

export function assertSshRemoteSettingsValid(settings: SshRemoteSettings): void {
  if (settings.enabled && !settings.host && !settings.hostRef) {
    throw new Error("Host is required when SSH remote execution is enabled");
  }
}

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sshTarget(settings: SshRemoteSettings): string {
  if (settings.configAlias) return settings.configAlias;
  return settings.user ? `${settings.user}@${settings.host}` : settings.host;
}

function sshControlDir(): string | null {
  if (process.platform === "win32") return null;
  try {
    const override = process.env.PICOT_SSH_CONTROL_DIR?.trim();
    const dir = override || path.join(resolvePiAgentRoot(), "ssh-control");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return dir;
  } catch {
    return null;
  }
}

export function sshControlPath(settings: SshRemoteSettings): string | null {
  const dir = sshControlDir();
  if (!dir) return null;
  const target = sshTarget(settings);
  if (!target) return null;
  const key = [target, settings.port ?? "", settings.identityFile ?? ""].join("\u0000");
  const socket = path.join(
    dir,
    `cm-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
  );
  return socket.length > SSH_CONTROL_PATH_MAX_BYTES ? null : socket;
}

export function closeSshControlMaster(settings: SshRemoteSettings): void {
  const controlPath = sshControlPath(settings);
  if (!controlPath || !fs.existsSync(controlPath)) return;
  try {
    const child = spawn(
      "ssh",
      ["-O", "exit", "-o", `ControlPath=${controlPath}`, sshTarget(settings)],
      {
        stdio: "ignore",
      },
    );
    child.on("error", () => {});
    child.unref?.();
  } catch {
    // Nothing to do — the master expires with ControlPersist regardless.
  }
}

export function sshArgs(
  settings: SshRemoteSettings,
  remoteCommand: string,
  password?: string,
): string[] {
  const args = [
    "-o",
    `BatchMode=${password ? "no" : "yes"}`,
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  const controlPath = sshControlPath(settings);
  if (controlPath) {
    args.push(
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${controlPath}`,
      "-o",
      `ControlPersist=${SSH_CONTROL_PERSIST_SECONDS}`,
    );
  }
  if (password) {
    args.push(
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PasswordAuthentication=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "NumberOfPasswordPrompts=1",
    );
  }
  if (!settings.configAlias) {
    if (settings.port) args.push("-p", String(settings.port));
    if (settings.identityFile) args.push("-i", settings.identityFile);
  }
  args.push(sshTarget(settings), remoteCommand);
  return args;
}

export function createAskpass(password: string): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picot-ssh-askpass-"));
  const askpass = path.join(dir, "askpass");
  fs.writeFileSync(askpass, "#!/bin/sh\nprintf '%s\\n' \"$PICOT_SSH_PASSWORD\"\n", {
    mode: 0o700,
  });
  return {
    env: {
      ...process.env,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: "picot",
      PICOT_SSH_PASSWORD: password,
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export const SSH_AUTH_REQUIRED_MARKER = "[picot:ssh-auth-required]";
export const SSH_PROJECT_DISCONNECTED_MARKER = "[picot:ssh-project-disconnected]";

function authHint(stderr: string, password?: string): string {
  if (!stderr) return "no output";
  if (!/Permission denied/i.test(stderr)) return stderr;
  return password
    ? `${stderr} — the password was rejected by the host.`
    : `${stderr} — no password was given and no usable key was found. Enter the host's password in the connect dialog, or set an identity file.`;
}

export function sshExec(
  settings: SshRemoteSettings,
  remoteCommand: string,
  options: { input?: Buffer; password?: string; timeoutMs?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const password = options.password ?? sessionPassword;
    const askpass = password ? createAskpass(password) : null;
    const child = spawn("ssh", sshArgs(settings, remoteCommand, password), {
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      ...(askpass ? { env: askpass.env } : {}),
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      child.kill();
      askpass?.cleanup();
      reject(new Error("SSH process did not provide output streams"));
      return;
    }
    const timeoutMs = options.timeoutMs ?? SSH_EXEC_TIMEOUT_SECONDS * 1000;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(deadline);
      askpass?.cleanup();
    };
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    stdout.on("data", (data) => chunks.push(data));
    stderr.on("data", (data) => errChunks.push(data));
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (timedOut) {
        reject(
          new Error(
            `SSH command timed out after ${Math.round(timeoutMs / 1000)}s. The host accepted the connection but never answered — it may be rate-limiting this machine after failed sign-ins.`,
          ),
        );
      } else if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        reject(new Error(`SSH command failed (exit ${code}): ${authHint(stderr, password)}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    if (options.input) {
      child.stdin?.end(options.input);
    }
  });
}
