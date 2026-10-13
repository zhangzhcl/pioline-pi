// 文件预览面板：保存、自动保存、冲突解决、未保存标签结算与确认弹窗。

import { t } from "./i18n.js";
import { bindDialogEscape } from "./ui/dialog-escape.js";

export const AUTO_SAVE_DELAY = 1500;

export function schedulePreviewAutoSave(panelInstance, tabId) {
  const tab = panelInstance.state.getTab(tabId);
  if (
    !panelInstance.autoSaveEnabled ||
    !tab?.dirty ||
    tab.conflict ||
    !panelInstance._isEditable(tab)
  ) {
    return;
  }
  clearPreviewAutoSave(panelInstance, tabId);
  const timer = setTimeout(() => {
    panelInstance.autoSaveTimers.delete(tabId);
    void panelInstance._saveTab(tabId, { autoSave: true });
  }, AUTO_SAVE_DELAY);
  panelInstance.autoSaveTimers.set(tabId, timer);
}

export function clearPreviewAutoSave(panelInstance, tabId) {
  const timer = panelInstance.autoSaveTimers.get(tabId);
  clearTimeout(timer);
  panelInstance.autoSaveTimers.delete(tabId);
}

export async function savePreviewTab(panelInstance, tabId, options = {}) {
  const inFlight = panelInstance.savePromises.get(tabId);
  if (inFlight) {
    await inFlight;
    const tab = panelInstance.state.getTab(tabId);
    if (tab?.dirty && !tab.conflict) return panelInstance._saveTab(tabId, options);
    return Boolean(tab && !tab.dirty);
  }

  const operation = panelInstance._performSave(tabId, options);
  panelInstance.savePromises.set(tabId, operation);
  try {
    return await operation;
  } finally {
    if (panelInstance.savePromises.get(tabId) === operation) {
      panelInstance.savePromises.delete(tabId);
    }
  }
}

