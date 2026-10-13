// 文件预览面板：标签栏 DOM 渲染、标签打开/切换/关闭流转与文件类型标识。

import { classifyFilePath } from "./file-language.js";
import { createGitDiffRenderer } from "./git-diff-renderer.js";
import { t } from "./i18n.js";
import { normalizeLocalPath } from "./workspace/path-utils.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export function appendCloseIcon(button) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({
    "aria-hidden": "true",
    width: "10",
    height: "10",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2.5",
    "stroke-linecap": "round",
  })) {
    svg.setAttribute(name, value);
  }
  const firstLine = document.createElementNS(SVG_NS, "line");
  firstLine.setAttribute("x1", "18");
  firstLine.setAttribute("y1", "6");
  firstLine.setAttribute("x2", "6");
  firstLine.setAttribute("y2", "18");
  const secondLine = document.createElementNS(SVG_NS, "line");
  secondLine.setAttribute("x1", "6");
  secondLine.setAttribute("y1", "6");
  secondLine.setAttribute("x2", "18");
  secondLine.setAttribute("y2", "18");
  svg.append(firstLine, secondLine);
  button.appendChild(svg);
}

export function getFilePreviewIcon(fileName) {
  const ext = (
    String(fileName || "")
      .split(".")
      .pop() || ""
  ).toLowerCase();
  const iconMap = {
    js: "JS",
    ts: "TS",
    jsx: "JSX",
    tsx: "TSX",
    py: "PY",
    r: "R",
    json: "JSON",
    yaml: "YML",
    yml: "YML",
    md: "MD",
    markdown: "MD",
    html: "HTML",
    css: "CSS",
    png: "IMG",
    jpg: "IMG",
    jpeg: "IMG",
    gif: "IMG",
    svg: "SVG",
    pdf: "PDF",
  };
  return iconMap[ext] || "FILE";
}

export async function switchPreviewWorkspaceRoot(panelInstance, root) {
  const normalized = normalizeLocalPath(root) || "/";
  if (normalized === panelInstance.workspaceRoot) return true;

  panelInstance._captureActiveRenderer();
  const dirtyTabs = panelInstance.state.getTabs().filter((tab) => tab.dirty);
  if (dirtyTabs.length > 0) {
    const settled = await panelInstance._settleDirtyTabs(dirtyTabs, "workspace");
    if (!settled) return false;
  }

  panelInstance._abortAllTabLoads();
  panelInstance._destroyRenderer();
  panelInstance.workspaceRoot = normalized;
  panelInstance.state.load(normalized);
  panelInstance._renderTabBar();
  panelInstance._renderToolbar();

  if (panelInstance.state.getTabs().length === 0) {
    panelInstance.activeContent = null;
    panelInstance._closePanel();
    return true;
  }

  const activeTab = panelInstance.state.getActiveTab();
  panelInstance.activeContent = activeTab ? { kind: "file", id: activeTab.id } : null;
  if (activeTab) {
    const loaded = await panelInstance._loadTabContent(activeTab);
    if (loaded && panelInstance.workspaceRoot === normalized) {
      panelInstance._openPanel();
    } else if (panelInstance.workspaceRoot === normalized) {
      panelInstance.activeContent = null;
    }
  }
  return true;
}

