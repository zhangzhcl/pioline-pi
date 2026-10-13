import { FilePreviewPanel } from "../../file-preview-panel.js";
import { buildAtMentionValue } from "../../ui/at-file-mention.js";
import { setupResizablePanel } from "../../ui/resizable-panel.js";
import { setupAppUpdater } from "../features/app-updater.js";
import { createFilePreviewFollow } from "../features/file-preview-follow.js";
import { setupGitPanel } from "../features/git-panel-integration.js";
import { renderTurnFileChips } from "../features/turn-file-chips.js";
import { setupSettingsPanel } from "../settings/settings-panel.js";
import {
  isFilePanelShortcut,
  isMacOS,
  setupAppKeyboardShortcuts,
} from "../utils/keyboard-shortcuts.js";
import { toggleExclusiveSideView } from "./exclusive-side-panel.js";
import { NativeFileBrowser } from "./file-browser.js";
import { setupSshRemoteIndicator } from "./ssh-remote-indicator.js";
import { setupNewSessionButton, setupOpenFolderButton } from "./workspace-actions.js";

/**
 * 集中查询原生会话主界面的 DOM 节点。
 */
export function queryNativeAppDom(doc = document) {
  return {
    messagesElement: doc.getElementById("messages"),
    headerElement: doc.querySelector(".header"),
    scrollBottomBadge: doc.getElementById("scroll-bottom-badge"),
    input: doc.getElementById("message-input"),
    form: doc.getElementById("chat-form"),
    abortButton: doc.getElementById("abort-btn"),
    sendButton: doc.getElementById("send-btn"),
    statusText: doc.getElementById("status-text"),
    statusIndicator: doc.getElementById("status-indicator"),
    composerCard: doc.getElementById("composer-card"),
    commandButton: doc.getElementById("command-btn"),
    commandPalette: doc.getElementById("command-palette"),
    commandPaletteOverlay: doc.getElementById("command-palette-overlay"),
    commandList: doc.getElementById("command-list"),
    attachButton: doc.getElementById("attach-btn"),
    imageInput: doc.getElementById("image-input"),
    imagePreviews: doc.getElementById("image-previews"),
    skillSlashMenu: doc.getElementById("skill-slash-menu"),
    atFileMentionMenu: doc.getElementById("at-file-mention-menu"),
    queuedMessages: doc.getElementById("queued-messages"),
    modelDropdown: doc.getElementById("model-dropdown"),
    modelDropdownBtn: doc.getElementById("model-dropdown-btn"),
    modelDropdownLabel: doc.getElementById("model-dropdown-label"),
    modelDropdownMenu: doc.getElementById("model-dropdown-menu"),
    thinkingBtn: doc.getElementById("thinking-btn"),
  };
}

/**
 * 装配设置面板、应用更新器、工作区快捷按钮、SSH 指示器与全局键盘快捷键。
 */
export function setupWorkspaceChromeActions({
  data,
  control,
  preferences,
  terminalIntegration,
  config,
  oauthGateway,
  runtime,
  notifications,
  remoteAuth,
  remoteWorkspaceDialog,
  sessionSwitching,
  runtimeDispatcher,
  input,
  getTarget,
  getStore,
  onModelConfigurationChanged,
  onThinkingLevelChanged,
  showError,
}) {
  const settingsPanel = setupSettingsPanel({
    data,
    control,
    preferences,
    terminal: terminalIntegration,
    getWorkspaceId: () => getTarget().workspaceId,
    configGateway: config,
    oauthGateway,
    onModelConfigurationChanged,
    runtime,
    getTarget,
    onError: showError,
    notify: notifications.notify,
    onRestarted: () => window.location.reload(),
    onThinkingLevelChanged,
    desktopClient: remoteAuth.clientType === "desktop",
  });
  setupAppUpdater({ settingsPanel });
  setupNewSessionButton({ workspaceId: "default", onError: showError });
  setupOpenFolderButton({
    onError: showError,
    onWorkspaceOpened: () => sessionSwitching.getSidebar()?.load({ quiet: true }).catch(showError),
  });
  setupSshRemoteIndicator({
    onEdit: (binding) => remoteWorkspaceDialog.open({ prefill: binding }),
  });
  setupAppKeyboardShortcuts({
    input,
    abort: () => runtimeDispatcher.abortCurrentRun(),
    isWorking: () => getStore().lifecycle === "working",
  });
  return { settingsPanel };
}

/**
 * 统一管理左右侧边栏折叠与拖拽缩放、文件预览面板、Git 变更面板、文件浏览器，以及单轮写入文件 Chip 挂载。
 */
