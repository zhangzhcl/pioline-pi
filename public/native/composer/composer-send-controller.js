import { setupAtFileMention } from "../../ui/at-file-mention.js";
import { setupCommandPalette } from "../extensions/command-palette.js";
import { randomId } from "../utils/random-id.js";
import { isProjectDisconnected } from "../workspace/project-connection-status.js";
import { isSshRemoteActive } from "../workspace/ssh-remote-indicator.js";
import { openReconnectDialog } from "../workspace/ssh-remote-reauth.js";
import { setupComposerImageAttachments } from "./composer-images.js";
import { setupComposerPasteOffload } from "./composer-paste-offload.js";
import { setupComposerSlashMenu } from "./composer-slash-menu.js";
import { setupComposerSubmitHandling } from "./composer-submit.js";
import {
  buildCommandCatalog,
  matchCatalogCommand,
  resolveComposerInput,
} from "./slash-commands.js";

/**
 * 装配输入区附件、粘贴转存、`@` 文件引用、`/` 命令菜单、命令面板，并处理消息与子代理任务发送。
 */
export function setupComposerSendController({
  input,
  form,
  composerCard,
  attachButton,
  imageInput,
  imagePreviews,
  skillSlashMenu,
  atFileMentionMenu,
  commandButton,
  commandPalette,
  commandPaletteOverlay,
  commandList,
  composerAutoResize,
  runtime,
  config,
  toolRenderer,
  messageRenderer,
  commandCompatibility,
  subagentCatalog,
  subagentRuns,
  ensureWorkflowModeForPrompt,
  remoteWorkspaceDialog,
  getTarget,
  getStore,
  clearPendingForkSwitchCheck,
  t,
  showError,
}) {
  let commandCatalog = buildCommandCatalog({});

  const atFileMention = atFileMentionMenu
    ? setupAtFileMention({
        input,
        container: atFileMentionMenu,
        getWorkspaceRoot: () => getTarget().workspaceId,
        searchFiles: async (workspaceId, query, signal) => {
          const url = new URL("/api/file-mentions", window.location.origin);
          url.searchParams.set("workspaceId", workspaceId);
          url.searchParams.set("query", query);
          const response = await fetch(url, { signal });
          if (!response.ok) throw new Error(`File mention search failed: ${response.status}`);
          return response.json();
        },
      })
    : null;

  const pasteOffload = setupComposerPasteOffload({
    textarea: input,
    container: composerCard,
    offload: async (content) => {
      const result = await config.call("write_paste_offload", { content });
      if (!result?.ok || typeof result.data?.path !== "string") {
        throw new Error(result?.error || "Paste offload failed");
      }
      return result.data.path;
    },
    t,
  });

  const imageAttachments = setupComposerImageAttachments({
    input,
    attachButton,
    imageInput,
    previewContainer: imagePreviews,
    dropTarget: composerCard,
    onError: showError,
  });

  const slashMenu = setupComposerSlashMenu({
    input,
    container: skillSlashMenu,
    getCommands: () => commandCompatibility.decorate(commandCatalog.values()),
  });

  function runBuiltin(action) {
    if (action === "open_settings") document.getElementById("settings-btn")?.click();
    else if (action === "open_tree") document.dispatchEvent(new CustomEvent("picot:open-tree"));
    else if (action === "show_help") {
      messageRenderer.renderSystemMessage(
        "Enter sends a prompt; while working Enter steers and Alt+Enter queues a follow-up. Use // for a literal slash.",
      );
    }
  }

  setupCommandPalette({
    button: commandButton,
    palette: commandPalette,
    overlay: commandPaletteOverlay,
    list: commandList,
    commands: () => [
      {
        icon: "+",
        label: t("input.expandAllTools"),
        desc: t("input.expandAllToolsDesc"),
        action: () => toolRenderer.expandAll(),
      },
      {
        icon: "-",
        label: t("input.collapseAllTools"),
        desc: t("input.collapseAllToolsDesc"),
        action: () => toolRenderer.collapseAll(),
      },
      {
        icon: "*",
        label: t("settings.title"),
        desc: t("settings.openSettings"),
        action: () => document.getElementById("settings-btn")?.click(),
      },
      {
        icon: "?",
        label: "Help",
        desc: "Show composer shortcuts",
        action: () => runBuiltin("show_help"),
      },
    ],
    onError: showError,
  });

  async function sendComposerInput({ altKey }) {
    if (pasteOffload?.isBusy()) return;
    const value = input.value;
    const images = imageAttachments.getImages();
    if (!value.trim() && images.length === 0) return;

    const subagentTask = subagentCatalog.parseTask(value);
    if (subagentTask && isSshRemoteActive()) {
      messageRenderer.renderSystemMessage(t("messages.subagentUnavailableOverSsh"));
      return;
    }
    if (subagentTask?.incomplete) {
      const { token, label } = subagentTask.agent;
      messageRenderer.renderSystemMessage(
        `Add a task after #${token}, e.g. #${token} ask ${label} to review the diff.`,
      );
      return;
    }
    if (subagentTask) {
      input.value = "";
      input.scrollTop = 0;
      composerAutoResize.sync();
      imageAttachments.clear();
      subagentRuns.start(subagentTask.task, subagentTask.agent).catch(showError);
      return;
    }

    const store = getStore();
    const target = getTarget();
    const intent = resolveComposerInput(value, commandCatalog, {
      working: store.lifecycle === "working",
      altKey,
      images,
    });
    if (intent.kind === "rejected") throw new Error(intent.reason);
    if (intent.kind === "runtime" && intent.command.type === "prompt" && !value.startsWith("/")) {
      await ensureWorkflowModeForPrompt(value);
    }
    if (intent.kind === "builtin") {
      runBuiltin(intent.action);
      return;
    }
    if (isProjectDisconnected(target.workspaceId)) {
      messageRenderer.renderSystemMessage(t("messages.sshProjectDisconnected"));
      void openReconnectDialog({
        call: window.__picotConfigCall,
        dialog: remoteWorkspaceDialog,
        reauthMessage: () => t("remoteWorkspace.reauthRequired"),
        projectPath: target.workspaceId,
      });
      return;
    }
    input.value = "";
    input.scrollTop = 0;
    composerAutoResize.sync();
    imageAttachments.clear();
    commandCompatibility.beginCommand(matchCatalogCommand(value, commandCatalog)?.command);
    try {
      await runtime.request(intent.command, target, { idempotencyKey: randomId() });
    } catch (error) {
      input.value = value;
      composerAutoResize.sync();
      imageAttachments.setImages(images);
      clearPendingForkSwitchCheck();
      throw error;
    }
  }

  setupComposerSubmitHandling({
    input,
    form,
    onSubmit: ({ altKey }) => {
      sendComposerInput({ altKey }).catch(showError);
    },
  });

  async function loadCommands() {
    const result = await runtime.request({ type: "get_commands" }, getTarget());
    commandCatalog = buildCommandCatalog({
      nativeCommands: result.response?.data?.commands ?? [],
    });
    commandCompatibility.prune(commandCatalog.values());
  }

  return {
    atFileMention,
    slashMenu,
    loadCommands,
    sendComposerInput,
    runBuiltin,
  };
}
