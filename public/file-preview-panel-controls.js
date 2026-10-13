// 文件预览面板：浮动工具栏、分栏宽度拖拽与快捷键、偏好存储。

import { classifyFilePath } from "./file-language.js";
import { t } from "./i18n.js";

export const DEFAULT_PANEL_RATIO = 0.42;
export const MIN_PANEL_WIDTH = 320;

export function updatePreviewControlButtons(panelInstance) {
  const enlargeBtn = document.getElementById("file-preview-enlarge");
  const collapseBtn = document.getElementById("file-preview-collapse");
  enlargeBtn?.classList.toggle("hidden", panelInstance.enlarged);
  collapseBtn?.classList.toggle("hidden", !panelInstance.enlarged);
}

export function getAvailablePanelWidth(panelInstance) {
  const layoutWidth = panelInstance.panel?.parentElement?.offsetWidth || 0;
  const combinedWidth =
    (panelInstance.mainContainer?.offsetWidth || 0) + (panelInstance.panel?.offsetWidth || 0);
  return layoutWidth || combinedWidth || panelInstance.mainContainer?.offsetWidth || 800;
}

export function applyPreviewPanelWidth(panelInstance, width) {
  const totalWidth = panelInstance._availableWidth();
  const maxWidth = Math.max(1, totalWidth * 0.7);
  const minWidth = Math.min(MIN_PANEL_WIDTH, maxWidth);
  const clampedWidth = Math.max(minWidth, Math.min(maxWidth, width));
  panelInstance.panelRatio = clampedWidth / totalWidth;
  panelInstance.panel.style.width = `${Math.round(clampedWidth)}px`;
  panelInstance.panel.style.flexBasis = `${Math.round(clampedWidth)}px`;
  panelInstance.resizer?.setAttribute(
    "aria-valuenow",
    String(Math.round(panelInstance.panelRatio * 100)),
  );
}

export function updatePreviewPanelWidth(panelInstance) {
  if (!panelInstance.panel || panelInstance.enlarged) return;
  panelInstance._applyPanelWidth(panelInstance._availableWidth() * panelInstance.panelRatio);
}

export function setupPreviewControls(panelInstance) {
  panelInstance.controls = {
    toolbar: document.getElementById("file-preview-toolbar"),
    toolbarToggle: document.getElementById("file-preview-toolbar-toggle"),
    preview: document.getElementById("file-preview-mode-preview"),
    edit: document.getElementById("file-preview-mode-edit"),
    save: document.getElementById("file-preview-save"),
    reload: document.getElementById("file-preview-reload"),
    search: document.getElementById("file-preview-search"),
    goToLine: document.getElementById("file-preview-go-to-line"),
    diff: document.getElementById("file-preview-mode-diff"),
    goToLineInput: document.getElementById("file-preview-go-to-line-input"),
    copy: document.getElementById("file-preview-copy"),
    openDesktop: document.getElementById("file-preview-open"),
    wrap: document.getElementById("file-preview-wrap"),
    autoSave: document.getElementById("file-preview-autosave"),
    status: document.getElementById("file-preview-status"),
  };

  panelInstance._listen(document.getElementById("file-preview-enlarge"), "click", () =>
    panelInstance.enlarge(),
  );
  panelInstance._listen(document.getElementById("file-preview-collapse"), "click", () =>
    panelInstance.collapse(),
  );
  panelInstance._listen(document.getElementById("file-preview-close"), "click", () => {
    void panelInstance.closePanel();
  });
  panelInstance._listen(panelInstance.controls.toolbarToggle, "click", () => {
    panelInstance.toolbarOpen = !panelInstance.toolbarOpen;
    panelInstance._renderToolbar();
  });
  panelInstance._listen(
    panelInstance.controls.preview,
    "click",
    () => void panelInstance._setMode("preview"),
  );
  panelInstance._listen(
    panelInstance.controls.edit,
    "click",
    () => void panelInstance._setMode("edit"),
  );
  panelInstance._listen(
    panelInstance.controls.diff,
    "click",
    () => void panelInstance._setMode("diff"),
  );
  panelInstance._listen(panelInstance.controls.save, "click", () => {
    const tab = panelInstance.state.getActiveTab();
    if (tab) void panelInstance._saveTab(tab.id);
  });
  panelInstance._listen(panelInstance.controls.reload, "click", () => {
    const tab = panelInstance.state.getActiveTab();
    if (tab) void panelInstance._reloadTab(tab.id);
  });
  panelInstance._listen(panelInstance.controls.search, "click", () =>
    panelInstance.currentRenderer?.openSearch?.(),
  );
  panelInstance._listen(panelInstance.controls.goToLine, "click", () =>
    panelInstance._showGoToLineInput(),
  );
  panelInstance._listen(panelInstance.controls.goToLineInput, "keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      panelInstance._hideGoToLineInput();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const raw = event.target.value.trim();
    if (/^[1-9]\d*$/.test(raw)) {
      panelInstance.currentRenderer?.goToLine?.(Number(raw));
    }
    panelInstance._hideGoToLineInput();
  });
  panelInstance._listen(panelInstance.controls.goToLineInput, "blur", () =>
    panelInstance._hideGoToLineInput(),
  );
  panelInstance._listen(
    panelInstance.controls.copy,
    "click",
    () => void panelInstance._copyActiveContent(),
  );
  panelInstance._listen(panelInstance.controls.openDesktop, "click", () => {
    const tab = panelInstance.state.getActiveTab();
    if (tab) panelInstance.onOpenDesktop(tab.filePath);
  });
  panelInstance._listen(panelInstance.controls.wrap, "change", (event) => {
    panelInstance.wrapLines = Boolean(event.target.checked);
    panelInstance.currentRenderer?.setWrapLines?.(panelInstance.wrapLines);
    panelInstance._savePreferences();
    panelInstance._renderToolbar();
  });
  panelInstance._listen(panelInstance.controls.autoSave, "change", (event) => {
    panelInstance.autoSaveEnabled = Boolean(event.target.checked);
    if (!panelInstance.autoSaveEnabled) {
      for (const tabId of panelInstance.autoSaveTimers.keys()) {
        panelInstance._clearAutoSave(tabId);
      }
    } else {
      const tab = panelInstance.state.getActiveTab();
      if (tab?.dirty) panelInstance._scheduleAutoSave(tab.id);
    }
    panelInstance._savePreferences();
    panelInstance._renderToolbar();
  });
  panelInstance._renderToolbar();
}

