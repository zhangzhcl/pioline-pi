import { dialogOwnsEscape } from "../../ui/dialog-escape.js";

function isEditableElement(element) {
  const tag = element?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || element?.isContentEditable;
}

function isVisible(element) {
  return Boolean(element && !element.classList.contains("hidden"));
}

function overlayOwnsEscape() {
  return (
    dialogOwnsEscape() ||
    isVisible(document.getElementById("settings-panel")) ||
    isVisible(document.getElementById("model-dropdown-menu")) ||
    isVisible(document.getElementById("session-search-dialog")) ||
    isVisible(document.getElementById("command-palette")) ||
    isVisible(document.getElementById("dialog-container")) ||
    document.querySelector(".image-lightbox.open") ||
    document.querySelector(".ui-overlay") ||
    document.querySelector(".oauth-login-dialog-backdrop") ||
    document.querySelector(".git-confirm-dialog-overlay") ||
    document.querySelector(".git-commit-dialog-overlay") ||
    document.querySelector(".file-preview-dialog-overlay") ||
    document.querySelector(".sidebar-confirm-overlay") ||
    document.querySelector(".models-json-dialog-backdrop:not(.hidden)")
  );
}

export function isMacOS(nav = globalThis.navigator) {
  const platform = nav?.userAgentData?.platform || nav?.platform || "";
  return /mac/i.test(platform);
}

export function isFilePanelShortcut(event, nav = globalThis.navigator) {
  if (!event || event.altKey || event.shiftKey) return false;
  if (String(event.key || "").toLowerCase() !== "b") return false;
  return isMacOS(nav)
    ? Boolean(event.metaKey && !event.ctrlKey)
    : Boolean(event.ctrlKey && !event.metaKey);
}

export function setupAppKeyboardShortcuts({ input, abort, isWorking }) {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (overlayOwnsEscape()) return;
      if (isWorking()) {
        event.preventDefault();
        abort();
      }
      return;
    }

    if (event.key === "/" && !isEditableElement(document.activeElement)) {
      event.preventDefault();
      input?.focus();
    }
  });
}
