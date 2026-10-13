// 文件预览面板：文件内容加载、转换状态映射、Git Diff 异步拉取与渲染器挂载。

import { classifyFilePath } from "./file-language.js";
import { createFileRenderer } from "./file-preview-renderers.js";
import { t } from "./i18n.js";
import { createLoadingPlaceholder } from "./ui/loading-placeholder.js";

export function isConversionTab(tab) {
  return Boolean(tab && classifyFilePath(tab.filePath).contentType === "convertible");
}

export function isEditableTab(tab) {
  if (
    !tab ||
    tab.content === null ||
    tab.editable === false ||
    tab.truncated ||
    tab.isBinary ||
    (tab.renderAs === "markdown" && classifyFilePath(tab.filePath).contentType === "convertible")
  ) {
    return false;
  }
  return classifyFilePath(tab.filePath).editable;
}

export function abortPreviewTabLoad(panelInstance, tabId) {
  if (!tabId) return;
  panelInstance.loadTokens.set(tabId, (panelInstance.loadTokens.get(tabId) || 0) + 1);
  const tab = panelInstance.state.getTab(tabId);
  if (tab?.content === null && tab.loading) {
    panelInstance.state.updateTab(tabId, { loading: false, error: null, errorDetail: null });
  }
  const controller = panelInstance.loadAbortControllers.get(tabId);
  if (!controller) return;
  panelInstance.loadAbortControllers.delete(tabId);
  controller.abort();
}

export function abortPreviewGitDiff(panelInstance, tabId) {
  const ctrl = panelInstance.gitDiffControllers.get(tabId);
  if (ctrl) {
    ctrl.abort();
    panelInstance.gitDiffControllers.delete(tabId);
  }
}

export function abortAllPreviewTabLoads(panelInstance) {
  for (const tabId of panelInstance.loadAbortControllers.keys()) {
    abortPreviewTabLoad(panelInstance, tabId);
  }
  for (const tabId of [...panelInstance.gitDiffControllers.keys()]) {
    abortPreviewGitDiff(panelInstance, tabId);
  }
  panelInstance.gitDiffCache.clear();
}

export async function fetchPreviewGitDiff(panelInstance, tabId, filePath) {
  abortPreviewGitDiff(panelInstance, tabId);
  const ctrl = new AbortController();
  panelInstance.gitDiffControllers.set(tabId, ctrl);
  try {
    const res = await panelInstance.fileApi?.readGitDiff?.(filePath, { signal: ctrl.signal });
    if (!res?.ok) {
      panelInstance.gitDiffCache.set(tabId, null);
      return;
    }
    const data = await res.json();
    if (!data.supported) {
      panelInstance.gitDiffCache.set(tabId, null);
      return;
    }
    panelInstance.gitDiffCache.set(tabId, data);
  } catch (error) {
    if (error?.name !== "AbortError") panelInstance.gitDiffCache.set(tabId, null);
    return;
  } finally {
    if (panelInstance.gitDiffControllers.get(tabId) === ctrl) {
      panelInstance.gitDiffControllers.delete(tabId);
    }
  }
  panelInstance._renderToolbar();
  const activeTab = panelInstance.state.getActiveTab();
  if (activeTab?.id === tabId && activeTab?.mode === "diff") {
    await panelInstance._mountRenderer(panelInstance.state.getTab(tabId));
  }
}

