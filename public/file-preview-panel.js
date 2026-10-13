// 文件预览面板：顶层状态与生命周期协调薄门面。
// 标签栏渲染、文件加载与渲染器挂载、保存/冲突结算、工具栏与分栏拖拽已下沉至同目录子模块。

import {
  applyPreviewPanelWidth,
  computePreviewToolbarStatus,
  copyPreviewActiveContent,
  DEFAULT_PANEL_RATIO,
  getAvailablePanelWidth,
  hidePreviewGoToLineInput,
  renderPreviewToolbar,
  restorePreviewPreferences,
  savePreviewPreferences,
  setupPreviewControls,
  setupPreviewResizer,
  showPreviewGoToLineInput,
  updatePreviewControlButtons,
  updatePreviewPanelWidth,
} from "./file-preview-panel-controls.js";
import {
  abortAllPreviewTabLoads,
  abortPreviewGitDiff,
  abortPreviewTabLoad,
  fetchPreviewGitDiff,
  isConversionTab,
  isEditableTab,
  loadPreviewTabContent,
  mountPreviewRenderer,
} from "./file-preview-panel-loader.js";
import {
  clearPreviewAutoSave,
  performPreviewSave,
  reloadPreviewTab,
  resolvePreviewSaveConflict,
  savePreviewTab,
  schedulePreviewAutoSave,
  settlePreviewDirtyTabs,
  showPreviewChoiceDialog,
  showPreviewConflictDialog,
  showPreviewDirtyDialog,
} from "./file-preview-panel-save.js";
import {
  activatePreviewContent,
  closePreviewDiffTab,
  closePreviewTab,
  ensurePreviewRovingTabindex,
  getFilePreviewIcon,
  handlePreviewTabKeydown,
  openPreviewDiffTab,
  openPreviewFileTab,
  renderPreviewTabBar,
  selectPreviewTab,
  switchPreviewWorkspaceRoot,
} from "./file-preview-panel-tabs.js";
import { FileTabState } from "./file-tab-state.js";
import { onLocaleChange } from "./i18n.js";
import { normalizeLocalPath } from "./workspace/path-utils.js";

export class FilePreviewPanel {
  constructor({
    panel,
    resizer,
    tabBar,
    content,
    mainContainer,
    fileApi,
    onOpenDesktop,
    onCopyText,
    confirmDirty,
    resolveConflict,
    storage,
  } = {}) {
    this.panel = panel;
    this.resizer = resizer;
    this.tabBar = tabBar;
    this.content = content;
    this.mainContainer = mainContainer;
    this.fileApi = fileApi || null;
    this.onOpenDesktop = onOpenDesktop || (() => {});
    this.onCopyText = onCopyText || ((text) => navigator.clipboard?.writeText(text));
    this.confirmDirty = confirmDirty || ((tabs, reason) => this._showDirtyDialog(tabs, reason));
    this.resolveConflict = resolveConflict || ((tab) => this._showConflictDialog(tab));

    if (storage !== undefined) {
      this.storage = storage;
    } else {
      try {
        this.storage = globalThis.window?.localStorage ?? null;
      } catch {
        this.storage = null;
      }
    }
    this.state = new FileTabState({ storage: this.storage });
    this.currentRenderer = null;
    this.workspaceRoot = "";
    this.gitDiffCache = new Map();
    this.gitDiffControllers = new Map();
    this.loadTokens = new Map();
    this.loadAbortControllers = new Map();
    this.savePromises = new Map();
    this.autoSaveTimers = new Map();
    this.autoSaveEnabled = true;
    this.wrapLines = false;
    this.panelOpen = false;
    this.enlarged = false;
    this.panelRatio = DEFAULT_PANEL_RATIO;
    this.toolbarOpen = false;
    this.goToLineInputOpen = false;
    this.transientStatus = "";
    this.cleanupListeners = [];
    this.activeDialogCancel = null;
    this.diffTabs = new Map();
    this.activeContent = null;
    this._interactionLocked = false;
    this._riskVersion = 0;

    this._restorePreferences();
    this._setupListeners();
    this._setupResizer();
    this._setupControls();
    this._unsubscribeLocale = onLocaleChange(() => {
      this._renderTabBar();
      this._renderToolbar();
    });
  }

  async setWorkspaceRoot(root) {
    return switchPreviewWorkspaceRoot(this, root);
  }

  async openFile(filePath, metadata = {}) {
    return openPreviewFileTab(this, filePath, metadata);
  }

