import { appEntryPath, parseAppRoute } from "./native/utils/router.js";

// Compatibility bundles are ordinary ES modules with relative chunk imports,
// so native dynamic import works on the Safari 14 baseline without a blob shim.
const RELOAD_GUARD_KEY = "picot:bootstrap-reload-attempted";
const route = parseAppRoute(window.location.pathname);

function showStartupError(entry, error) {
  const main = document.querySelector("main");
  if (!main) return;

  const panel = document.createElement("section");
  panel.className = "startup-error";
  panel.setAttribute("role", "alert");

  const title = document.createElement("h1");
  title.textContent = "Pipline 启动失败";
  const detail = document.createElement("p");
  detail.textContent = `无法加载 ${entry}：${error?.message ?? String(error)}`;
  const retry = document.createElement("button");
  retry.className = "ui-button ui-button--secondary";
  retry.type = "button";
  retry.textContent = "重新加载";
  retry.addEventListener("click", () => location.reload());

  panel.append(title, detail, retry);
  main.replaceChildren(panel);
}

if (route.name === "launcher" || route.name === "settings" || route.name === "not_found") {
  window.location.replace("/app");
} else {
  const entry = appEntryPath(route.name);
  const entryUrl = new URL(entry, document.baseURI).href;
  import(entryUrl)
    .then(async (module) => {
      await module.appReady;
      sessionStorage.removeItem(RELOAD_GUARD_KEY);
    })
    .catch((error) => {
      console.error(`[bootstrap] failed to load ${entry}`, error);
      if (sessionStorage.getItem(RELOAD_GUARD_KEY)) {
        showStartupError(entry, error);
        return;
      }
      sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
      location.reload();
    });
}