export async function loadPreviewTabContent(panelInstance, tab) {
  abortPreviewTabLoad(panelInstance, tab.id);
  const token = (panelInstance.loadTokens.get(tab.id) || 0) + 1;
  panelInstance.loadTokens.set(tab.id, token);
  panelInstance.state.updateTab(tab.id, { loading: true, error: null, errorDetail: null });

  const controller = new AbortController();
  panelInstance.loadAbortControllers.set(tab.id, controller);

  try {
    const res = panelInstance.fileApi?.readFileContent
      ? await panelInstance.fileApi.readFileContent(tab.filePath, { signal: controller.signal })
      : await fetch(`/api/files/content?path=${encodeURIComponent(tab.filePath)}`, {
          signal: controller.signal,
        });
    if (panelInstance.loadTokens.get(tab.id) !== token || !panelInstance.state.getTab(tab.id)) {
      return false;
    }
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      panelInstance.state.updateTab(tab.id, {
        loading: false,
        error: t("files.preview.loadError"),
        errorDetail: errorData.error || `HTTP ${res.status}`,
      });
      await panelInstance._mountIfActive(tab.id);
      return false;
    }

    const data = await res.json();
    if (panelInstance.loadTokens.get(tab.id) !== token || !panelInstance.state.getTab(tab.id)) {
      return false;
    }
    const classification = classifyFilePath(tab.filePath);
    if (data.previewStatus === "dependencyUnavailable") {
      const reason = data.dependencyReason;
      const version = typeof data.pythonVersion === "string" ? data.pythonVersion : "";
      const messageKey = `files.preview.markitdown.${reason}`;
      const message = t(messageKey, version ? { version } : undefined);
      const needsInstallCommand =
        reason === "markitdownMissing" || reason === "markitdownIncompatible";
      const displayCommand =
        typeof data.displayCommand === "string" && /^[a-z0-9 ._-]+$/i.test(data.displayCommand)
          ? data.displayCommand
          : /win/i.test(globalThis.navigator?.platform || "")
            ? "py -3"
            : "python3";
      const installKey = /win/i.test(displayCommand)
        ? "files.preview.markitdown.installWindows"
        : "files.preview.markitdown.installPosix";
      const installCommand = t(installKey).replace(/^(python3|py -3)/, displayCommand);
      const guidance = needsInstallCommand ? `${message}\n${installCommand}` : message;
      panelInstance.state.updateTab(tab.id, {
        loading: false,
        content: null,
        originalContent: null,
        editable: false,
        mode: "preview",
        error: guidance,
        errorDetail: null,
        isBinary: false,
      });
      await panelInstance._mountIfActive(tab.id);
      return false;
    }
    if (data.previewStatus === "conversionFailed") {
      panelInstance.state.updateTab(tab.id, {
        loading: false,
        content: null,
        originalContent: null,
        editable: false,
        mode: "preview",
        error: t("files.preview.unsupportedBinary"),
        errorDetail: null,
        isBinary: false,
      });
      await panelInstance._mountIfActive(tab.id);
      return false;
    }
    if (
      data.isBinary &&
      (classification.contentType === "text" || classification.contentType === "binary")
    ) {
      panelInstance.state.updateTab(tab.id, {
        loading: false,
        error: t("files.preview.unsupportedBinary"),
        errorDetail: null,
        isBinary: true,
        editable: false,
      });
      await panelInstance._mountIfActive(tab.id);
      return false;
    }

    const editable =
      data.editable !== false && classification.editable && !data.truncated && !data.isBinary;
    panelInstance.state.updateTab(tab.id, {
      loading: false,
      content: data.content ?? "",
      originalContent: data.content ?? "",
      renderAs: data.renderAs,
      mtimeMs: data.mtimeMs,
      mimeType: data.mimeType,
      size: data.size,
      truncated: Boolean(data.truncated),
      isBinary: Boolean(data.isBinary),
      editable,
      dirty: false,
      conflict: false,
      saveError: null,
      error: null,
      errorDetail: null,
      mode: editable ? tab.mode : "preview",
    });
    panelInstance.state.persist();
    await panelInstance._mountIfActive(tab.id);
    if (panelInstance.workspaceRoot) {
      void panelInstance._fetchGitDiff(tab.id, tab.filePath);
    }
    return true;
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) {
      if (panelInstance.loadTokens.get(tab.id) === token && panelInstance.state.getTab(tab.id)) {
        panelInstance.state.updateTab(tab.id, { loading: false, error: null, errorDetail: null });
      }
      return false;
    }
    if (panelInstance.loadTokens.get(tab.id) !== token || !panelInstance.state.getTab(tab.id)) {
      return false;
    }
    panelInstance.state.updateTab(tab.id, {
      loading: false,
      error: t("files.preview.loadError"),
      errorDetail: error instanceof Error ? error.message : String(error),
    });
    await panelInstance._mountIfActive(tab.id);
    return false;
  } finally {
    if (panelInstance.loadAbortControllers.get(tab.id) === controller) {
      panelInstance.loadAbortControllers.delete(tab.id);
    }
  }
}

export async function mountPreviewRenderer(panelInstance, tab) {
  if (!tab || tab.id !== panelInstance.state.activeTabId || !panelInstance.content) return;
  panelInstance._destroyRenderer();
  panelInstance.content.replaceChildren();

  if (tab.loading) {
    panelInstance.content.appendChild(
      createLoadingPlaceholder({
        className: "file-preview-loading",
        label: t("files.preview.loading"),
      }),
    );
    panelInstance._renderToolbar();
    return;
  }
  if (tab.error) {
    const errorEl = document.createElement("div");
    errorEl.className = "file-preview-error";
    errorEl.textContent = tab.error;
    panelInstance.content.appendChild(errorEl);
    panelInstance._renderToolbar();
    return;
  }

  panelInstance.currentRenderer = createFileRenderer({
    filePath: tab.filePath,
    fileName: tab.fileName,
    content: tab.content || "",
    mimeType: tab.mimeType,
    renderAs: tab.renderAs,
    mode: tab.mode || "preview",
    readOnly: tab.mode !== "edit" || !panelInstance._isEditable(tab),
    wrapLines: panelInstance.wrapLines,
    gitDiff: panelInstance.gitDiffCache.get(tab.id) ?? undefined,
    onChange: (newContent) => {
      if (panelInstance._interactionLocked) return;
      const freshTab = panelInstance.state.getTab(tab.id);
      if (!freshTab) return;
      const dirty = newContent !== (freshTab.originalContent ?? "");
      panelInstance.state.updateTab(tab.id, {
        content: newContent,
        dirty,
        saveError: null,
      });
      if (dirty) panelInstance._scheduleAutoSave(tab.id);
    },
    onModeChange: (mode) => {
      if (panelInstance._interactionLocked) return;
      panelInstance.state.updateTab(tab.id, { mode });
      panelInstance.state.persist();
    },
    onError: (error) => {
      panelInstance.state.updateTab(tab.id, {
        error: t("files.preview.loadError"),
        errorDetail: error instanceof Error ? error.message : String(error),
      });
    },
    rawUrlForPath: panelInstance.fileApi?.rawUrlForPath?.bind(panelInstance.fileApi),
  });
  panelInstance.currentRenderer.mount(panelInstance.content);
  panelInstance._renderToolbar();
}