  async revealWrite(filePath) {
    const normalizedPath = normalizeLocalPath(filePath);
    if (!normalizedPath) return null;
    const existing = this.state.getTabs().find((tab) => tab.filePath === normalizedPath);
    if (!existing) return null;
    if (existing.dirty) return this.openFile(normalizedPath);
    await this._reloadTab(existing.id, { skipConfirmation: true });
    return this.state.getTab(existing.id);
  }

  async closePanel() {
    this._captureActiveRenderer();
    const dirtyTabs = this.state.getTabs().filter((tab) => tab.dirty);
    if (dirtyTabs.length > 0) {
      const settled = await this._settleDirtyTabs(dirtyTabs, "panel");
      if (!settled) return false;
    }
    this._closePanel();
    return true;
  }

  enlarge() {
    this.enlarged = true;
    this.panel.classList.add("enlarged");
    this.panel.classList.remove("collapsed");
    if (this.mainContainer) this.mainContainer.classList.add("preview-enlarged");
    this._savePreferences();
    this._updateControlButtons();
  }

  collapse() {
    this.enlarged = false;
    this.panel.classList.remove("enlarged");
    if (this.mainContainer) this.mainContainer.classList.remove("preview-enlarged");
    this._savePreferences();
    this._updateControlButtons();
    this._updatePanelWidth();
  }

  destroy() {
    for (const timer of this.autoSaveTimers.values()) clearTimeout(timer);
    this.autoSaveTimers.clear();
    this._abortAllTabLoads();
    this.loadTokens.clear();
    this._destroyRenderer();
    this.diffTabs.clear();
    this.activeDialogCancel?.();
    this.activeDialogCancel = null;

    for (const cleanup of this.cleanupListeners.splice(0)) cleanup();
    this._unsubscribeState?.();
    this._unsubscribeLocale?.();
  }

  openDiff(descriptor) {
    return openPreviewDiffTab(this, descriptor);
  }

  closeDiffTab(id) {
    return closePreviewDiffTab(this, id);
  }

  activateContent(target = {}) {
    activatePreviewContent(this, target);
  }

  showPanel() {
    this._openPanel();
  }

  hidePanel() {
    this._closePanel();
  }

  hasPersistedTabs(workspaceRoot) {
    return this.state.hasTabsForRoot?.(workspaceRoot) ?? false;
  }

  getCloseRisk() {
    this._riskVersion += 1;
    return {
      version: 3,
      riskVersion: this._riskVersion,
      dirtyFiles: this.state
        .getTabs()
        .filter((tab) => tab.dirty)
        .map((tab) => ({ id: tab.id, name: tab.fileName })),
    };
  }

  setInteractionLocked(locked) {
    this._interactionLocked = Boolean(locked);
    if (this.content) this.content.inert = this._interactionLocked;
    this._renderTabBar();
  }

  async settleCloseRisk(decision) {
    if (decision === "cancel") return this.getCloseRisk();
    const dirtyTabs = this.state.getTabs().filter((tab) => tab.dirty);
    if (dirtyTabs.length === 0) return this.getCloseRisk();
    if (decision === "discard") {
      for (const tab of dirtyTabs) {
        this.state.updateTab(tab.id, { content: tab.originalContent ?? "", dirty: false });
      }
      return this.getCloseRisk();
    }
    for (const tab of dirtyTabs) {
      await this._saveTab(tab.id).catch(() => {});
    }
    return this.getCloseRisk();
  }

  _deactivateCurrent() {
    if (this.activeContent?.kind === "diff") {
      this._destroyRenderer();
      this.content?.replaceChildren();
    } else if (this.activeContent?.kind === "file" || this.currentRenderer) {
      this._captureActiveRenderer();
      this._destroyRenderer();
      this.content?.replaceChildren();
    }
    this.activeContent = null;
  }

  _openPanel() {
    this.panelOpen = true;
    this.panel?.classList.remove("collapsed");
    this.resizer?.classList.remove("collapsed");
    this._updatePanelWidth();
    this._updateControlButtons();
    this._renderToolbar();
  }

  _closePanel() {
    this.panelOpen = false;
    this.enlarged = false;
    this.panel?.classList.add("collapsed");
    this.panel?.classList.remove("enlarged");
    this.resizer?.classList.add("collapsed");
    this.mainContainer?.classList.remove("preview-enlarged");
    if (this.activeContent) this._deactivateCurrent();
    this._destroyRenderer();
    this.content?.replaceChildren();
    this._updateControlButtons();
    this._renderToolbar();
  }

  _destroyRenderer() {
    if (!this.currentRenderer) return;
    this.currentRenderer.destroy();
    this.currentRenderer = null;
  }

