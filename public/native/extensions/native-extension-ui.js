import { createSubagentCatalog } from "../acp/subagent-catalog.js";
import { createSubagentRunManager } from "../acp/subagent-runs.js";
import { setupComposerAgentMenu } from "../composer/composer-agent-menu.js";
import {
  isRpivTodoCommandNotify,
  isRpivTodoWidgetRequest,
  RpivTodoMirrorPanel,
} from "../features/rpiv-todo-mirror.js";
import { randomId } from "../utils/random-id.js";
import { setupRemoteWorkspaceDialog } from "../workspace/remote-workspace-dialog.js";
import { isSshRemoteActive } from "../workspace/ssh-remote-indicator.js";
import { createSshAuthFailureHandler } from "../workspace/ssh-remote-reauth.js";
import { CustomUiPanel } from "./custom-ui-panel.js";
import { showNativeDialog } from "./dialog.js";
import { ExtensionCommandCompatibility } from "./extension-command-compatibility.js";
import { ExtensionUiHost } from "./extension-ui-host.js";
import { ExtensionWidgets } from "./extension-widgets.js";
import { showInlineExtensionPrompt } from "./inline-extension-prompt.js";
import { createWorkflowExtensionDialogHandler } from "./workflow-extension-dialog.js";

/**
 * 装配扩展 UI 宿主（自定义面板、命令兼容性提示、扩展小部件、RPIV Todo 镜像、子代理目录与远程工作区鉴权弹窗）。
 */
export async function setupNativeExtensionUi({
  adapter,
  runtime,
  control,
  config,
  sessionStatus,
  dom,
  messageRenderer,
  composerAutoResize,
  applyHostStatus,
  getTarget,
  t,
  showError,
}) {
  const {
    messagesElement,
    input,
    abortButton,
    composerCard,
    sendButton,
    statusIndicator,
    statusText,
  } = dom;

  const todoMirrorPanel = new RpivTodoMirrorPanel({
    container: document.querySelector(".input-area"),
  });
  const customUiPanel = new CustomUiPanel({
    runtime,
    getTarget,
    onError: showError,
  });
  const subagentCatalog = createSubagentCatalog({ control, isSshRemoteActive });
  const subagentRuns = createSubagentRunManager({
    runtime,
    control,
    getTarget,
    adapter,
    mount: (element) => {
      messagesElement?.appendChild(element);
      element.scrollIntoView({ block: "nearest" });
    },
    sendToPi: (message) => {
      runtime
        .request({ type: "prompt", message }, getTarget(), { idempotencyKey: randomId() })
        .catch(showError);
    },
    onError: showError,
  });
  setupComposerAgentMenu({
    input,
    container: document.getElementById("agent-picker-menu"),
    getAgents: () => subagentCatalog.getAgents(),
  });
  const commandCompatibility = new ExtensionCommandCompatibility({
    workspaceId: getTarget().workspaceId,
    onLearn: (record) => messageRenderer.renderSystemMessage(record.message),
  });
  const extensionWidgets = new ExtensionWidgets({
    aboveEditor: document.getElementById("extension-widgets-above"),
    belowEditor: document.getElementById("extension-widgets-below"),
  });

  const remoteWorkspaceDialog = setupRemoteWorkspaceDialog({
    buttonEl: document.getElementById("open-remote-btn"),
    onError: showError,
  });

  const handleSshReauthNotify = createSshAuthFailureHandler({
    call: window.__picotConfigCall,
    dialog: remoteWorkspaceDialog,
    getProjectPath: () => getTarget().workspaceId,
    reauthMessage: () => t("remoteWorkspace.reauthRequired"),
  });

  const extensionUi = new ExtensionUiHost({
    runtime,
    showDialog: createWorkflowExtensionDialogHandler({
      showNativeDialog,
      handleWorkflowRequest: async (toolRequest, options) => {
        const { handleAgentWorkflowRequest } = await import("../workflow/workflow-panel.js");
        return handleAgentWorkflowRequest(toolRequest, options);
      },
    }),
    showInlinePrompt: (request, opts) =>
      showInlineExtensionPrompt(request, { container: messagesElement, ...opts }),
    hooks: {
      notify: (request) => {
        if (config.consumeNotify(request)) return;
        if (handleSshReauthNotify(request)) return;
        if (customUiPanel.consumeNotify(request)) return;
        if (commandCompatibility.consumeNotify(request)) return;
        if (isRpivTodoCommandNotify(request.message) && todoMirrorPanel.hasVisibleTasks) {
          todoMirrorPanel.expand();
          return;
        }
        messageRenderer.renderSystemMessage(request.message || "");
      },
      status: (request) => applyHostStatus(request.statusText),
      title: (request) => {
        if (request.title) document.title = request.title;
      },
      editorText: (request) => {
        input.value = request.text || "";
        composerAutoResize.sync();
        input.focus();
      },
      widget: (request) => {
        if (isRpivTodoWidgetRequest(request)) return;
        extensionWidgets.apply(request);
      },
    },
  });

  sessionStatus.bind({
    abortButton,
    composerCard,
    getSessionId: () => getTarget().sessionId,
    hasPending: (sessionId) => extensionUi.hasPending(sessionId),
    sendButton,
    statusIndicator,
    statusText,
  });
  await extensionUi.setForegroundSession(getTarget().sessionId, { flush: false });
  await extensionUi.flushForegroundQueue();

  return {
    todoMirrorPanel,
    customUiPanel,
    subagentCatalog,
    subagentRuns,
    commandCompatibility,
    extensionWidgets,
    remoteWorkspaceDialog,
    extensionUi,
  };
}