export function showPreviewGoToLineInput(panelInstance) {
  if (!panelInstance.controls?.goToLineInput || panelInstance.controls.goToLine?.disabled) return;
  panelInstance.goToLineInputOpen = true;
  panelInstance._renderToolbar();
  panelInstance.controls.goToLineInput.value = "";
  panelInstance.controls.goToLineInput.focus();
}

export function hidePreviewGoToLineInput(panelInstance) {
  if (!panelInstance.goToLineInputOpen) return;
  panelInstance.goToLineInputOpen = false;
  panelInstance._renderToolbar();
}

export async function copyPreviewActiveContent(panelInstance) {
  panelInstance._captureActiveRenderer();
  const tab = panelInstance.state.getActiveTab();
  if (!tab || typeof tab.content !== "string") return;
  try {
    await panelInstance.onCopyText(tab.content);
    panelInstance.transientStatus = t("messages.copied");
  } catch {
    panelInstance.transientStatus = t("files.preview.copyFailed");
  }
  panelInstance._renderToolbar();
  setTimeout(() => {
    panelInstance.transientStatus = "";
    panelInstance._renderToolbar();
  }, 1200);
}

export function renderPreviewToolbar(panelInstance) {
  const controls = panelInstance.controls;
  if (!controls) return;
  controls.toolbar?.classList.toggle("hidden", !panelInstance.toolbarOpen);
  controls.toolbarToggle?.setAttribute("aria-expanded", String(panelInstance.toolbarOpen));

  const tab = panelInstance.state.getActiveTab();
  const editable = panelInstance._isEditable(tab);
  const hasText = typeof tab?.content === "string" && !tab?.isBinary;
  const contentType = tab ? classifyFilePath(tab.filePath).contentType : "";
  const hasEditor =
    hasText &&
    contentType !== "image" &&
    contentType !== "pdf" &&
    contentType !== "convertible" &&
    ((contentType !== "markdown" && contentType !== "html") || tab.mode === "edit");

  const hasDiff = tab
    ? panelInstance.gitDiffCache.has(tab.id) && panelInstance.gitDiffCache.get(tab.id) !== null
    : false;
  if (controls.preview) {
    controls.preview.disabled = !hasText;
    controls.preview.classList.toggle(
      "active",
      hasText && tab?.mode !== "edit" && tab?.mode !== "diff",
    );
    controls.preview.setAttribute(
      "aria-pressed",
      String(hasText && tab?.mode !== "edit" && tab?.mode !== "diff"),
    );
  }
  if (controls.edit) {
    controls.edit.disabled = !editable;
    controls.edit.classList.toggle("active", tab?.mode === "edit");
    controls.edit.setAttribute("aria-pressed", String(tab?.mode === "edit"));
  }
  if (controls.diff) {
    controls.diff.disabled = !hasDiff;
    controls.diff.classList.toggle("active", tab?.mode === "diff");
    controls.diff.setAttribute("aria-pressed", String(tab?.mode === "diff"));
  }
  if (controls.save) controls.save.disabled = !tab?.dirty || !editable || tab.saving;
  if (controls.reload) controls.reload.disabled = !tab || tab.loading;
  if (controls.search) controls.search.disabled = !hasEditor;
  if (controls.goToLine) {
    controls.goToLine.disabled = !hasEditor;
    controls.goToLine.classList.toggle("hidden", hasEditor && panelInstance.goToLineInputOpen);
  }
  if (controls.goToLineInput) {
    controls.goToLineInput.disabled = !hasEditor;
    controls.goToLineInput.classList.toggle(
      "hidden",
      !hasEditor || !panelInstance.goToLineInputOpen,
    );
  }
  if (controls.copy) controls.copy.disabled = !hasText;
  if (controls.openDesktop) controls.openDesktop.disabled = !tab;
  if (controls.wrap) controls.wrap.checked = panelInstance.wrapLines;
  if (controls.autoSave) controls.autoSave.checked = panelInstance.autoSaveEnabled;
  if (controls.status) {
    controls.status.textContent = panelInstance._toolbarStatus(tab, editable);
  }
}

