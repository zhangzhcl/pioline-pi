// ABOUTME: Generate the Tauri updater config for the repository running a release.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeUpdaterPublicKey } from "./updater-key-policy.js";

const repository = process.env.GITHUB_REPOSITORY;
if (typeof repository !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
  throw new Error("GITHUB_REPOSITORY must be a valid owner/repository slug.");
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appConfig = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"),
);
const configuredPublicKey = appConfig.plugins?.updater?.pubkey;
const expectedPublicKey = process.env.PIPLINE_UPDATER_PUBLIC_KEY;
if (typeof expectedPublicKey !== "string" || expectedPublicKey.length === 0) {
  throw new Error("Set the GitHub Actions variable PIPLINE_UPDATER_PUBLIC_KEY before release.");
}
if (configuredPublicKey !== expectedPublicKey) {
  throw new Error(
    "tauri.conf.json updater pubkey does not match PIPLINE_UPDATER_PUBLIC_KEY; refusing release.",
  );
}
if (
  typeof process.env.TAURI_SIGNING_PRIVATE_KEY !== "string" ||
  !process.env.TAURI_SIGNING_PRIVATE_KEY.trim()
) {
  throw new Error("Set the GitHub Actions secret TAURI_SIGNING_PRIVATE_KEY before release.");
}
decodeUpdaterPublicKey(expectedPublicKey);

const outputPath = path.join(repoRoot, "src-tauri", "tauri.release.conf.json");
const config = {
  bundle: { createUpdaterArtifacts: true },
  plugins: {
    updater: {
      endpoints: [`https://github.com/${repository}/releases/latest/download/latest.json`],
    },
  },
};

fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(`[release-config] updater endpoint configured for ${repository}`);
