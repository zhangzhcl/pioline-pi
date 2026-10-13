// Settings → Extensions → "Installed Packages" management.
//
// Owns the management layer that pi-web exposes but Picot's community browser
// does not: a master-detail view over the installed packages — sidebar list
// grouped by scope, and a detail pane with enable/disable, update, remove,
// status fields, and the resolved extensions/skills/prompts/themes a package
// contributes — plus an agent-reload action and a diagnostics/totals footer.
// Package operations run the embedded `pi` CLI on the Rust host via the
// HostControlGateway (`host_request` frames); `listPiPackages` returns full
// package objects including package-level metadata and a resolved `resources` list.
//
// This is a distinct concern from the community catalog browser
// (package-browse.js), so it lives in its own module per the repo's
// one-concern-per-file rule.

import { t } from "../../i18n.js";
import { getPackageInstallFailure } from "../../packages/install-status.js";
import {
  emptyNote,
  iconButton,
  keyOf,
  message,
  normalizeSource,
  noticeNote,
  RESOURCE_GROUPS,
  renderPackageDetailView,
  resourceSummary,
  scopeLabel,
  sourceOf,
  statusColor,
  statusLabel,
  updateBadge,
} from "./package-manager-views.js";

// Wires the Settings → Extensions installed-package management UI.
// `deps` = { control, data, notify, getWorkspaceId, getSessionId, onRestarted }.
export function setupPackageManager(deps) {
  const { control } = deps;
  const groupsEl = document.getElementById("pkg-manager-groups");
  if (!groupsEl) return { load() {} };

  const sectionEl = document.getElementById("pkg-manager-section");
  const detailEl = document.getElementById("pkg-manager-detail");
  const footerEl = document.getElementById("pkg-manager-footer");
  const bannerEl = document.getElementById("pkg-manager-banner");
  const addBtn = document.getElementById("pkg-manager-add-btn");
  const canManage = Boolean(control);

  let cwd = "";
  let packages = [];
  let selectedKey = null;
  let busyScope = null; // key that identifies which per-package action is in flight
  let restarting = false;
  let lastError = null;
  let lastMessage = null;
  let lastLoaded = false;
  let checkingUpdates = false;
  let updatingAll = false;
  let checkNotice = null;
  let checkInFlight = null;

  async function resolveCwd() {
    try {
      const workspaceId = deps.getWorkspaceId?.();
      if (!workspaceId || !deps.data) return "";
      const info = await deps.data.workspaceInfo(workspaceId);
      return info?.info?.path ?? "";
    } catch {
      return "";
    }
  }

  addBtn?.addEventListener("click", () => {
    const browseSection = document.getElementById("pkg-browse-section");
    if (!browseSection) return;
    if (sectionEl) sectionEl.hidden = true;
    browseSection.hidden = false;
    if (deps.onBrowseRevealed) deps.onBrowseRevealed();
    browseSection.scrollIntoView?.({ behavior: "smooth", block: "start" });
  });

  document.getElementById("pkg-browse-close-btn")?.addEventListener("click", () => {
    const browseSection = document.getElementById("pkg-browse-section");
    if (browseSection) browseSection.hidden = true;
    if (sectionEl) sectionEl.hidden = false;
  });

  async function load(force = false) {
    if (updatingAll) return;
    if (!force && lastLoaded) {
      render();
      return;
    }
    lastLoaded = true;
    if (!canManage) {
      renderEmpty(t("extensions.managementUnavailable"));
      return;
    }
    try {
      await fetchList(null);
    } catch (error) {
      renderError(error);
      return;
    }
    render();
    await checkForUpdates();
  }

  async function fetchList(previousStates) {
    cwd = await resolveCwd();
    const listed = await control.listPiPackages();
    packages = (Array.isArray(listed) ? listed : []).map((pkg, index) => {
      const p = typeof pkg === "string" ? { source: pkg } : pkg;
      const status = p.disabled ? "disabled" : p.installedPath ? "loaded" : "installed";
      const source = sourceOf(p);
      const scope = p.scope === "project" ? "project" : "global";
      const key = `${scope}\0${source}`;
      return {
        source,
        scope,
        installedPath: p.installedPath || null,
        packageName: p.packageName || null,
        version: p.version || null,
        description: p.description || null,
        disabled: Boolean(p.disabled),
        status,
        counts: p.counts || {},
        resources: Array.isArray(p.resources) ? p.resources : [],
        index,
        updateAvailable: previousStates?.get(key) ?? null,
      };
    });
    if (!packages.some((p) => keyOf(p) === selectedKey)) {
      selectedKey = packages[0] ? keyOf(packages[0]) : null;
    }
  }

  function updateCount() {
    return packages.filter((pkg) => pkg.updateAvailable === true).length;
  }

  function checkForUpdates() {
    if (updatingAll) return Promise.resolve();
    if (checkInFlight) return checkInFlight;
    checkInFlight = (async () => {
      checkingUpdates = true;
      checkNotice = null;
      render();
      try {
        const updates = await control.checkPiPackageUpdates(deps.getWorkspaceId?.());
        const availableByKey = new Map(
          (Array.isArray(updates) ? updates : []).map((update) => [
            `${update.scope === "project" ? "project" : "global"}\0${update.source}`,
            update.available === true,
          ]),
        );
        packages = packages.map((pkg) => ({
          ...pkg,
          updateAvailable: availableByKey.get(keyOf(pkg)) ?? false,
        }));
      } catch {
        checkNotice = t("extensions.checkUpdatesFailed");
      } finally {
        checkingUpdates = false;
        render();
        deps.onUpdatesChecked?.(updateCount());
      }
    })();
    return checkInFlight.finally(() => {
      checkInFlight = null;
    });
  }

  function render() {
    sectionEl?.classList.remove("hidden");
    renderGroups();
    renderPackageDetailView({
      detailEl,
      pkg: packages.find((p) => keyOf(p) === selectedKey) || null,
      busyScope,
      canManage,
      updatingAll,
      cwd,
      onToggle: runToggle,
      onUpdate: runUpdate,
      onRemove: runRemove,
    });
    renderFooter();
    renderBanner();
  }

  function renderEmpty(text) {
    groupsEl.replaceChildren(emptyNote(text));
    detailEl?.replaceChildren();
    renderFooter();
    renderBanner();
  }

  function renderError(error) {
    const msg = message(
      error?.message ? `Failed to load installed packages: ${error.message}` : String(error),
      { isError: true },
    );
    groupsEl.replaceChildren(msg);
    detailEl?.replaceChildren();
    renderFooter();
  }

  function renderGroups() {
    groupsEl.innerHTML = "";
    if (!packages.length) {
      groupsEl.appendChild(emptyNote(t("extensions.noInstalled")));
      return;
    }
    for (const scope of ["global", "project"]) {
      const scoped = packages.filter((pkg) => pkg.scope === scope);
      if (!scoped.length) continue;
      const header = document.createElement("div");
      header.className = "pkg-manager-group-header";
      header.textContent = scopeLabel(scope).toUpperCase();
      groupsEl.appendChild(header);
      for (const pkg of scoped) groupsEl.appendChild(renderSidebarRow(pkg));
    }
  }

  function renderSidebarRow(pkg) {
    const key = keyOf(pkg);
    const row = document.createElement("button");
    row.type = "button";
    row.className = `pkg-manager-sidebar-row${key === selectedKey ? " is-selected" : ""}`;
    row.addEventListener("click", () => {
      selectedKey = key;
      render();
    });

    const name = document.createElement("div");
    name.className = "pkg-manager-sidebar-name";
    name.textContent = pkg.packageName || pkg.source;
    row.appendChild(name);

    const meta = document.createElement("div");
    meta.className = "pkg-manager-sidebar-meta";
    const dot = document.createElement("span");
    dot.className = "pkg-manager-status-dot";
    dot.style.background = statusColor(pkg.status);
    dot.title = statusLabel(pkg.status);
    meta.appendChild(dot);
    const metaText = document.createElement("span");
    metaText.textContent = [resourceSummary(pkg), pkg.version ? `v${pkg.version}` : ""]
      .filter(Boolean)
      .join(" · ");
    meta.appendChild(metaText);
    if (pkg.updateAvailable === true) {
      meta.appendChild(updateBadge());
    }
    row.appendChild(meta);

    return row;
  }

  function renderFooter() {
    if (!footerEl) return;
    footerEl.innerHTML = "";
    if (!packages.length) {
      footerEl.appendChild(document.createTextNode(t("extensions.noPackagesSummary")));
      return;
    }
    const totals = { extensions: 0, skills: 0, prompts: 0, themes: 0 };
    for (const pkg of packages) {
      for (const [key] of RESOURCE_GROUPS) {
        totals[key] += pkg.counts?.[key] ?? 0;
      }
    }
    const summary = document.createElement("span");
    summary.className = "pkg-manager-footer-summary";
    summary.textContent = RESOURCE_GROUPS.map(([key, label]) => `${totals[key]} ${label}`).join(
      " · ",
    );
    footerEl.appendChild(summary);

    const reloadBtn = iconButton(t("extensions.reloadAgent"), {
      disabled: busyScope !== null || restarting || !canManage,
      title: t("extensions.reloadAgentTip"),
    });
    reloadBtn.id = "pkg-manager-reload-btn";
    reloadBtn.addEventListener("click", runRestart);
    footerEl.appendChild(reloadBtn);

    const updatable = updateCount();
    const updateAllBtn = iconButton(t("extensions.updateAll", { count: updatable }), {
      disabled: updatingAll || restarting || busyScope !== null || !canManage || updatable === 0,
      title: t("extensions.updateTip"),
    });
    updateAllBtn.id = "pkg-manager-update-all-btn";
    updateAllBtn.addEventListener("click", () => void runUpdateAll());
    footerEl.appendChild(updateAllBtn);

    const refreshBtn = iconButton(t("extensions.refresh"), {
      disabled: updatingAll || restarting,
      title: t("extensions.refreshTip"),
    });
    refreshBtn.addEventListener("click", () => load(true));
    footerEl.appendChild(refreshBtn);
  }

  async function runUpdateAll() {
    if (!canManage || busyScope !== null || restarting || updatingAll) return;
    const targets = packages.filter((pkg) => pkg.updateAvailable === true);
    if (!targets.length) return;
    updatingAll = true;
    let updated = 0;
    let failed = 0;
    for (const [index, pkg] of targets.entries()) {
      checkNotice = t("extensions.updatingAll", { done: index, total: targets.length });
      render();
      try {
        await control.updatePiPackage(pkg.source);
        pkg.updateAvailable = false;
        updated += 1;
      } catch {
        failed += 1;
      }
    }
    updatingAll = false;
    checkNotice = failed
      ? t("extensions.updatedAllWithFailures", { count: updated, failed })
      : null;
    if (!failed) {
      lastMessage = t("extensions.updatedAll", { count: updated });
      lastError = null;
    }
    const previousStates = new Map(packages.map((pkg) => [keyOf(pkg), pkg.updateAvailable]));
    try {
      await fetchList(previousStates);
    } catch {
      // Keep showing the pre-update list; the user can hit Refresh to retry.
    }
    render();
    deps.onUpdatesChecked?.(updateCount());
  }

  async function runRestart() {
    if (!canManage || restarting || busyScope !== null) return;
    const workspaceId = deps.getWorkspaceId?.();
    const sessionId = deps.getSessionId?.();
    if (!workspaceId || !sessionId || !control.restartRuntime) {
      lastError = t("extensions.reloadAgentUnavailable");
      lastMessage = null;
      render();
      return;
    }
    restarting = true;
    lastError = null;
    lastMessage = t("extensions.reloadingAgent");
    render();
    try {
      await control.restartRuntime(workspaceId, sessionId);
      deps.onRestarted?.();
    } catch (error) {
      lastError = summarizeActionError(error);
      lastMessage = null;
    } finally {
      restarting = false;
      render();
    }
  }

  async function runToggle(pkg, key) {
    if (!canManage || busyScope) return;
    busyScope = key;
    render();
    try {
      await control.setPiPackageDisabled(pkg.source, pkg.scope, !pkg.disabled, cwd);
      pkg.disabled = !pkg.disabled;
      pkg.status = pkg.disabled ? "disabled" : pkg.installedPath ? "loaded" : "installed";
      lastMessage = pkg.disabled
        ? t("extensions.packageDisabledMessage", { source: pkg.source })
        : t("extensions.packageEnabledMessage", { source: pkg.source });
      lastError = null;
    } catch (error) {
      lastError = summarizeActionError(error);
      lastMessage = null;
    } finally {
      busyScope = null;
      render();
    }
  }

  async function runUpdate(pkg, key) {
    if (!canManage || busyScope) return;
    busyScope = key;
    render();
    try {
      await control.updatePiPackage(pkg.source);
      await load(true);
      lastMessage = t("extensions.updateMessage", { source: pkg.source });
      lastError = null;
    } catch (error) {
      lastError = summarizeActionError(error);
      lastMessage = null;
    } finally {
      busyScope = null;
      render();
    }
  }

  async function runRemove(pkg, key) {
    if (!canManage || busyScope) return;
    busyScope = key;
    render();
    try {
      await control.removePiPackage(pkg.source, { local: pkg.scope === "project" });
      packages = packages.filter((p) => keyOf(p) !== key);
      if (selectedKey === key) {
        selectedKey = packages[0] ? keyOf(packages[0]) : null;
      }
      lastMessage = t("extensions.removeMessage", { source: pkg.source });
      lastError = null;
    } catch (error) {
      lastError = summarizeActionError(error);
      lastMessage = null;
    } finally {
      busyScope = null;
      render();
    }
  }

  function summarizeActionError(error) {
    const failure = getPackageInstallFailure(error, "install");
    return failure.detail || String(error?.message || error || "unknown error");
  }

  function renderBanner() {
    if (!bannerEl) return;
    bannerEl.replaceChildren();
    if (lastMessage) {
      bannerEl.appendChild(message(lastMessage));
    } else if (lastError) {
      bannerEl.appendChild(message(lastError, { isError: true }));
    }
    if (checkingUpdates) {
      bannerEl.appendChild(noticeNote(t("extensions.checkingUpdates")));
    } else if (checkNotice) {
      bannerEl.appendChild(noticeNote(checkNotice, true));
    }
  }

  return { load };
}

export { normalizeSource };
