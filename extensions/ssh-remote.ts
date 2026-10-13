// ABOUTME: Delegates read/write/edit/bash tool execution to a remote host over SSH.
// ABOUTME: A project binds to a host (inline, or by alias into the global registry).

import { spawn } from "node:child_process";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ExtensionAPI,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  collectSshConfigAliases,
  listSshRemoteDirectories,
  parseSshConfigHosts,
  parseSshConfigQuery,
  readSshConfigHosts,
  testSshRemoteConnection,
} from "./ssh-remote-config";
import {
  assertSshRemoteSettingsValid,
  closeSshControlMaster,
  createAskpass,
  DEFAULT_SSH_REMOTE_SETTINGS,
  getSshRemoteSessionPassword,
  parseSshHostEntry,
  parseSshHosts,
  parseSshRemoteSettings,
  readGlobalSshHosts,
  readProjectSshRemoteSettings,
  readResolvedProjectSshRemoteSettings,
  resolveSshRemoteSettings,
  SSH_AUTH_REQUIRED_MARKER,
  SSH_PROBE_TIMEOUT_MS,
  SSH_PROJECT_DISCONNECTED_MARKER,
  type SshConfigHost,
  type SshHostEntry,
  type SshRemoteSettings,
  serializeSshRemoteSettings,
  setSshRemoteSessionPassword,
  shQuote,
  sshArgs,
  sshControlPath,
  sshExec,
  sshTarget,
} from "./ssh-remote-settings";

export {
  assertSshRemoteSettingsValid,
  closeSshControlMaster,
  collectSshConfigAliases,
  DEFAULT_SSH_REMOTE_SETTINGS,
  listSshRemoteDirectories,
  parseSshConfigHosts,
  parseSshConfigQuery,
  parseSshHostEntry,
  parseSshHosts,
  parseSshRemoteSettings,
  readGlobalSshHosts,
  readProjectSshRemoteSettings,
  readResolvedProjectSshRemoteSettings,
  readSshConfigHosts,
  resolveSshRemoteSettings,
  SSH_AUTH_REQUIRED_MARKER,
  SSH_PROJECT_DISCONNECTED_MARKER,
  type SshConfigHost,
  type SshHostEntry,
  type SshRemoteSettings,
  serializeSshRemoteSettings,
  setSshRemoteSessionPassword,
  shQuote,
  sshControlPath,
  sshExec,
  sshTarget,
  testSshRemoteConnection,
};

function remotePathFor(localCwd: string, remoteCwd: string, absolutePath: string): string {
  if (absolutePath === localCwd) return remoteCwd;
  if (absolutePath.startsWith(`${localCwd}/`)) {
    return `${remoteCwd}${absolutePath.slice(localCwd.length)}`;
  }
  return absolutePath;
}

export function createRemoteReadOps(
  settings: SshRemoteSettings,
  remoteCwd: string,
  localCwd: string,
): ReadOperations {
  const toRemote = (p: string) => remotePathFor(localCwd, remoteCwd, p);
  return {
    readFile: (p) => sshExec(settings, `cat -- ${shQuote(toRemote(p))}`),
    access: (p) => sshExec(settings, `test -r ${shQuote(toRemote(p))}`).then(() => {}),
    detectImageMimeType: async (p) => {
      try {
        const result = await sshExec(settings, `file --mime-type -b ${shQuote(toRemote(p))}`);
        const mime = result.toString("utf8").trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
      } catch {
        return null;
      }
    },
  };
}

export function createRemoteWriteOps(
  settings: SshRemoteSettings,
  remoteCwd: string,
  localCwd: string,
): WriteOperations {
  const toRemote = (p: string) => remotePathFor(localCwd, remoteCwd, p);
  return {
    writeFile: async (p, content) => {
      await sshExec(settings, `base64 -d > ${shQuote(toRemote(p))}`, {
        input: Buffer.from(Buffer.from(content, "utf8").toString("base64"), "ascii"),
      });
    },
    mkdir: (dir) => sshExec(settings, `mkdir -p -- ${shQuote(toRemote(dir))}`).then(() => {}),
  };
}

export function createRemoteEditOps(
  settings: SshRemoteSettings,
  remoteCwd: string,
  localCwd: string,
): EditOperations {
  const readOps = createRemoteReadOps(settings, remoteCwd, localCwd);
  const writeOps = createRemoteWriteOps(settings, remoteCwd, localCwd);
  return { readFile: readOps.readFile, access: readOps.access, writeFile: writeOps.writeFile };
}

export function createRemoteBashOps(
  settings: SshRemoteSettings,
  remoteCwd: string,
  localCwd: string,
): BashOperations {
  const toRemote = (p: string) => remotePathFor(localCwd, remoteCwd, p);
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve, reject) => {
        const remoteCommand = `cd ${shQuote(toRemote(cwd))} && ${command}`;
        const sessionPassword = getSshRemoteSessionPassword();
        const askpass = sessionPassword ? createAskpass(sessionPassword) : null;
        const child = spawn("ssh", sshArgs(settings, remoteCommand, sessionPassword), {
          stdio: ["ignore", "pipe", "pipe"],
          ...(askpass ? { env: askpass.env } : {}),
        });
        let timedOut = false;
        const timer = timeout
          ? setTimeout(() => {
              timedOut = true;
              child.kill();
            }, timeout * 1000)
          : undefined;
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", (error) => {
          if (timer) clearTimeout(timer);
          askpass?.cleanup();
          reject(error);
        });
        const onAbort = () => child.kill();
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          askpass?.cleanup();
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      }),
  };
}