export async function performPreviewSave(
  panelInstance,
  tabId,
  { autoSave = false, force = false } = {},
) {
  const tab = panelInstance.state.getTab(tabId);
  if (!tab?.dirty) return true;
  if (!panelInstance._isEditable(tab)) return false;

  if (tab.conflict && !force) {
    if (autoSave) return false;
    return panelInstance._resolveSaveConflict(tabId);
  }

  const savedContent = tab.content;
  const expectedMtimeMs = tab.mtimeMs;
  panelInstance.state.updateTab(tabId, { saving: true, saveError: null });

  try {
    const res = panelInstance.fileApi?.writeFileContent
      ? await panelInstance.fileApi.writeFileContent({
          path: tab.filePath,
          content: savedContent,
          expectedMtimeMs,
          force,
        })
      : await fetch("/api/files/content", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: tab.filePath,
            content: savedContent,
            expectedMtimeMs,
            force,
          }),
        });

    if (res.status === 409) {
      panelInstance.state.updateTab(tabId, { saving: false, conflict: true });
      if (autoSave) return false;
      return panelInstance._resolveSaveConflict(tabId);
    }
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      panelInstance.state.updateTab(tabId, {
        saving: false,
        saveError: t("files.preview.saveError"),
        errorDetail: errorData.error || `HTTP ${res.status}`,
      });
      return false;
    }

    const data = await res.json();
    const current = panelInstance.state.getTab(tabId);
    if (!current) return false;
    panelInstance.state.updateTab(tabId, {
      saving: false,
      dirty: current.content !== savedContent,
      conflict: false,
      mtimeMs: data.mtimeMs,
      originalContent: savedContent,
      saveError: null,
      errorDetail: null,
    });
    return true;
  } catch (error) {
    panelInstance.state.updateTab(tabId, {
      saving: false,
      saveError: t("files.preview.saveError"),
      errorDetail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function resolvePreviewSaveConflict(panelInstance, tabId) {
  const tab = panelInstance.state.getTab(tabId);
  if (!tab) return false;
  const action = await panelInstance.resolveConflict(tab);
  if (action === "overwrite") {
    panelInstance.state.updateTab(tabId, { conflict: false });
    return panelInstance._performSave(tabId, { force: true });
  }
  if (action === "reload") {
    return panelInstance._reloadTab(tabId, { skipConfirmation: true });
  }
  return false;
}

export async function reloadPreviewTab(panelInstance, tabId, { skipConfirmation = false } = {}) {
  panelInstance._captureActiveRenderer();
  const tab = panelInstance.state.getTab(tabId);
  if (!tab) return false;
  if (tab.dirty && !skipConfirmation) {
    const settled = await panelInstance._settleDirtyTabs([tab], "reload");
    if (!settled) return false;
  }
  panelInstance._clearAutoSave(tabId);
  panelInstance.state.updateTab(tabId, {
    conflict: false,
    dirty: false,
    saveError: null,
  });
  return panelInstance._loadTabContent(panelInstance.state.getTab(tabId));
}

export async function settlePreviewDirtyTabs(panelInstance, tabs, reason) {
  const action = await panelInstance.confirmDirty(tabs, reason);
  if (action === "cancel" || !action) return false;
  if (action === "save") {
    for (const tab of tabs) {
      const saved = await panelInstance._saveTab(tab.id);
      if (!saved || panelInstance.state.getTab(tab.id)?.dirty) return false;
    }
    return true;
  }
  if (action === "discard") {
    for (const tab of tabs) {
      panelInstance._clearAutoSave(tab.id);
      panelInstance.state.updateTab(tab.id, {
        content: tab.originalContent ?? "",
        dirty: false,
        conflict: false,
        saveError: null,
      });
    }
    return true;
  }
  return false;
}

export function showPreviewDirtyDialog(panelInstance, tabs) {
  const message =
    tabs.length === 1
      ? t("files.unsaved.description")
      : t("files.unsaved.descriptionMultiple", { count: tabs.length });
  return panelInstance._showChoiceDialog({
    title: t("files.unsaved.title"),
    message,
    choices: [
      { action: "save", label: t("files.unsaved.save"), primary: true },
      { action: "discard", label: t("files.unsaved.discard") },
      { action: "cancel", label: t("files.unsaved.cancel") },
    ],
    cancelAction: "cancel",
  });
}

export function showPreviewConflictDialog(panelInstance, tab) {
  return panelInstance._showChoiceDialog({
    title: t("files.preview.conflict"),
    message: t("files.preview.conflictMessage", { name: tab.fileName }),
    choices: [
      { action: "reload", label: t("files.preview.conflictReload") },
      {
        action: "overwrite",
        label: t("files.preview.conflictOverwrite"),
        primary: true,
      },
      { action: "cancel", label: t("files.unsaved.cancel") },
    ],
    cancelAction: "cancel",
  });
}

export function showPreviewChoiceDialog(panelInstance, { title, message, choices, cancelAction }) {
  panelInstance.activeDialogCancel?.();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "file-preview-dialog-overlay";
    const dialog = document.createElement("div");
    dialog.className = "file-preview-dialog";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");

    const heading = document.createElement("h3");
    heading.textContent = title;
    const body = document.createElement("p");
    body.textContent = message;
    const actions = document.createElement("div");
    actions.className = "file-preview-dialog-actions";
    dialog.append(heading, body, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let settled = false;
    let unbindEscape = () => {};
    const finish = (action) => {
      if (settled) return;
      settled = true;
      unbindEscape();
      overlay.remove();
      panelInstance.activeDialogCancel = null;
      resolve(action);
    };
    unbindEscape = bindDialogEscape(() => finish(cancelAction));

    for (const choice of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `file-preview-dialog-button${choice.primary ? " primary" : ""}`;
      button.textContent = choice.label;
      button.addEventListener("click", () => finish(choice.action));
      actions.appendChild(button);
    }

    panelInstance.activeDialogCancel = () => finish(cancelAction);
    actions.querySelector(".primary")?.focus();
  });
}