export function computePreviewToolbarStatus(panelInstance, tab, editable) {
  if (panelInstance.transientStatus) return panelInstance.transientStatus;
  if (!tab) return "";
  if (tab.loading) return t("files.preview.loading");
  if (tab.saving) return t("files.preview.saving");
  if (tab.conflict) return t("files.preview.conflict");
  if (tab.saveError) return tab.saveError;
  if (tab.dirty) return t("files.unsaved.title");
  if (!editable) return t("files.preview.readOnly");
  return t("files.preview.saved");
}

export function setupPreviewResizer(panelInstance) {
  if (!panelInstance.resizer) return;
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const onMouseDown = (event) => {
    if (event.button !== 0) return;
    dragging = true;
    startX = event.clientX;
    startWidth = panelInstance.panel.offsetWidth;
    panelInstance.resizer.classList.add("dragging");
    document.body.classList.add("file-preview-resizing");
    event.preventDefault();
  };
  const onMouseMove = (event) => {
    if (!dragging) return;
    panelInstance._applyPanelWidth(startWidth + startX - event.clientX);
  };
  const finishDrag = () => {
    if (!dragging) return;
    dragging = false;
    panelInstance.resizer.classList.remove("dragging");
    document.body.classList.remove("file-preview-resizing");
    panelInstance._savePreferences();
  };
  const onKeyDown = (event) => {
    const currentWidth =
      panelInstance.panel.offsetWidth || panelInstance._availableWidth() * panelInstance.panelRatio;
    let nextWidth = currentWidth;
    if (event.key === "ArrowLeft") nextWidth += 16;
    else if (event.key === "ArrowRight") nextWidth -= 16;
    else if (event.key === "Home") nextWidth = MIN_PANEL_WIDTH;
    else if (event.key === "End") nextWidth = panelInstance._availableWidth() * 0.7;
    else return;
    event.preventDefault();
    panelInstance._applyPanelWidth(nextWidth);
    panelInstance._savePreferences();
  };
  const onResize = () => panelInstance._updatePanelWidth();

  panelInstance._listen(panelInstance.resizer, "mousedown", onMouseDown);
  panelInstance._listen(document, "mousemove", onMouseMove);
  panelInstance._listen(document, "mouseup", finishDrag);
  panelInstance._listen(panelInstance.resizer, "keydown", onKeyDown);
  panelInstance._listen(window, "resize", onResize);
  panelInstance.cleanupListeners.push(() => {
    dragging = false;
    panelInstance.resizer.classList.remove("dragging");
    document.body.classList.remove("file-preview-resizing");
  });
}

export function restorePreviewPreferences(panelInstance) {
  try {
    const storage = panelInstance.storage;
    if (!storage) return;
    const storedRatio = Number.parseFloat(storage.getItem("picot-preview-panel-ratio"));
    panelInstance.panelRatio = Number.isFinite(storedRatio)
      ? Math.max(0.2, Math.min(0.7, storedRatio))
      : DEFAULT_PANEL_RATIO;
    panelInstance.wrapLines = storage.getItem("picot-preview-wrap") === "true";
    panelInstance.autoSaveEnabled = storage.getItem("picot-preview-autosave") !== "false";
  } catch {
    panelInstance.panelRatio = DEFAULT_PANEL_RATIO;
  }
}

export function savePreviewPreferences(panelInstance) {
  try {
    const storage = panelInstance.storage;
    if (!storage) return;
    storage.setItem("picot-preview-panel-ratio", String(panelInstance.panelRatio));
    storage.setItem("picot-preview-wrap", String(panelInstance.wrapLines));
    storage.setItem("picot-preview-autosave", String(panelInstance.autoSaveEnabled));
  } catch {
    // 忽略无痕/受限 WebView 下的存储写入异常
  }
}
