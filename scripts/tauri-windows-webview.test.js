// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const configPath = path.resolve(import.meta.dirname, "..", "src-tauri", "tauri.conf.json");

describe("Windows WebView2 installation contract", () => {
  it("uses the system runtime and downloads a bootstrapper only when it is missing", () => {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    expect(config.bundle.windows.webviewInstallMode).toEqual({
      silent: true,
      type: "downloadBootstrapper",
    });
  });

  it("keeps the MSI UpgradeCode stable across product-name changes", () => {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    expect(config.bundle.windows.wix.upgradeCode).toBe("e1d8c4b6-07bf-58e2-abf0-ea25956aed42");
  });
});
