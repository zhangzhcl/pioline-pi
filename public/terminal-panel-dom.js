// ABOUTME: DOM builders, fullscreen bounds helpers, and shortcut predicates for TerminalPanel.

import { t } from "./i18n.js";

const SVG_BASE =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
export const CLOSE_ICON_SVG = `<svg ${SVG_BASE}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
export const EXPAND_ICON_SVG = `<svg ${SVG_BASE}><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;
export const PLUS_ICON_SVG = `<svg ${SVG_BASE}><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;

export function createTerminalPanelDom({
  onToggle,
  onBeginResize,
  onKeyboardResize,
  onRefitAll,
  onCollapse,
  onToggleEnlarge,
  onNewTab,
}) {
  const toggleEl = document.createElement("button");
  toggleEl.type = "button";
  toggleEl.className = "terminal-toggle panel-toggle-btn";
  toggleEl.dataset.terminalToggle = "";
  toggleEl.setAttribute("aria-pressed", "false");
  toggleEl.setAttribute("aria-label", t("terminal.toggle"));
  toggleEl.setAttribute("title", t("terminal.toggle"));
  toggleEl.innerHTML = `
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
        <path d="M7 15h10" />
      </svg>
    `;
  toggleEl.addEventListener("click", onToggle);

  const root = document.createElement("section");
  root.className = "terminal-panel hidden";
  root.dataset.terminalPanel = "";
  root.setAttribute("aria-label", t("terminal.panelLabel"));

  const resizer = document.createElement("div");
  resizer.className = "terminal-resizer";
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", "horizontal");
  resizer.tabIndex = 0;
  resizer.setAttribute("aria-label", t("terminal.ariaResizer"));
  resizer.addEventListener("pointerdown", onBeginResize);
  resizer.addEventListener("keydown", onKeyboardResize);

  const tabBarEl = document.createElement("div");
  tabBarEl.className = "terminal-tab-bar";
  tabBarEl.setAttribute("role", "tablist");

  const bodyEl = document.createElement("div");
  bodyEl.className = "terminal-body";
  let resizeObserver = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(onRefitAll);
    resizeObserver.observe(bodyEl);
  }

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "terminal-collapse";
  closeButton.dataset.terminalCollapse = "";
  closeButton.innerHTML = CLOSE_ICON_SVG;
  closeButton.addEventListener("click", onCollapse);

  const enlargeButton = document.createElement("button");
  enlargeButton.type = "button";
  enlargeButton.className = "terminal-enlarge";
  enlargeButton.dataset.terminalEnlarge = "";
  enlargeButton.title = t("terminal.enlarge");
  enlargeButton.setAttribute("aria-label", t("terminal.enlarge"));
  enlargeButton.innerHTML = EXPAND_ICON_SVG;
  enlargeButton.addEventListener("click", onToggleEnlarge);

  const newTabButton = document.createElement("button");
  newTabButton.type = "button";
  newTabButton.className = "terminal-new-tab";
  newTabButton.dataset.terminalNewTab = "";
  newTabButton.innerHTML = PLUS_ICON_SVG;
  newTabButton.title = t("terminal.newTab");
  newTabButton.addEventListener("click", onNewTab);

  tabBarEl.append(newTabButton, enlargeButton, closeButton);
  root.append(resizer, tabBarEl, bodyEl);

  return { toggleEl, root, tabBarEl, bodyEl, enlargeButton, resizeObserver };
}

export function createTerminalTabButton({ tab, active, onKeydown, onClose, onSelect }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "terminal-tab";
  btn.dataset.terminalId = tab.terminalId;
  btn.setAttribute("role", "tab");
  btn.classList.toggle("active", active);
  btn.setAttribute("aria-selected", active ? "true" : "false");
  btn.tabIndex = active ? 0 : -1;
  btn.addEventListener("keydown", onKeydown);

  const label = document.createElement("span");
  label.className = "terminal-tab-label";
  label.textContent = tab.label || tab.terminalId;
  btn.appendChild(label);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "terminal-tab-close";
  close.innerHTML = CLOSE_ICON_SVG;
  close.setAttribute("aria-label", t("migrated.terminalPanel.ariaLabel.closeTerminalTab"));
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    onClose(event);
  });
  btn.appendChild(close);
  btn.addEventListener("click", onSelect);
  return btn;
}

export function nextRovingTerminalId(tabs, currentTerminalId, key) {
  const ids = tabs.map((tab) => tab.terminalId);
  const idx = ids.indexOf(currentTerminalId);
  if (idx === -1) return null;
  if (key === "ArrowRight") return ids[(idx + 1) % ids.length];
  if (key === "ArrowLeft") return ids[(idx - 1 + ids.length) % ids.length];
  if (key === "Home") return ids[0];
  if (key === "End") return ids[ids.length - 1];
  return null;
}

export function showRestartNoticeInBody(bodyEl) {
  if (!bodyEl) return;
  const notice = document.createElement("div");
  notice.className = "terminal-restart-notice";
  notice.textContent = t("terminal.restartNotice");
  bodyEl.prepend(notice);
  setTimeout(() => notice.remove(), 8000);
}

export function showStartErrorInBody(bodyEl, message) {
  bodyEl?.querySelector("[data-terminal-start-error]")?.remove();
  if (!bodyEl || !message) return;
  const el = document.createElement("div");
  el.className = "terminal-start-error";
  el.dataset.terminalStartError = "";
  el.setAttribute("role", "alert");
  el.textContent = message;
  bodyEl.prepend(el);
}

export function applyFullscreenBoundsToRoot(root, fullscreenScope, getFullscreenBounds) {
  if (!root) return;
  root.dataset.fullscreenScope = fullscreenScope;
  const bounds = getFullscreenBounds?.();
  if (!bounds) {
    clearFullscreenBoundsFromRoot(root);
    return;
  }
  const left = Number.isFinite(bounds.left) ? bounds.left : 0;
  const top = Number.isFinite(bounds.top) ? bounds.top : 0;
  const right = Number.isFinite(bounds.right) ? bounds.right : 0;
  root.style.setProperty("--terminal-fullscreen-left", `${Math.max(0, Math.round(left))}px`);
  root.style.setProperty("--terminal-fullscreen-top", `${Math.max(0, Math.round(top))}px`);
  root.style.setProperty("--terminal-fullscreen-right", `${Math.max(0, Math.round(right))}px`);
}

export function clearFullscreenBoundsFromRoot(root) {
  if (!root) return;
  delete root.dataset.fullscreenScope;
  root.style.removeProperty("--terminal-fullscreen-left");
  root.style.removeProperty("--terminal-fullscreen-top");
  root.style.removeProperty("--terminal-fullscreen-right");
}

export function startFullscreenBoundsTracking(onUpdate) {
  window.addEventListener("resize", onUpdate);
  const cleanups = [() => window.removeEventListener("resize", onUpdate)];

  if (typeof ResizeObserver !== "undefined") {
    const main = document.querySelector(".workspace .main");
    if (main) {
      const observer = new ResizeObserver(onUpdate);
      observer.observe(main);
      cleanups.push(() => observer.disconnect());
    }
  }
  return () => {
    for (const fn of cleanups) {
      fn();
    }
  };
}

function isMacOSPlatform() {
  return navigator.platform.startsWith("Mac") || navigator.userAgent.includes("Macintosh");
}

export function terminalShortcutLabel() {
  return isMacOSPlatform() ? "Ctrl+`" : "Ctrl+`";
}

export function startTerminalPointerResize({
  event,
  startHeight,
  onResizeHeight,
  onScheduleDragRefit,
  onFinishResize,
}) {
  event.preventDefault();
  const startY = event.clientY;
  const move = (e) => {
    onResizeHeight(startHeight + (startY - e.clientY));
    onScheduleDragRefit();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    onFinishResize();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

export function isTerminalShortcut(event) {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.metaKey || event.altKey || event.shiftKey) return false;
  if (event.key !== "`") return false;
  if (!event.ctrlKey) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select")) return false;
  if (target.closest('[contenteditable="true"]') !== null) return false;
  if (target.closest(".terminal-body")) return false;
  return true;
}
