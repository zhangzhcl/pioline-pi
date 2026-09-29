import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupAppUpdater } from "./app-updater.js";

function renderUpdaterDom() {
  document.body.innerHTML = `
    <span id="setting-update-status"></span>
    <button id="btn-check-updates"></button>
    <button id="sidebar-update-btn" class="hidden">Update</button>
  `;
}

describe("app updater sidebar action", () => {
  beforeEach(() => {
    renderUpdaterDom();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "__TAURI__");
  });

  it("installs the available update directly from the sidebar pill", async () => {
    const downloadAndInstall = vi.fn(async () => undefined);
    const relaunch = vi.fn(async () => undefined);
    const openSettings = vi.fn();

    globalThis.__TAURI__ = {
      core: { invoke: vi.fn(async () => true) },
      process: { relaunch },
      updater: {
        check: vi.fn(async () => ({ version: "9.9.9", downloadAndInstall })),
      },
    };

    setupAppUpdater({ settingsPanel: { openSettings } });

    const sidebarButton = document.getElementById("sidebar-update-btn");
    await vi.waitFor(() => expect(sidebarButton.classList.contains("hidden")).toBe(false));

    sidebarButton.click();

    await vi.waitFor(() => expect(downloadAndInstall).toHaveBeenCalledTimes(1));
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("does not contact the stable updater when this build has no release endpoint", async () => {
    const check = vi.fn(async () => ({ version: "9.9.9" }));
    const invoke = vi.fn(async (command) => command === "stable_updates_available" && false);
    globalThis.__TAURI__ = {
      core: { invoke },
      updater: { check },
    };

    setupAppUpdater();

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("stable_updates_available"));

    expect(check).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(document.getElementById("btn-check-updates").disabled).toBe(true),
    );
    expect(document.getElementById("setting-update-status").textContent).not.toBe("");
  });
});