export type ResolveSshRemoteSettings = (cwd: string, trusted: boolean) => SshRemoteSettings | null;

export function registerSshRemoteExtension(
  pi: ExtensionAPI,
  resolveSettings: ResolveSshRemoteSettings,
): void {
  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  type RemoteConnection = {
    settings: SshRemoteSettings;
    remoteCwd: string;
    readTool?: ReturnType<typeof createReadTool>;
    writeTool?: ReturnType<typeof createWriteTool>;
    editTool?: ReturnType<typeof createEditTool>;
    bashTool?: ReturnType<typeof createBashTool>;
    bashOps?: BashOperations;
  };
  let resolved: RemoteConnection | null = null;
  let binding: SshRemoteSettings | null = null;

  const statusLabel = (connection: { settings: SshRemoteSettings; remoteCwd: string }) =>
    `SSH: ${sshTarget(connection.settings)}:${connection.remoteCwd}`;

  const disconnectedText = () =>
    `SSH remote execution is not connected to ${sshTarget(binding as SshRemoteSettings)}. Reconnect to continue.`;

  async function connect(settings: SshRemoteSettings, { timeoutMs }: { timeoutMs?: number } = {}) {
    const probedCwd = (await sshExec(settings, "pwd", { timeoutMs })).toString("utf8").trim();
    const connection: RemoteConnection = { settings, remoteCwd: settings.remotePath || probedCwd };
    resolved = connection;
    return connection;
  }

  async function resolveRemote({
    verify = false,
    timeoutMs,
  }: {
    verify?: boolean;
    timeoutMs?: number;
  } = {}) {
    if (!binding) return null;
    if (resolved && !verify) return resolved;
    try {
      return await connect(binding, { timeoutMs });
    } catch {
      resolved = null;
      return null;
    }
  }

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate) {
      const remote = await resolveRemote();
      if (!remote && binding) throw new Error(disconnectedText());
      if (!remote) return localRead.execute(id, params, signal, onUpdate);
      remote.readTool ??= createReadTool(localCwd, {
        operations: createRemoteReadOps(remote.settings, remote.remoteCwd, localCwd),
      });
      return remote.readTool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate) {
      const remote = await resolveRemote();
      if (!remote && binding) throw new Error(disconnectedText());
      if (!remote) return localWrite.execute(id, params, signal, onUpdate);
      remote.writeTool ??= createWriteTool(localCwd, {
        operations: createRemoteWriteOps(remote.settings, remote.remoteCwd, localCwd),
      });
      return remote.writeTool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate) {
      const remote = await resolveRemote();
      if (!remote && binding) throw new Error(disconnectedText());
      if (!remote) return localEdit.execute(id, params, signal, onUpdate);
      remote.editTool ??= createEditTool(localCwd, {
        operations: createRemoteEditOps(remote.settings, remote.remoteCwd, localCwd),
      });
      return remote.editTool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate) {
      const remote = await resolveRemote();
      if (!remote && binding) throw new Error(disconnectedText());
      if (!remote) return localBash.execute(id, params, signal, onUpdate);
      remote.bashOps ??= createRemoteBashOps(remote.settings, remote.remoteCwd, localCwd);
      remote.bashTool ??= createBashTool(localCwd, {
        operations: remote.bashOps,
      });
      return remote.bashTool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    resolved = null;
    binding = null;
    ctx.ui.setStatus("ssh-remote", undefined);
    const settings = resolveSettings(ctx.cwd, ctx.isProjectTrusted());
    if (!settings) return;
    binding = settings;
    try {
      const connection = await connect(settings, { timeoutMs: SSH_PROBE_TIMEOUT_MS });
      ctx.ui.setStatus("ssh-remote", "Connected");
      ctx.ui.notify(`SSH remote execution active — ${statusLabel(connection)}`, "info");
    } catch (error) {
      ctx.ui.setStatus("ssh-remote", "Disconnected");
      ctx.ui.notify(
        `SSH: ${sshTarget(settings)} could not connect: ${error instanceof Error ? error.message : String(error)} ${SSH_PROJECT_DISCONNECTED_MARKER}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", () => {
    const remote = resolved;
    resolved = null;
    binding = null;
    if (remote) closeSshControlMaster(remote.settings);
  });

  pi.on("input", async (event, ctx) => {
    if (!binding) return;
    if (event.source === "extension") return;
    const remote = await resolveRemote({ verify: true, timeoutMs: SSH_PROBE_TIMEOUT_MS });
    if (remote) {
      ctx.ui.setStatus("ssh-remote", "Connected");
      return;
    }
    ctx.ui.setStatus("ssh-remote", "Disconnected");
    ctx.ui.setEditorText(event.text);
    ctx.ui.notify(
      `${disconnectedText()} ${SSH_PROJECT_DISCONNECTED_MARKER} ${SSH_AUTH_REQUIRED_MARKER}`,
      "error",
    );
    return { action: "handled" };
  });

  pi.on("user_bash", async () => {
    const remote = await resolveRemote();
    if (remote) {
      remote.bashOps ??= createRemoteBashOps(remote.settings, remote.remoteCwd, localCwd);
      return { operations: remote.bashOps };
    }
    if (binding) {
      return {
        result: {
          output: `${disconnectedText()}\n`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    return;
  });

  pi.on("before_agent_start", (event) => {
    if (!resolved) return;
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${resolved.remoteCwd} (via SSH: ${sshTarget(resolved.settings)})`,
    );
    return { systemPrompt: modified };
  });
}