export async function openPreviewFileTab(panelInstance, filePath, metadata = {}) {
  const normalizedPath = normalizeLocalPath(filePath);
  const existing = panelInstance.state.getTabs().find((tab) => tab.filePath === normalizedPath);
  const currentTab = panelInstance.state.getActiveTab();

  if (existing) {
    if (metadata.mode === "diff") panelInstance.state.updateTab(existing.id, { mode: "diff" });
    if (metadata.mode === "diff") {
      void panelInstance._fetchGitDiff(existing.id, existing.filePath);
    }
    if (currentTab?.id !== existing.id) {
      if (panelInstance._isConversionTab(currentTab)) panelInstance._abortTabLoad(currentTab?.id);
      panelInstance._captureActiveRenderer();
      panelInstance.state.selectTab(existing.id);
      if (existing.content === null && existing.loading) {
        panelInstance._abortTabLoad(existing.id);
        panelInstance.state.updateTab(existing.id, {
          loading: false,
          error: null,
          errorDetail: null,
        });
      }
    }
    panelInstance._openPanel();
    panelInstance._renderTabBar();
    const freshExisting = panelInstance.state.getTab(existing.id);
    if (freshExisting?.content === null && !freshExisting.loading) {
      await panelInstance._loadTabContent(freshExisting);
    } else if (currentTab?.id !== existing.id || !panelInstance.currentRenderer) {
      await panelInstance._mountRenderer(freshExisting);
    }
    panelInstance.activeContent = { kind: "file", id: existing.id };
    return existing;
  }

  if (panelInstance._isConversionTab(currentTab)) panelInstance._abortTabLoad(currentTab?.id);
  panelInstance._captureActiveRenderer();
  const defaultMode =
    metadata.mode ?? (classifyFilePath(normalizedPath).contentType === "text" ? "edit" : "preview");
  const tab = panelInstance.state.openFile(normalizedPath, { ...metadata, mode: defaultMode });
  if (metadata.mode === "diff") void panelInstance._fetchGitDiff(tab.id, tab.filePath);
  panelInstance._openPanel();
  panelInstance._renderTabBar();
  await panelInstance._loadTabContent(tab);
  panelInstance.activeContent = { kind: "file", id: tab.id };
  return tab;
}

export function openPreviewDiffTab(panelInstance, descriptor) {
  const id = "git-diff";
  panelInstance.diffTabs.set(id, { ...descriptor, id });
  panelInstance._deactivateCurrent();
  panelInstance.activeContent = { kind: "diff", id };
  panelInstance._destroyRenderer();
  panelInstance.currentRenderer = createGitDiffRenderer({
    ...descriptor,
    wrapLines: panelInstance.wrapLines,
  });
  panelInstance.currentRenderer.mount(panelInstance.content);
  panelInstance._openPanel();
  panelInstance._renderTabBar();
  panelInstance._renderToolbar();
  return id;
}

export function closePreviewDiffTab(panelInstance, id) {
  if (!panelInstance.diffTabs.has(id)) return false;
  panelInstance.diffTabs.delete(id);
  const wasActive =
    panelInstance.activeContent?.kind === "diff" && panelInstance.activeContent.id === id;
  if (wasActive) {
    panelInstance._deactivateCurrent();
    if (panelInstance.state.getActiveTab()) {
      panelInstance.activateContent({ kind: "file", id: panelInstance.state.activeTabId });
    } else {
      panelInstance._closePanel();
    }
  }
  panelInstance._renderTabBar();
  return true;
}

export function activatePreviewContent(panelInstance, { kind, id } = {}) {
  if (kind !== "file" && kind !== "diff") return;
  if (kind === "diff") {
    const diffDescriptor = panelInstance.diffTabs.get(id);
    if (!diffDescriptor) return;
    panelInstance._deactivateCurrent();
    panelInstance.activeContent = { kind: "diff", id };
    panelInstance._destroyRenderer();
    panelInstance.currentRenderer = createGitDiffRenderer({
      ...diffDescriptor,
      wrapLines: panelInstance.wrapLines,
    });
    panelInstance.currentRenderer.mount(panelInstance.content);
    panelInstance._openPanel();
    panelInstance._renderTabBar();
    panelInstance._renderToolbar();
    return;
  }
  panelInstance._deactivateCurrent();
  void panelInstance._selectTab(id).then(() => {
    panelInstance.activeContent = { kind: "file", id };
    panelInstance._renderTabBar();
  });
}

