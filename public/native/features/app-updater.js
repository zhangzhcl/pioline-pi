import { onLocaleChange, t } from "../../i18n.js";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BETA_SETTINGS_KEY = "picot-settings-beta-updates";

function betaUpdatesEnabled() {
  return localStorage.getItem(BETA_SETTINGS_KEY) === "true";
}

export function setupAppUpdater({ logger = console } = {}) {
  const relaunch = globalThis.__TAURI__?.process?.relaunch;
  const check = globalThis.__TAURI__?.updater?.check;
  const invoke = globalThis.__TAURI__?.core?.invoke;
  const statusEl = document.getElementById("setting-update-status");
  const checkBtn = document.getElementById("btn-check-updates");
  const sidebarBtn = document.getElementById("sidebar-update-btn");
  if (!statusEl || !checkBtn || typeof check !== "function") return null;

  let update = null;
  let lastCheckMs = 0;
  let checking = false;
  let installing = false;
  let totalBytes = 0;
  let downloadedBytes = 0;
  let silentTimer = null;
  let stableUpdatesAvailable = null;

  function checkCurrentChannel() {
    if (!betaUpdatesEnabled()) return check();
    if (typeof invoke !== "function") throw new Error("Tauri core API is unavailable");
    return invoke("check_beta_update");
  }

  function installCurrentChannel() {
    if (!betaUpdatesEnabled()) return update?.downloadAndInstall?.();
    if (typeof invoke !== "function") throw new Error("Tauri core API is unavailable");
    return invoke("install_beta_update");
  }

  const LOADING_SVG =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';

  function setSidebarVisible(visible) {
    sidebarBtn?.classList.toggle("hidden", !visible);
  }

  let view = { kind: "idle" };

  function applyView() {
    switch (view.kind) {
      case "checking":
        setState({
          status: t("updater.checking"),
          button: t("updater.checking"),
          disabled: true,
        });
        break;
      case "available": {
        const version = view.version ? `v${view.version}` : t("updater.update");
        setState({
          status: t("updater.versionAvailable", { version }),
          button: t("updater.downloadInstall"),
          canInstall: true,
        });
        setSidebarVisible(true);
        break;
      }
      case "upToDate":
        setState({ status: t("updater.upToDate"), button: t("updater.checkNow") });
        setSidebarVisible(false);
        break;
      case "devBuild":
        setState({
          status: t("updater.devBuild"),
          button: t("updater.checkNow"),
          disabled: true,
        });
        setSidebarVisible(false);
        break;
      case "checkFailed":
        setState({ status: t("updater.checkFailed"), button: t("updater.checkNow") });
        break;
      case "preparing":
        setState({
          status: t("updater.preparingDownload"),
          button: t("updater.installing"),
          disabled: true,
        });
        break;
      case "downloading":
        setState({
          status: formatProgress(),
          button: t("updater.installing"),
          disabled: true,
        });
        break;
      case "installing":
        setState({
          status: t("updater.installing"),
          button: t("updater.installing"),
          disabled: true,
        });
        break;
      case "relaunching":
        setState({
          status: t("updater.installedRelaunching"),
          button: t("updater.relaunching"),
          disabled: true,
        });
        break;
      case "installFailed":
        setState({
          status: t("updater.installFailed"),
          button: t("updater.tryAgain"),
          canInstall: true,
        });
        break;
      default:
        setState({ status: t("updater.clickToCheck"), button: t("updater.checkNow") });
        setSidebarVisible(false);
    }
  }

  function setSidebarLoading(loading) {
    if (!sidebarBtn) return;
    if (loading) {
      sidebarBtn.classList.remove("hidden");
      sidebarBtn.classList.add("loading");
      sidebarBtn.disabled = true;
      sidebarBtn.innerHTML = LOADING_SVG;
      sidebarBtn.append(document.createTextNode(t("updater.update")));
    } else {
      sidebarBtn.classList.remove("loading");
      sidebarBtn.disabled = false;
      sidebarBtn.textContent = t("updater.update");
    }
  }

  function setState({ status, button, disabled = false, canInstall = false }) {
    statusEl.textContent = status;
    checkBtn.textContent = button;
    checkBtn.disabled = disabled;
    checkBtn.dataset.mode = canInstall ? "install" : "check";
    checkBtn.setAttribute("aria-busy", disabled ? "true" : "false");
  }

  function showIdle() {
    view = { kind: "idle" };
    applyView();
  }

  function showAvailable(nextUpdate) {
    view = { kind: "available", version: nextUpdate?.version };
    applyView();
  }

  async function checkNow({ silent = false } = {}) {
    if (checking || installing) return update;
    checking = true;
    lastCheckMs = Date.now();
    if (!silent) {
      view = { kind: "checking" };
      applyView();
    }

    try {
      if (!betaUpdatesEnabled()) {
        if (stableUpdatesAvailable === null) {
          if (typeof invoke !== "function") {
            stableUpdatesAvailable = false;
          } else {
            try {
              stableUpdatesAvailable = Boolean(await invoke("stable_updates_available"));
            } catch (error) {
              logger.warn?.("[Updater] Could not determine stable updater availability:", error);
              stableUpdatesAvailable = false;
            }
          }
        }
        if (!stableUpdatesAvailable) {
          update = null;
          view = { kind: "devBuild" };
          applyView();
          return null;
        }
      }

      const result = await checkCurrentChannel();
      update = result
        ? betaUpdatesEnabled()
          ? { ...result, downloadAndInstall: installCurrentChannel }
          : result
        : null;
      if (update) showAvailable(update);
      else {
        view = { kind: "upToDate" };
        applyView();
      }
      return update;
    } catch (error) {
      if (!silent) {
        view = { kind: "checkFailed" };
        applyView();
      }
      logger.warn?.("[Updater] Check failed:", error);
      return null;
    } finally {
      checking = false;
    }
  }

  function formatProgress() {
    if (!totalBytes) return t("updater.downloading");
    const pct = Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100));
    return t("updater.downloadingPct", { pct });
  }

  async function installUpdate() {
    if (installing) return;
    if (!update) {
      await checkNow();
      if (!update) return;
    }

    installing = true;
    totalBytes = 0;
    downloadedBytes = 0;
    setSidebarLoading(true);
    view = { kind: "preparing" };
    applyView();

    try {
      if (betaUpdatesEnabled()) {
        await installCurrentChannel();
      } else {
        await update.downloadAndInstall((event) => {
          if (event?.event === "Started") {
            totalBytes = event.data?.contentLength || 0;
            downloadedBytes = 0;
            view = { kind: "downloading" };
            applyView();
          } else if (event?.event === "Progress") {
            downloadedBytes += event.data?.chunkLength || 0;
            view = { kind: "downloading" };
            applyView();
          } else if (event?.event === "Finished") {
            view = { kind: "installing" };
            applyView();
          }
        });
      }
      view = { kind: "relaunching" };
      applyView();
      if (typeof relaunch !== "function") {
        throw new Error("Tauri process plugin is unavailable");
      }
      await relaunch();
    } catch (error) {
      logger.warn?.("[Updater] Install failed:", error);
      view = { kind: "installFailed" };
      applyView();
      setSidebarLoading(false);
      setSidebarVisible(true);
    } finally {
      installing = false;
    }
  }

  function scheduleSilentChecks() {
    if (silentTimer) clearInterval(silentTimer);
    silentTimer = setInterval(() => {
      if (Date.now() - lastCheckMs >= CHECK_INTERVAL_MS) void checkNow({ silent: true });
    }, CHECK_INTERVAL_MS);
  }

  checkBtn.addEventListener("click", () => {
    if (update) void installUpdate();
    else void checkNow();
  });

  sidebarBtn?.addEventListener("click", () => {
    void installUpdate();
  });

  window.addEventListener("picot-update-channel-changed", () => {
    update = null;
    showIdle();
    void checkNow({ silent: true });
  });

  showIdle();
  onLocaleChange(() => {
    applyView();
    if (sidebarBtn && !sidebarBtn.classList.contains("hidden")) {
      if (sidebarBtn.classList.contains("loading")) setSidebarLoading(true);
      else sidebarBtn.textContent = t("updater.update");
    }
  });
  void checkNow({ silent: true });
  scheduleSilentChecks();

  return { checkNow, installUpdate };
}
