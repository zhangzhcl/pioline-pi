// ABOUTME: Terminal Panel: DOM, tab bar, collapse/expand, height clamp,
// ABOUTME: workspace checkpoint/reattach, and close-risk participant.
// ABOUTME: Rendered for desktop and remote/LAN/mobile clients alike.

import { t } from "./i18n.js";
import {
  applyFullscreenBoundsToRoot,
  clearFullscreenBoundsFromRoot,
  createTerminalPanelDom,
  createTerminalTabButton,
  isTerminalShortcut,
  nextRovingTerminalId,
  showRestartNoticeInBody,
  showStartErrorInBody,
  startFullscreenBoundsTracking,
  startTerminalPointerResize,
  terminalShortcutLabel,
} from "./terminal-panel-dom.js";

const MIN_HEIGHT_PX = 160;
const DEFAULT_HEIGHT_RATIO = 0.4;
const MAX_HEIGHT_RATIO = 0.7;
const FULLSCREEN_SCOPE_CHAT = "chat";

/**
 * TerminalPanel owns the panel DOM, tab bar, collapse/expand behavior, height
 * clamping, and its participation in workspace transition + window close.
 *
 * It depends on a thin `client` facade (create/close/checkpointAll/...)
 * that wraps TerminalClient, plus a locale subscription and an available-height
 * probe. It never holds owner/root/port/capability — those stay host-owned.
 */
export class TerminalPanel {
  constructor({
    native,
    client,
    subscribeLocale,
    getAvailableHeight,
    getFullscreenBounds,
    fullscreenScope = FULLSCREEN_SCOPE_CHAT,
  } = {}) {
    this.native = Boolean(native);
    this.client = client;
    this.getAvailableHeight = getAvailableHeight || (() => 800);
    this.getFullscreenBounds = getFullscreenBounds || null;
    this.fullscreenScope = fullscreenScope;
    this.expanded = false;
    this.heightPx = null;
    /** Ordered tab metadata: { terminalId, generation, label, profileId, status } */
    this.tabs = [];
    this.activeTerminalId = null;
    this.locked = false;
    this.activityByTab = new Set();
    this.tabContainers = new Map();
    this.tabButtons = new Map();
    this._restartNoticeShown = false;
    this._dragRefitTimer = null;
    this._terminalKeydownHandler = null;
    this.enlarged = false;
    this._fullscreenBoundsCleanup = null;
    this.toggleEl = null;
    this.root = null;
    this.tabBarEl = null;
    this.bodyEl = null;
    this.resizeObserver = null;
    this.unsubscribeLocale = null;
    if (subscribeLocale) {
      this.unsubscribeLocale = subscribeLocale(() => this.applyLocale());
    }
  }

  /** Build the toggle + panel DOM. A non-native client renders nothing. */
  mount({ toggleContainer, panelContainer }) {
    if (!this.native || !toggleContainer || !panelContainer) {
      return;
    }
    const dom = createTerminalPanelDom({
      onToggle: () => this.toggle(),
      onBeginResize: (event) => this._beginResize(event),
      onKeyboardResize: (event) => this._keyboardResize(event),
      onRefitAll: () => this.client?.refitAll?.(),
      onCollapse: () => this.collapse(),
      onToggleEnlarge: () => this.toggleEnlarge(),
      onNewTab: () => {
        if (!this.locked) this.client?.create?.("default");
      },
    });
    this.toggleEl = dom.toggleEl;
    this.root = dom.root;
    this.tabBarEl = dom.tabBarEl;
    this.bodyEl = dom.bodyEl;
    this.enlargeButton = dom.enlargeButton;
    this.resizeObserver = dom.resizeObserver;

    this._terminalKeydownHandler = (event) => {
      if (!isTerminalShortcut(event)) return;
      event.preventDefault();
      this.toggle();
    };
    document.addEventListener("keydown", this._terminalKeydownHandler);

    toggleContainer.appendChild(this.toggleEl);
    panelContainer.appendChild(this.root);
    this.applyLocale();
  }