export async function selectPreviewTab(panelInstance, tabId) {
  const currentTab = panelInstance.state.getActiveTab();
  if (currentTab?.id === tabId) {
    if (!panelInstance.currentRenderer) {
      const tab = panelInstance.state.getTab(tabId);
      if (tab) await panelInstance._mountRenderer(tab);
    }
    panelInstance.activeContent = { kind: "file", id: tabId };
    return true;
  }
  if (panelInstance._isConversionTab(currentTab)) panelInstance._abortTabLoad(currentTab?.id);
  panelInstance._captureActiveRenderer();
  if (!panelInstance.state.selectTab(tabId)) return false;

  const tab = panelInstance.state.getTab(tabId);
  if (!tab) return false;
  if (tab.content === null && !tab.loading) {
    await panelInstance._loadTabContent(tab);
  } else {
    await panelInstance._mountRenderer(tab);
  }
  panelInstance.activeContent = { kind: "file", id: tabId };
  return true;
}

export async function closePreviewTab(panelInstance, tabId) {
  const tab = panelInstance.state.getTab(tabId);
  if (!tab) return false;
  if (tab.id === panelInstance.state.activeTabId) panelInstance._captureActiveRenderer();

  const freshTab = panelInstance.state.getTab(tabId);
  if (freshTab?.dirty) {
    const settled = await panelInstance._settleDirtyTabs([freshTab], "tab");
    if (!settled) return false;
  }

  panelInstance._clearAutoSave(tabId);
  panelInstance._abortTabLoad(tabId);
  panelInstance._abortGitDiff(tabId);
  panelInstance.gitDiffCache.delete(tabId);
  panelInstance.loadTokens.delete(tabId);
  const wasActive = panelInstance.state.activeTabId === tabId;
  if (wasActive) panelInstance._destroyRenderer();
  const result = panelInstance.state.closeTab(tabId);
  if (!result.closed) return false;

  if (result.nextTabId) {
    const nextTab = panelInstance.state.getTab(result.nextTabId);
    if (nextTab?.content === null && !nextTab.loading) {
      await panelInstance._loadTabContent(nextTab);
    } else if (wasActive && nextTab) {
      await panelInstance._mountRenderer(nextTab);
    }
    if (wasActive) {
      Array.from(panelInstance.tabBar?.querySelectorAll("[data-tab-id]") || [])
        .find((candidate) => candidate.dataset.tabId === result.nextTabId)
        ?.focus();
    }
  } else {
    panelInstance._closePanel();
    if (wasActive) document.getElementById("file-sidebar-toggle")?.focus();
  }
  return true;
}