  _captureActiveRenderer() {
    const tab = this.state.getActiveTab();
    const value = this.currentRenderer?.getValue?.();
    if (!tab || typeof value !== "string" || value === tab.content) return;
    this.state.updateTab(tab.id, {
      content: value,
      dirty: value !== (tab.originalContent ?? ""),
    });
  }

  _updateControlButtons() {
    updatePreviewControlButtons(this);
  }

  _availableWidth() {
    return getAvailablePanelWidth(this);
  }

  _applyPanelWidth(width) {
    applyPreviewPanelWidth(this, width);
  }

  _updatePanelWidth() {
    updatePreviewPanelWidth(this);
  }

  _renderTabBar() {
    renderPreviewTabBar(this);
  }

  _onTabKeydown(event) {
    handlePreviewTabKeydown(this, event);
  }

  _ensureRovingTabindex() {
    ensurePreviewRovingTabindex(this);
  }

  _getFileIcon(fileName) {
    return getFilePreviewIcon(fileName);
  }

  async _selectTab(tabId) {
    return selectPreviewTab(this, tabId);
  }

  async _closeTab(tabId) {
    return closePreviewTab(this, tabId);
  }

  async _loadTabContent(tab) {
    return loadPreviewTabContent(this, tab);
  }

  _isConversionTab(tab) {
    return isConversionTab(tab);
  }

  _abortTabLoad(tabId) {
    abortPreviewTabLoad(this, tabId);
  }

  _abortAllTabLoads() {
    abortAllPreviewTabLoads(this);
  }

  _abortGitDiff(tabId) {
    abortPreviewGitDiff(this, tabId);
  }

  async _fetchGitDiff(tabId, filePath) {
    return fetchPreviewGitDiff(this, tabId, filePath);
  }

  async _mountIfActive(tabId) {
    if (this.state.activeTabId !== tabId) return;
    const tab = this.state.getTab(tabId);
    if (tab) await this._mountRenderer(tab);
  }

  async _mountRenderer(tab) {
    return mountPreviewRenderer(this, tab);
  }

  _isEditable(tab) {
    return isEditableTab(tab);
  }

  _scheduleAutoSave(tabId) {
    schedulePreviewAutoSave(this, tabId);
  }

  _clearAutoSave(tabId) {
    clearPreviewAutoSave(this, tabId);
  }

  async _saveTab(tabId, options = {}) {
    return savePreviewTab(this, tabId, options);
  }

  async _performSave(tabId, options = {}) {
    return performPreviewSave(this, tabId, options);
  }

  async _resolveSaveConflict(tabId) {
    return resolvePreviewSaveConflict(this, tabId);
  }

  async _reloadTab(tabId, options = {}) {
    return reloadPreviewTab(this, tabId, options);
  }

  async _settleDirtyTabs(tabs, reason) {
    return settlePreviewDirtyTabs(this, tabs, reason);
  }

  async _setMode(mode) {
    const tab = this.state.getActiveTab();
    if (!tab || !["preview", "edit", "diff"].includes(mode)) return false;
    if (mode === "edit" && !this._isEditable(tab)) return false;
    if (mode === "diff" && !this.gitDiffCache.has(tab.id)) return false;
    if (tab.mode === mode) return true;
    this._captureActiveRenderer();
    this.state.updateTab(tab.id, { mode });
    this.state.persist();
    await this._mountRenderer(this.state.getTab(tab.id));
    return true;
  }

  _setupControls() {
    setupPreviewControls(this);
  }

  _listen(target, eventName, listener) {
    if (!target) return;
    target.addEventListener(eventName, listener);
    this.cleanupListeners.push(() => target.removeEventListener(eventName, listener));
  }

  _showGoToLineInput() {
    showPreviewGoToLineInput(this);
  }

  _hideGoToLineInput() {
    hidePreviewGoToLineInput(this);
  }

  async _copyActiveContent() {
    return copyPreviewActiveContent(this);
  }

  _renderToolbar() {
    renderPreviewToolbar(this);
  }

  _toolbarStatus(tab, editable) {
    return computePreviewToolbarStatus(this, tab, editable);
  }

  _setupResizer() {
    setupPreviewResizer(this);
  }

  _setupListeners() {
    this._unsubscribeState = this.state.subscribe(() => {
      this._renderTabBar();
      this._renderToolbar();
    });
  }

  _showDirtyDialog(tabs) {
    return showPreviewDirtyDialog(this, tabs);
  }

  _showConflictDialog(tab) {
    return showPreviewConflictDialog(this, tab);
  }

  _showChoiceDialog(config) {
    return showPreviewChoiceDialog(this, config);
  }

  _restorePreferences() {
    restorePreviewPreferences(this);
  }

  _savePreferences() {
    savePreviewPreferences(this);
  }
}