  isExpanded() {
    return this.expanded;
  }

  toggle() {
    if (this.expanded) {
      this.collapse();
    } else {
      void this.expand();
    }
  }

  /** Expand the panel. The first native expansion lazily creates one default tab. */
  async expand() {
    if (!this.native || this.expanded || this.locked) {
      return;
    }
    this.expanded = true;
    this.root.classList.remove("hidden");
    this.toggleEl.setAttribute("aria-pressed", "true");
    this.clearActivity();
    const restored = this.tabs.filter((tab) => tab.status === "restoredMetadata");
    if (restored.length > 0) {
      // Fresh app run with persisted metadata: re-create one shell per saved
      // tab. Live PTYs/checkpoints are never restored (design contract).
      this._showRestartNotice();
      for (const tab of restored) {
        await this.client?.create?.(tab.profileId || "default");
      }
    } else if (this.tabs.length === 0) {
      await this.client?.create?.("default");
    }
    this.layoutHeight();
    // xterm opened into a hidden container renders at zero size; refit every
    // tab now that the panel body is visible.
    this.client?.refitAll?.();
  }

  collapse() {
    this.expanded = false;
    this.enlarged = false;
    this.enlargeButton?.classList.remove("enlarged");
    this.root?.classList.remove("enlarged");
    this.root?.classList.add("hidden");
    this.toggleEl?.setAttribute("aria-pressed", "false");
    this._updateToggleAffordance();
  }

  /** Toggle the panel between its default height and the chat-panel bounds. */
  toggleEnlarge() {
    this.enlarged = !this.enlarged;
    if (this.enlarged) {
      this.root?.classList.add("enlarged");
      this._applyFullscreenBounds();
      this._startFullscreenBoundsTracking();
      if (this.root) this.root.style.height = "";
    } else {
      this.root?.classList.remove("enlarged");
      this._stopFullscreenBoundsTracking();
      this._clearFullscreenBounds();
      this.heightPx = null;
      this.layoutHeight();
    }
    this.enlargeButton?.classList.toggle("enlarged", this.enlarged);
    const labelKey = this.enlarged ? "terminal.restore" : "terminal.enlarge";
    this.enlargeButton?.setAttribute("aria-label", t(labelKey));
    if (this.enlargeButton) {
      this.enlargeButton.title = t(labelKey);
    }
    this.client?.refitAll?.();
  }

  /** Clamp a requested pixel height to [MIN_HEIGHT_PX, 70% of available]. */
  setHeight(px) {
    const available = this.getAvailableHeight() || 800;
    const max = Math.round(available * MAX_HEIGHT_RATIO);
    const clamped = Math.min(max, Math.max(MIN_HEIGHT_PX, Math.round(px)));
    this.heightPx = clamped;
    if (this.root) {
      this.root.style.height = `${clamped}px`;
    }
    this.client?.refitAll?.();
    return clamped;
  }

  // ---- Workspace transition participant ----

  /** Freeze interaction and checkpoint running tabs before a host commit. */
  async beforeWorkspaceTransition() {
    this.locked = true;
    // Checkpoint regardless of expanded state: a collapsed panel still has
    // background PTYs whose screen must be recoverable after the reload.
    try {
      await this.client?.checkpointAll?.();
    } catch (error) {
      this.locked = false;
      throw error;
    }
    return true;
  }

  cancelWorkspaceTransition() {
    this.locked = false;
  }

  // ---- Window close participant ----

  /** Report live terminals for the single close summary dialog. */
  getCloseRisk() {
    const live = this.tabs.filter((tab) => tab.status === "running" || tab.status === "creating");
    return {
      terminalTabs: live.map((tab) => ({
        terminalId: tab.terminalId,
        label: tab.label,
      })),
    };
  }

  /** On approved discard, close every live terminal; on cancel, leave them. */
  async settleCloseRisk(decision) {
    if (decision === "discard") {
      this.locked = true;
      try {
        await this.client?.closeAll?.();
      } catch {
        // Best-effort cleanup; the host remains the final authority.
      }
    } else {
      this.locked = false;
    }
  }

