// Configuration data plane for the native Picot Settings → Configuration tab.
//
// In the native architecture the WebView talks to the Rust host, which forwards
// commands to pi over stdio RPC. This module is invoked through a registered pi
// command (`/picot-config`) whose handler runs immediately without hitting the
// LLM or session history. Results are returned to the WebView via
// `ctx.ui.notify(JSON)`, correlated by request id.

import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildPackageSkillInventory } from "./package-skill-inventory";
import { writePasteOffloadFile } from "./paste-offload";
import {
  buildTelegramDmConfig,
  buildTelegramDoctorReport,
  getLatestTelegramUpdateId,
  getTelegramBotIdentity,
  observeTelegramPrivateDm,
  type TelegramBotIdentity,
} from "./pi-chat-setup";
import { handleModelConfigOp } from "./picot-config-model-ops";
import {
  type CatalogRegistry,
  errMessage,
  logModelLoadEvent,
  ModelPreferencesStore,
} from "./picot-config-models";
import { handleOAuthConfigOp } from "./picot-config-oauth";
import {
  AGENT_CONFIG_PATH,
  AGENTS_MD_PATH,
  APPEND_SYSTEM_MD_PATH,
  asNumber,
  asString,
  CHAT_CONFIG_PATH,
  type ConfigContext,
  getChatWorkerStatuses,
  getDefaultAutoCompaction,
  getDefaultThinkingLevel,
  listSuperAgentProjects,
  openExternal,
  PROJECT_CONFIG_DIR_NAME,
  parseSkillScope,
  parseSkillTarget,
  readConfigFile,
  readGlobalSshHostRegistry,
  readSettingsObject,
  readTextFile,
  renameHistoricalSession,
  resolveSettingsPath,
  type SkillInventoryMutation,
  SUPER_AGENT_TASKS_PATH,
  setDefaultAutoCompaction,
  setDefaultThinkingLevel,
  skillInventoryOptions,
  telegramBotPayload,
  writeConfigFile,
  writeSettingsObject,
  writeTextFile,
} from "./picot-config-settings";
import { generateTitleForSession } from "./session-title";
import { buildSkillInventory, mutateSkillEnabled } from "./skill-inventory";
import {
  assertSshRemoteSettingsValid,
  listSshRemoteDirectories,
  parseSshHostEntry,
  parseSshHosts,
  parseSshRemoteSettings,
  readSshConfigHosts,
  resolveSshRemoteSettings,
  serializeSshRemoteSettings,
  setSshRemoteSessionPassword,
  testSshRemoteConnection,
} from "./ssh-remote";

export type { ConfigContext };
export type PicotConfigResult = { ok: true; data?: unknown } | { ok: false; error: string };