export function setupWorkspacePanelsController({
  data,
  control,
  runtime,
  messagesElement,
  input,
  composerAutoResize,
  getTarget,
  getAtFileMention,
  showError,
}) {
  let fileBrowser = null;
  let turnWrittenPaths = [];

  function createNativeFilePreviewApi({ workspaceId }) {
    const buildUrl = (path, endpoint) => {
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("workspaceId", workspaceId());
      url.searchParams.set("path", path);
      return url;
    };
    return {
      readFileContent(path, { signal } = {}) {
        return fetch(buildUrl(path, "/api/files/content"), { signal });
      },
      writeFileContent({ path, content, expectedMtimeMs, force }) {
        return fetch("/api/files/content", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: workspaceId(),
            path,
            content,
            expectedMtimeMs,
            force,
          }),
        });
      },
      rawUrlForPath(path) {
        return buildUrl(path, "/api/files/raw").toString();
      },
      readGitDiff(path, { signal } = {}) {
        return fetch(buildUrl(path, "/api/git/diff"), { signal });
      },
      readGitStat({ signal } = {}) {
        const url = new URL("/api/git/stat", window.location.origin);
        url.searchParams.set("workspaceId", workspaceId());
        return fetch(url.toString(), { signal });
      },
    };
  }

  async function openWorkspaceRelativePath(relativePath = "") {
    const info = await data.workspaceInfo(getTarget().workspaceId);
    const root = info?.path ?? "";
    const normalizedRelative = String(relativePath || "").replace(/^\/+/, "");
    const absolutePath = normalizedRelative ? `${root}/${normalizedRelative}` : root;
    await control.openInApp(absolutePath);
  }

  function setupFilePreviewPanel() {
    const panel = document.getElementById("file-preview-panel");
    const resizer = document.getElementById("file-preview-resizer");
    const tabBar = document.getElementById("file-preview-tabs");
    const content = document.getElementById("file-preview-content");
    const mainContainer = document.querySelector(".main");
    if (!panel || !resizer || !tabBar || !content || !mainContainer) return null;

    const fileApi = createNativeFilePreviewApi({ workspaceId: () => getTarget().workspaceId });
    return new FilePreviewPanel({
      panel,
      resizer,
      tabBar,
      content,
      mainContainer,
      fileApi,
      onOpenDesktop: (relativePath) => openWorkspaceRelativePath(relativePath).catch(showError),
    });
  }

  const filePreviewPanel = setupFilePreviewPanel();
  const filePreviewFollow = createFilePreviewFollow({
    panel: filePreviewPanel,
    getWorkspacePath: async () => {
      try {
        const response = await data.workspaceInfo(getTarget().workspaceId);
        return response?.info?.path ?? "";
      } catch {
        return "";
      }
    },
    onWriteApplied: (_rawPath, previewPath) => {
      if (!turnWrittenPaths.includes(previewPath)) turnWrittenPaths.push(previewPath);
    },
  });

  const gitPanel = setupGitPanel({
    runtime,
    getTarget,
    container: document.getElementById("git-panel"),
    fileSidebar: document.getElementById("file-sidebar"),
    fileList: document.getElementById("file-list"),
    filePreviewPanel,
    onError: showError,
  });

  function openWorkspacePanel(view) {
    const sidebar = document.getElementById("file-sidebar");
    const infoSidebar = document.getElementById("info-sidebar");
    const result = toggleExclusiveSideView(sidebar, {
      otherPanels: [document.getElementById("diff-sidebar"), infoSidebar],
      currentView: gitPanel?.getTab?.() ?? "files",
      nextView: view,
    });
    if (!result.open) return false;
    gitPanel?.setTab(view);
    return true;
  }

  function openFilesPanel() {
    const opened = openWorkspacePanel("files");
    if (opened && fileBrowser?.currentPath === null) fileBrowser.load().catch(showError);
  }

  function openGitPanel() {
    openWorkspacePanel("git");
  }

  function setupSidebarToggle() {
    const sidebarEl = document.getElementById("sidebar");
    const toggleBtn = document.getElementById("sidebar-toggle");
    const overlay = document.getElementById("sidebar-overlay");
    if (!sidebarEl || !toggleBtn) return;

    const isMobile = () => window.innerWidth <= 768;

    const setCollapsed = (collapsed) => {
      sidebarEl.classList.toggle("collapsed", collapsed);
      overlay?.classList.toggle("visible", !collapsed && isMobile());
    };

    if (isMobile()) {
      setCollapsed(true);
    }

    toggleBtn.addEventListener("click", () => {
      setCollapsed(!sidebarEl.classList.contains("collapsed"));
    });
    overlay?.addEventListener("click", () => setCollapsed(true));
    overlay?.addEventListener("touchend", (e) => {
      e.preventDefault();
      setCollapsed(true);
    });

    setupResizablePanel(sidebarEl, {
      storageKey: "pi-studio-sidebar-width",
      defaultWidth: 272,
      minWidth: 200,
      maxWidth: 480,
      side: "left",
    });

    const fileSidebarEl = document.getElementById("file-sidebar");
    setupResizablePanel(fileSidebarEl, {
      storageKey: "pi-studio-file-sidebar-width",
      defaultWidth: 260,
      minWidth: 200,
      maxWidth: 500,
      side: "right",
    });
  }

  function setupFileBrowser() {
    const sidebar = document.getElementById("file-sidebar");
    const fileList = document.getElementById("file-list");
    const pathEl = document.getElementById("file-sidebar-path");
    if (!sidebar || !fileList || !pathEl) return;

    const upBtn = document.getElementById("file-sidebar-up");
    if (upBtn) upBtn.disabled = true;

    const refreshBtn = document.getElementById("file-sidebar-refresh");
    const toggleHiddenBtn = document.getElementById("file-sidebar-toggle-hidden");

    fileBrowser = new NativeFileBrowser(fileList, pathEl, data, () => getTarget().workspaceId, {
      showViewSwitch: false,
      onFileOpen(entry) {
        openWorkspaceRelativePath(entry.relativePath).catch(showError);
      },
      onFileSelect(entry) {
        filePreviewPanel?.openFile(entry.relativePath, {
          fileName: entry.name,
          size: entry.size,
          mode: entry.mode,
        });
      },
      onMention(entry) {
        const atFileMention = getAtFileMention();
        if (!atFileMention) return;
        const isDirectory = entry.kind === "directory" || entry.isDirectory;
        const value = buildAtMentionValue(entry.relativePath, isDirectory);
        input.focus();
        atFileMention.insert(value, isDirectory);
        composerAutoResize.sync();
      },
      onPathChange(path) {
        if (upBtn) upBtn.disabled = path === "";
      },
      onShowHiddenChange(showHidden) {
        toggleHiddenBtn?.setAttribute("aria-pressed", String(showHidden));
      },
    });

    refreshBtn?.addEventListener("click", () => fileBrowser?.refresh()?.catch(showError));
    toggleHiddenBtn?.addEventListener("click", () => {
      fileBrowser?.setShowHidden(!fileBrowser.showHidden)?.catch(showError);
    });

    document.getElementById("file-sidebar-finder")?.addEventListener("click", async () => {
      try {
        const current = fileBrowser.currentPath ?? "";
        await openWorkspaceRelativePath(current);
      } catch (error) {
        showError(error);
      }
    });

    const toggleBtn = document.getElementById("file-sidebar-toggle");
    toggleBtn?.addEventListener("click", openFilesPanel);
    if (toggleBtn) {
      const shortcutLabel = isMacOS() ? "⌘B" : "Ctrl+B";
      const baseTitle = toggleBtn.title || "Files";
      toggleBtn.title = `${baseTitle} (${shortcutLabel})`;
    }
    document.addEventListener("keydown", (event) => {
      if (!isFilePanelShortcut(event)) return;
      event.preventDefault();
      openFilesPanel();
    });
    document.getElementById("file-sidebar-close")?.addEventListener("click", () => {
      sidebar.classList.add("collapsed");
    });
    upBtn?.addEventListener("click", () => {
      const parent = fileBrowser.getParentPath();
      if (parent !== null) fileBrowser.load(parent).catch(showError);
    });

    const diffSidebar = document.getElementById("diff-sidebar");
    const diffToggle = document.getElementById("diff-sidebar-toggle");
    diffToggle?.addEventListener("click", openGitPanel);
    document.getElementById("diff-sidebar-close")?.addEventListener("click", () => {
      diffSidebar?.classList.add("collapsed");
    });
  }

  function mountTurnFileChips() {
    if (!messagesElement || turnWrittenPaths.length === 0) return;
    const writes = turnWrittenPaths.map((filePath) => ({ filePath }));
    turnWrittenPaths = [];
    const row = renderTurnFileChips(writes);
    if (!row) return;
    const lastAssistant = [...messagesElement.querySelectorAll(".message.assistant")].pop();
    if (lastAssistant && lastAssistant.parentElement === messagesElement) {
      lastAssistant.insertAdjacentElement("afterend", row);
      return;
    }
    messagesElement.appendChild(row);
  }

  messagesElement?.addEventListener("previewfile", (event) => {
    const path = event.detail?.path;
    if (path) void filePreviewFollow.openPath(path).catch(showError);
  });

  return {
    filePreviewPanel,
    filePreviewFollow,
    gitPanel,
    setupSidebarToggle,
    setupFileBrowser,
    resetTurnWrittenPaths() {
      turnWrittenPaths = [];
    },
    mountTurnFileChips,
  };
}