  setInteractionLocked(locked) {
    this.locked = Boolean(locked);
  }

  // ---- Tab metadata (host events update these) ----

  /** Replace tab metadata from a terminal_listed response. */
  setTabs(tabs) {
    this.tabs = Array.isArray(tabs) ? tabs : [];
    if (!this.activeTerminalId || !this.tabs.some((t) => t.terminalId === this.activeTerminalId)) {
      this.activeTerminalId = this.tabs[0]?.terminalId ?? null;
    }
    this._renderTabBar();
    this._updateToggleAffordance();
    const failed = this.tabs.find((tab) => tab.status === "failed" && tab.failReason);
    if (failed) {
      this.showStartError(failed.failReason);
    } else {
      this.clearStartError();
    }
    if (this.tabs.length === 0 && this.expanded) {
      this.collapse();
    }
  }

  /** Surface a host-side start failure inside the open panel. */
  showStartError(message) {
    showStartErrorInBody(this.bodyEl, message);
  }

  clearStartError() {
    this.bodyEl?.querySelector("[data-terminal-start-error]")?.remove();
  }

  /** Record background output for a tab (cleared when the user views the panel). */
  markActivity(terminalId) {
    if (terminalId) this.activityByTab.add(terminalId);
    this._updateToggleAffordance();
  }

  clearActivity(terminalId = null) {
    if (terminalId) {
      this.activityByTab.delete(terminalId);
    } else {
      this.activityByTab.clear();
    }
    this._updateToggleAffordance();
  }

  /** Sidebar projection: live terminal count + whether any has background output. */
  getProjection() {
    return {
      count: this.tabs.length,
      hasActivity: this.activityByTab.size > 0,
    };
  }

  /** Keep the toolbar toggle icon-only; terminal counts stay out of the toolbar. */
  _updateToggleAffordance() {
    if (!this.toggleEl) return;
    this.toggleEl.classList.remove("has-activity");
    delete this.toggleEl.dataset.terminalCount;
  }

  _renderTabBar() {
    if (!this.tabBarEl) return;
    for (const btn of this.tabButtons.values()) btn.remove();
    this.tabButtons.clear();
    const newTabBtn = this.tabBarEl.querySelector("[data-terminal-new-tab]");
    for (const tab of this.tabs) {
      const btn = createTerminalTabButton({
        tab,
        active: tab.terminalId === this.activeTerminalId,
        onKeydown: (event) => this._tabKeydown(event, tab.terminalId),
        onSelect: () => this.setActiveTerminalId(tab.terminalId),
        onClose: () => {
          const live = tab.status === "running" || tab.status === "creating";
          if (live && !window.confirm(`Close ${tab.label || "terminal"}?`)) return;
          this.client?.close?.(tab.terminalId, tab.generation);
        },
      });
      this.tabButtons.set(tab.terminalId, btn);
      if (newTabBtn) {
        this.tabBarEl.insertBefore(btn, newTabBtn);
      } else {
        this.tabBarEl.appendChild(btn);
      }
    }
    this._applyActiveContainer();
  }