export function renderPreviewTabBar(panelInstance) {
  if (!panelInstance.tabBar) return;
  panelInstance.tabBar.replaceChildren();
  panelInstance.tabBar.setAttribute("role", "tablist");

  // Git diff 标签优先渲染（单标签模型，id 固定为 "git-diff"）
  for (const [id, entry] of panelInstance.diffTabs) {
    const isActive =
      panelInstance.activeContent?.kind === "diff" && panelInstance.activeContent.id === id;
    const tabEl = document.createElement("div");
    tabEl.className = `file-preview-tab diff-tab${isActive ? " active" : ""}`;
    tabEl.dataset.diffId = id;
    tabEl.setAttribute("role", "tab");
    tabEl.setAttribute("tabindex", isActive ? "0" : "-1");
    tabEl.setAttribute("aria-selected", String(isActive));

    const name = document.createElement("span");
    name.className = "file-preview-tab-name";
    name.textContent = entry.displayPath || "Diff";
    tabEl.appendChild(name);

    const closeBtn = document.createElement("button");
    closeBtn.className = "file-preview-tab-close";
    closeBtn.type = "button";
    closeBtn.title = t("files.preview.close");
    closeBtn.setAttribute("aria-label", t("files.preview.close"));
    appendCloseIcon(closeBtn);
    closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      panelInstance.closeDiffTab(id);
    });
    tabEl.appendChild(closeBtn);

    tabEl.addEventListener("click", () => {
      if (!panelInstance._interactionLocked) panelInstance.activateContent({ kind: "diff", id });
    });
    tabEl.addEventListener("keydown", (event) => panelInstance._onTabKeydown(event));
    panelInstance.tabBar.appendChild(tabEl);
  }

  for (const tab of panelInstance.state.getTabs()) {
    const tabEl = document.createElement("div");
    const isActive =
      panelInstance.activeContent?.kind === "file"
        ? panelInstance.activeContent.id === tab.id
        : panelInstance.activeContent == null && tab.id === panelInstance.state.activeTabId;
    tabEl.className = `file-preview-tab${isActive ? " active" : ""}`;
    tabEl.dataset.tabId = tab.id;
    tabEl.setAttribute("role", "tab");
    tabEl.setAttribute("tabindex", isActive ? "0" : "-1");
    tabEl.setAttribute("aria-selected", String(isActive));

    const icon = document.createElement("span");
    icon.className = "file-preview-tab-icon";
    icon.textContent = panelInstance._getFileIcon(tab.fileName);
    icon.setAttribute("aria-hidden", "true");
    tabEl.appendChild(icon);

    const name = document.createElement("span");
    name.className = "file-preview-tab-name";
    name.textContent = tab.fileName;
    name.title = tab.filePath;
    tabEl.appendChild(name);

    if (tab.dirty) {
      const dot = document.createElement("span");
      dot.className = "file-preview-tab-dirty";
      dot.textContent = "*";
      dot.title = t("files.unsaved.title");
      dot.setAttribute("aria-label", t("files.unsaved.title"));
      tabEl.appendChild(dot);
    }
    if (tab.conflict) {
      const warning = document.createElement("span");
      warning.className = "file-preview-tab-conflict";
      warning.textContent = "!";
      warning.title = t("files.preview.conflict");
      warning.setAttribute("aria-label", t("files.preview.conflict"));
      tabEl.appendChild(warning);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "file-preview-tab-close";
    closeBtn.type = "button";
    closeBtn.title = t("files.preview.close");
    closeBtn.setAttribute("aria-label", t("files.preview.close"));
    closeBtn.disabled = panelInstance._interactionLocked;
    appendCloseIcon(closeBtn);
    closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void panelInstance._closeTab(tab.id);
    });
    tabEl.appendChild(closeBtn);

    tabEl.addEventListener("click", () => {
      if (!panelInstance._interactionLocked) {
        void panelInstance._selectTab(tab.id).then(() => panelInstance._renderTabBar());
      }
    });
    tabEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void panelInstance._selectTab(tab.id).then(() => panelInstance._renderTabBar());
        return;
      }
      panelInstance._onTabKeydown(event);
    });
    panelInstance.tabBar.appendChild(tabEl);
  }

  panelInstance._ensureRovingTabindex();
}

export function handlePreviewTabKeydown(panelInstance, event) {
  if (panelInstance._interactionLocked) return;
  const tabs = Array.from(panelInstance.tabBar.querySelectorAll(".file-preview-tab"));
  const current = tabs.indexOf(event.currentTarget);
  if (current < 0) return;
  let target = current;
  if (event.key === "ArrowRight") target = (current + 1) % tabs.length;
  else if (event.key === "ArrowLeft") target = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") target = 0;
  else if (event.key === "End") target = tabs.length - 1;
  else return;
  event.preventDefault();
  const next = tabs[target];
  if (next) {
    next.focus();
    next.click();
    next.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }
}

export function ensurePreviewRovingTabindex(panelInstance) {
  if (!panelInstance.tabBar) return;
  const tabs = Array.from(panelInstance.tabBar.querySelectorAll(".file-preview-tab"));
  if (tabs.length === 0) return;
  if (tabs.some((tab) => tab.getAttribute("tabindex") === "0")) return;
  tabs[0].setAttribute("tabindex", "0");
}