// Dispatch a single Configuration operation. `ctx` is the extension command
// context; `ctx.modelRegistry` provides live provider/model/auth access.
export async function handlePicotConfig(
  op: string,
  params: Record<string, unknown>,
  ctx: ConfigContext,
): Promise<PicotConfigResult> {
  const registry = ctx.modelRegistry;
  const preferences = new ModelPreferencesStore();

  const requireRegistry = (): CatalogRegistry => {
    if (!registry) {
      logModelLoadEvent("registry_not_ready", { source: "backend", op });
      throw new Error("Model registry not ready yet — try again in a moment.");
    }
    return registry;
  };

  try {
    const oauthResult = await handleOAuthConfigOp(op, params, ctx, registry);
    if (oauthResult) return oauthResult;

    const modelResult = await handleModelConfigOp(
      op,
      params,
      registry,
      requireRegistry,
      preferences,
    );
    if (modelResult) return modelResult;

    switch (op) {
      case "write_paste_offload": {
        const content = params.content;
        if (typeof content !== "string") throw new Error("content is required");
        if (!ctx.cwd) throw new Error("Active workspace is required");
        const result = writePasteOffloadFile(ctx.cwd, content);
        return { ok: true, data: { path: result.relativePath } };
      }

      case "navigate_tree": {
        const targetId = asString(params.targetId);
        if (!targetId) throw new Error("targetId is required");
        if (typeof ctx.navigateTree !== "function") {
          throw new Error("Session tree navigation is unavailable.");
        }
        const result = await ctx.navigateTree(targetId, {
          summarize: params.summarize === true,
          ...(typeof params.customInstructions === "string"
            ? { customInstructions: params.customInstructions }
            : {}),
          ...(typeof params.replaceInstructions === "boolean"
            ? { replaceInstructions: params.replaceInstructions }
            : {}),
          ...(typeof params.label === "string" ? { label: params.label } : {}),
        });
        return { ok: true, data: result ?? { cancelled: false } };
      }

      case "rename_historical_session": {
        const result = await renameHistoricalSession(params.filePath, params.name);
        return { ok: true, data: result };
      }

      case "generate_session_title": {
        const sessionFile = ctx.sessionManager?.getSessionFile();
        if (!sessionFile) throw new Error("The active session has not been saved yet.");
        const modelRuntime = await ModelRuntime.create();
        const title = await generateTitleForSession(sessionFile, {
          model: ctx.model,
          modelRuntime,
        });
        return { ok: true, data: { title } };
      }

      case "list_package_skill_inventory": {
        const scope = parseSkillScope(params.scope);
        return {
          ok: true,
          data: buildPackageSkillInventory(skillInventoryOptions(scope, ctx)),
        };
      }

      case "list_skill_inventory": {
        const scope = parseSkillScope(params.scope);
        return { ok: true, data: buildSkillInventory(skillInventoryOptions(scope, ctx)) };
      }

      case "set_skill_enabled": {
        const mutation = params as SkillInventoryMutation;
        const scope = parseSkillScope(mutation.scope);
        const target = parseSkillTarget(mutation.target);
        if (typeof mutation.enabled !== "boolean") {
          throw new Error("Invalid skill inventory mutation");
        }
        const result = await mutateSkillEnabled({
          ...skillInventoryOptions(scope, ctx),
          target,
          enabled: mutation.enabled,
        });
        return { ok: true, data: result };
      }

      case "read_agent_config":
        return { ok: true, data: readConfigFile(AGENT_CONFIG_PATH, "{}") };

      case "write_agent_config": {
        writeConfigFile(AGENT_CONFIG_PATH, params.content);
        return { ok: true, data: { path: AGENT_CONFIG_PATH } };
      }

      case "read_agents_md":
        return { ok: true, data: readTextFile(AGENTS_MD_PATH) };

      case "write_agents_md": {
        writeTextFile(AGENTS_MD_PATH, params.content);
        return { ok: true, data: { path: AGENTS_MD_PATH } };
      }

      case "read_append_system_md":
        return { ok: true, data: readTextFile(APPEND_SYSTEM_MD_PATH) };

      case "write_append_system_md": {
        writeTextFile(APPEND_SYSTEM_MD_PATH, params.content);
        return { ok: true, data: { path: APPEND_SYSTEM_MD_PATH } };
      }

      case "get_default_thinking_level":
        return { ok: true, data: getDefaultThinkingLevel(params.scope, ctx) };

      case "set_default_thinking_level":
        return { ok: true, data: setDefaultThinkingLevel(params.level, params.scope, ctx) };

      case "get_default_auto_compaction":
        return { ok: true, data: getDefaultAutoCompaction(params.scope, ctx) };

      case "set_default_auto_compaction":
        return { ok: true, data: setDefaultAutoCompaction(params.enabled, params.scope, ctx) };

      case "get_ssh_remote_config": {
        const cwd = asString(ctx.cwd);
        if (!cwd) throw new Error("Active workspace is required");
        const settingsPath = path.join(cwd, PROJECT_CONFIG_DIR_NAME, "settings.json");
        const settings = readSettingsObject(settingsPath);
        const config = parseSshRemoteSettings(settings.sshRemote);
        const hosts = readGlobalSshHostRegistry();
        return {
          ok: true,
          data: {
            config,
            resolved: resolveSshRemoteSettings(config, hosts),
            hosts,
            trusted: Boolean(ctx.isProjectTrusted?.()),
            path: settingsPath,
          },
        };
      }

      case "set_ssh_remote_config": {
        const config = parseSshRemoteSettings(params.config ?? params);
        assertSshRemoteSettingsValid(config);
        const target = resolveSettingsPath("project", ctx);
        const settings = readSettingsObject(target.path);
        settings.sshRemote = serializeSshRemoteSettings(config);
        writeSettingsObject(target.path, settings);
        return { ok: true, data: { config, path: target.path } };
      }

      case "test_ssh_remote_config": {
        const config = resolveSshRemoteSettings(
          parseSshRemoteSettings(params.config ?? params),
          readGlobalSshHostRegistry(),
        );
        return {
          ok: true,
          data: await testSshRemoteConnection(config, asString(params.password) || undefined),
        };
      }

      case "set_ssh_remote_password":
        setSshRemoteSessionPassword(params.password);
        return { ok: true, data: {} };

      case "list_ssh_remote_dir": {
        const config = resolveSshRemoteSettings(
          parseSshRemoteSettings(params.config ?? params),
          readGlobalSshHostRegistry(),
        );
        const dirPath = asString(params.path);
        return {
          ok: true,
          data: await listSshRemoteDirectories(
            config,
            dirPath,
            asString(params.password) || undefined,
          ),
        };
      }

      case "get_ssh_hosts":
        return {
          ok: true,
          data: {
            hosts: readGlobalSshHostRegistry(),
            sshConfigHosts: await readSshConfigHosts(),
            path: AGENT_CONFIG_PATH,
          },
        };

      case "set_ssh_host": {
        const alias = asString(params.alias).trim();
        if (!alias) throw new Error("A host name is required");
        const entry = parseSshHostEntry(params.config ?? params);
        if (!entry.host) throw new Error("Host is required");
        const settings = readSettingsObject(AGENT_CONFIG_PATH);
        const hosts = parseSshHosts(settings.sshHosts);
        hosts[alias] = entry;
        settings.sshHosts = hosts;
        writeSettingsObject(AGENT_CONFIG_PATH, settings);
        return { ok: true, data: { alias, hosts, path: AGENT_CONFIG_PATH } };
      }

      case "delete_ssh_host": {
        const alias = asString(params.alias).trim();
        if (!alias) throw new Error("A host name is required");
        const settings = readSettingsObject(AGENT_CONFIG_PATH);
        const hosts = parseSshHosts(settings.sshHosts);
        delete hosts[alias];
        settings.sshHosts = hosts;
        writeSettingsObject(AGENT_CONFIG_PATH, settings);
        return { ok: true, data: { hosts, path: AGENT_CONFIG_PATH } };
      }

      case "read_chat_config":
        return { ok: true, data: readConfigFile(CHAT_CONFIG_PATH, "{}") };

      case "write_chat_config": {
        writeConfigFile(CHAT_CONFIG_PATH, params.content);
        return { ok: true, data: { path: CHAT_CONFIG_PATH } };
      }

      case "telegram_validate": {
        const botToken = asString(params.botToken);
        if (!botToken) throw new Error("botToken required");
        const identity = await getTelegramBotIdentity(botToken);
        const afterUpdateId = await getLatestTelegramUpdateId(botToken);
        return {
          ok: true,
          data: {
            bot: telegramBotPayload(identity),
            afterUpdateId,
          },
        };
      }

      case "telegram_bind": {
        const botToken = asString(params.botToken);
        if (!botToken) throw new Error("botToken required");
        const identity = await getTelegramBotIdentity(botToken);
        const dm = await observeTelegramPrivateDm(botToken, identity.id, {
          afterUpdateId: asNumber(params.afterUpdateId),
          timeoutMs: 90_000,
        });
        if (!dm) {
          throw new Error(
            "Timed out waiting for a private Telegram message. Send /start to the bot and try again.",
          );
        }

        const existingConfig = fs.existsSync(CHAT_CONFIG_PATH)
          ? (JSON.parse(fs.readFileSync(CHAT_CONFIG_PATH, "utf8")) as Record<string, unknown>)
          : {};
        const nextConfig = buildTelegramDmConfig(existingConfig, {
          botToken,
          identity,
          dm,
        });
        const content = `${JSON.stringify(nextConfig, null, "\t")}\n`;
        writeConfigFile(CHAT_CONFIG_PATH, content);
        return {
          ok: true,
          data: {
            content,
            bot: telegramBotPayload(identity),
            dm,
            path: CHAT_CONFIG_PATH,
          },
        };
      }

      case "telegram_doctor": {
        const config = fs.existsSync(CHAT_CONFIG_PATH)
          ? (JSON.parse(fs.readFileSync(CHAT_CONFIG_PATH, "utf8")) as Record<string, unknown>)
          : {};
        const telegramAccount = Object.values(
          (config as { accounts?: Record<string, unknown> }).accounts || {},
        ).find(
          (account) =>
            typeof account === "object" &&
            account !== null &&
            (account as { service?: unknown }).service === "telegram",
        ) as { botToken?: string } | undefined;
        let bot: TelegramBotIdentity | undefined;
        let botError: string | undefined;
        if (telegramAccount?.botToken) {
          try {
            bot = await getTelegramBotIdentity(telegramAccount.botToken);
          } catch (e: unknown) {
            botError = errMessage(e);
          }
        }
        return {
          ok: true,
          data: {
            report: buildTelegramDoctorReport(config, {
              bot,
              botError,
              workerStatuses: getChatWorkerStatuses(),
            }),
          },
        };
      }

      case "read_super_agent_tasks": {
        let content: string;
        if (fs.existsSync(SUPER_AGENT_TASKS_PATH)) {
          content = fs.readFileSync(SUPER_AGENT_TASKS_PATH, "utf8");
        } else {
          fs.mkdirSync(path.dirname(SUPER_AGENT_TASKS_PATH), { recursive: true });
          content = '{"tasks":[]}';
          fs.writeFileSync(SUPER_AGENT_TASKS_PATH, content, "utf8");
        }
        let tasks: unknown[] = [];
        try {
          const parsed = JSON.parse(content) as { tasks?: unknown[] };
          tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
        } catch {
          tasks = [];
        }
        return { ok: true, data: { tasks } };
      }

      case "write_super_agent_tasks": {
        const tasks = Array.isArray(params.tasks) ? params.tasks : [];
        fs.mkdirSync(path.dirname(SUPER_AGENT_TASKS_PATH), { recursive: true });
        fs.writeFileSync(SUPER_AGENT_TASKS_PATH, JSON.stringify({ tasks }, null, 2), "utf8");
        return { ok: true, data: { count: tasks.length } };
      }

      case "list_super_agent_projects": {
        return { ok: true, data: { projects: listSuperAgentProjects() } };
      }

      case "open_external": {
        const url = asString(params.url);
        if (!url) throw new Error("url is required");
        openExternal(url);
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown configuration operation: ${op}` };
    }
  } catch (e: unknown) {
    return { ok: false, error: errMessage(e) };
  }
}