  setActiveTerminalId(terminalId) {
    this.activeTerminalId = terminalId;
    this.clearActivity(terminalId);
    if (!this.tabButtons.has(terminalId)) return;
    for (const [id, btn] of this.tabButtons) {
      const active = id === terminalId;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
    this._applyActiveContainer();
    // The newly-shown xterm must refit to its container and take focus so the
    // user's keystrokes reach it.
    this.client?.refitTab?.(terminalId);
    this.client?.focusTab?.(terminalId);
  }

  /** Per-tab xterm container; created lazily inside the panel body. */
  getTabContainer(terminalId) {
    if (!this.bodyEl) return null;
    let el = this.tabContainers.get(terminalId);
    if (!el) {
      el = document.createElement("div");
      el.className = "terminal-tab-container hidden";
      el.dataset.terminalId = terminalId;
      this.bodyEl.appendChild(el);
      this.tabContainers.set(terminalId, el);
    }
    return el;
  }

  _applyActiveContainer() {
    const live = new Set(this.tabs.map((t) => t.terminalId));
    for (const id of [...this.tabContainers.keys()]) {
      if (!live.has(id)) {
        this.tabContainers.get(id)?.remove();
        this.tabContainers.delete(id);
      }
    }
    for (const [id, el] of this.tabContainers) {
      el.classList.toggle("hidden", id !== this.activeTerminalId);
    }
  }

  destroy() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this._stopFullscreenBoundsTracking();
    this.unsubscribeLocale?.();
    this.unsubscribeLocale = null;
    for (const btn of this.tabButtons.values()) btn.remove();
    for (const el of this.tabContainers.values()) el.remove();
    this.tabButtons.clear();
    this.tabContainers.clear();
    this.toggleEl?.remove();
    this.root?.remove();
    this.toggleEl = null;
    this.root = null;
    this.tabBarEl = null;
    this.bodyEl = null;
    if (this._terminalKeydownHandler) {
      document.removeEventListener("keydown", this._terminalKeydownHandler);
      this._terminalKeydownHandler = null;
    }
  }

  layoutHeight() {
    const available = this.getAvailableHeight() || 800;
    this.setHeight(this.heightPx ?? Math.round(available * DEFAULT_HEIGHT_RATIO));
  }

  _showRestartNotice() {
    if (!this.bodyEl || this._restartNoticeShown) return;
    this._restartNoticeShown = true;
    showRestartNoticeInBody(this.bodyEl);
  }

  _applyFullscreenBounds() {
    applyFullscreenBoundsToRoot(this.root, this.fullscreenScope, this.getFullscreenBounds);
  }

  _clearFullscreenBounds() {
    clearFullscreenBoundsFromRoot(this.root);
  }

  _startFullscreenBoundsTracking() {
    if (this._fullscreenBoundsCleanup) return;
    this._fullscreenBoundsCleanup = startFullscreenBoundsTracking(() => {
      if (this.enlarged) {
        this._applyFullscreenBounds();
        this.client?.refitAll?.();
      }
    });
  }

  _stopFullscreenBoundsTracking() {
    this._fullscreenBoundsCleanup?.();
    this._fullscreenBoundsCleanup = null;
  }

  _beginResize(event) {
    if (this.locked) return;
    startTerminalPointerResize({
      event,
      startHeight: this.heightPx || this.root?.clientHeight || 400,
      onResizeHeight: (nextHeight) => this.setHeight(nextHeight),
      onScheduleDragRefit: () => this._scheduleDragRefit(),
      onFinishResize: () => {
        if (this._dragRefitTimer) {
          clearTimeout(this._dragRefitTimer);
          this._dragRefitTimer = null;
        }
        this.client?.refitAll?.();
        this.client?.setPanelHeight?.(this.heightPx);
      },
    });
  }

  _scheduleDragRefit() {
    if (this._dragRefitTimer) return;
    this._dragRefitTimer = setTimeout(() => {
      this._dragRefitTimer = null;
      this.client?.refitAll?.();
    }, 100);
  }

  _keyboardResize(event) {
    if (this.locked) return;
    const step = event.shiftKey ? 80 : 20;
    const current = this.heightPx || 400;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      this.setHeight(current + (event.key === "ArrowUp" ? step : -step));
      event.preventDefault();
    }
  }

  _tabKeydown(event, terminalId) {
    const next = nextRovingTerminalId(this.tabs, terminalId, event.key);
    if (next) {
      this.setActiveTerminalId(next);
      this.tabButtons.get(next)?.focus();
      event.preventDefault();
    }
  }

  applyLocale() {
    // Re-render so i18n-driven titles/labels follow a live locale switch.
    const toggleLabel = t("terminal.toggle");
    const shortcutLabel = terminalShortcutLabel();
    this.toggleEl?.setAttribute("aria-label", toggleLabel);
    this.toggleEl?.setAttribute("title", `${toggleLabel} (${shortcutLabel})`);
    this._renderTabBar();
  }
}
