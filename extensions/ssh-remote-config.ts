// ABOUTME: OpenSSH client config parsing (`~/.ssh/config` + `ssh -G`), remote directory listing, and connection probing.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveHomeDir } from "./pi-agent-paths";
import {
  SSH_CONFIG_QUERY_TIMEOUT_MS,
  type SshConfigHost,
  type SshRemoteSettings,
  shQuote,
  sshExec,
} from "./ssh-remote-settings";

export function parseSshConfigHosts(text: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  let current: SshConfigHost | null = null;
  const flush = () => {
    if (current) {
      hosts.push({ ...current, host: current.host || current.alias, configAlias: current.alias });
    }
    current = null;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separated = line.replace(/^([A-Za-z]+)\s*=\s*/, "$1 ");
    const match = /^(\S+)\s+(.*)$/.exec(separated);
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    const value = match[2].trim();
    if (keyword === "host") {
      flush();
      const alias = value.split(/\s+/).find((pattern) => !/[*?!]/.test(pattern));
      if (alias) current = { alias, host: "" };
      continue;
    }
    if (!current) continue;
    if (keyword === "hostname") current.host = value;
    else if (keyword === "user") current.user = value;
    else if (keyword === "identityfile") current.identityFile = value;
    else if (keyword === "port") {
      const port = Number.parseInt(value, 10);
      if (Number.isInteger(port) && port > 0 && port < 65536) current.port = port;
    }
  }
  flush();
  return hosts;
}

export function collectSshConfigAliases(configPath: string, depth = 0): string[] {
  if (depth > 8) return [];
  let text: string;
  try {
    if (!fs.existsSync(configPath)) return [];
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  const baseDir = path.dirname(configPath);
  const aliases: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+)\s+(.*)$/.exec(line.replace(/^([A-Za-z]+)\s*=\s*/, "$1 "));
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    const value = match[2].trim();
    if (keyword === "host") {
      for (const pattern of value.split(/\s+/)) {
        if (!pattern || /[*?!]/.test(pattern) || pattern.startsWith("-")) continue;
        aliases.push(pattern);
      }
    } else if (keyword === "include") {
      for (const pattern of value.split(/\s+/)) {
        for (const included of expandSshInclude(pattern, baseDir)) {
          aliases.push(...collectSshConfigAliases(included, depth + 1));
        }
      }
    }
  }
  return [...new Set(aliases)];
}

function expandSshInclude(pattern: string, baseDir: string): string[] {
  const expanded = pattern.startsWith("~/")
    ? path.join(resolveHomeDir(), pattern.slice(2))
    : path.isAbsolute(pattern)
      ? pattern
      : path.join(baseDir, pattern);
  const dir = path.dirname(expanded);
  const base = path.basename(expanded);
  if (!/[*?]/.test(base)) return fs.existsSync(expanded) ? [expanded] : [];
  const matcher = new RegExp(
    `^${base
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && matcher.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function sshCapture(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", (data: Buffer) => chunks.push(data));
    child.stderr?.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : null);
    });
  });
}

const DEFAULT_IDENTITY_BASENAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ecdsa_sk",
  "id_ed25519",
  "id_ed25519_sk",
  "id_xmss",
]);

export function parseSshConfigQuery(alias: string, text: string): SshConfigHost {
  const values = new Map<string, string[]>();
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*)$/.exec(rawLine.trim());
    if (!match) continue;
    const list = values.get(match[1].toLowerCase());
    if (list) list.push(match[2].trim());
    else values.set(match[1].toLowerCase(), [match[2].trim()]);
  }
  const first = (key: string) => values.get(key)?.[0] || "";
  const port = Number.parseInt(first("port"), 10);
  const user = first("user");
  const identityFiles = values.get("identityfile") ?? [];
  const identityFile =
    identityFiles.length === 1 &&
    !DEFAULT_IDENTITY_BASENAMES.has(path.basename(identityFiles[0]).replace(/\.pub$/, ""))
      ? identityFiles[0]
      : "";
  let localUser = "";
  try {
    localUser = os.userInfo().username;
  } catch {
    // Unmapped uid
  }
  return {
    alias,
    host: first("hostname") || alias,
    ...(Number.isInteger(port) && port > 0 && port < 65536 && port !== 22 ? { port } : {}),
    ...(user && user !== localUser ? { user } : {}),
    ...(identityFile ? { identityFile } : {}),
    configAlias: alias,
  };
}

async function resolveSshConfigHost(
  alias: string,
  configPath: string,
): Promise<SshConfigHost | null> {
  const output = await sshCapture(["-F", configPath, "-G", alias], SSH_CONFIG_QUERY_TIMEOUT_MS);
  return output === null ? null : parseSshConfigQuery(alias, output);
}

async function resolveSshConfigHosts(
  aliases: string[],
  configPath: string,
): Promise<SshConfigHost[] | null> {
  const resolved: SshConfigHost[] = [];
  let sshAnswered = false;
  const CONCURRENCY = 8;
  for (let index = 0; index < aliases.length; index += CONCURRENCY) {
    const batch = await Promise.all(
      aliases
        .slice(index, index + CONCURRENCY)
        .map((alias) => resolveSshConfigHost(alias, configPath)),
    );
    for (const entry of batch) {
      if (!entry) continue;
      sshAnswered = true;
      resolved.push(entry);
    }
  }
  return sshAnswered ? resolved : null;
}

export async function readSshConfigHosts(): Promise<SshConfigHost[]> {
  const configPath = path.join(resolveHomeDir(), ".ssh", "config");
  try {
    if (!fs.existsSync(configPath)) return [];
    const aliases = collectSshConfigAliases(configPath);
    if (aliases.length === 0) return [];
    const resolved = await resolveSshConfigHosts(aliases, configPath);
    if (resolved) return resolved;
    return parseSshConfigHosts(fs.readFileSync(configPath, "utf8"));
  } catch {
    return [];
  }
}

export async function listSshRemoteDirectories(
  settings: SshRemoteSettings,
  dirPath?: string,
  password?: string,
): Promise<{ path: string; directories: string[] }> {
  if (!settings.host) throw new Error("Host is required");
  const target = dirPath?.trim();
  const cd = target ? `cd ${shQuote(target)}` : 'cd "$HOME"';
  const output = await sshExec(settings, `${cd} && pwd && ls -1pA`, { password });
  const lines = output.toString("utf8").split("\n");
  const resolvedPath = (lines.shift() || "").trim();
  const directories = lines
    .map((line) => line.trimEnd())
    .filter((line) => line.endsWith("/"))
    .map((line) => line.slice(0, -1))
    .filter((name) => name && name !== "." && name !== "..")
    .sort((a, b) => a.localeCompare(b));
  return { path: resolvedPath, directories };
}

export async function testSshRemoteConnection(
  settings: SshRemoteSettings,
  password?: string,
): Promise<{
  ok: boolean;
  message: string;
  remotePath?: string;
  latencyMs: number;
}> {
  const startedAt = Date.now();
  if (!settings.host) {
    return { ok: false, message: "Host is required", latencyMs: 0 };
  }
  try {
    const remotePath = settings.remotePath?.trim();
    const command = remotePath ? `cd ${shQuote(remotePath)} && pwd` : "pwd";
    const output = await sshExec(settings, command, { password });
    return {
      ok: true,
      message: "Connected",
      remotePath: output.toString("utf8").trim(),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    };
  }
}
