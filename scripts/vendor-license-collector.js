#!/usr/bin/env node
// ABOUTME: Copies license texts for npm packages actually included in browser bundles.

const fs = require("node:fs");
const path = require("node:path");

const LICENSE_FILE_RE = /^(license|licence|copying|notice)(?:[._-].*)?$/i;
const SHARED_LICENSE_SOURCES = {
  "@xterm/addon-serialize": { packageName: "@xterm/xterm", fileName: "LICENSE" },
};

function packageNameFromInput(input) {
  const normalized = input.replaceAll("\\", "/");
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const parts = normalized.slice(markerIndex + marker.length).split("/");
  if (!parts[0] || parts[0] === ".bin") return null;
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : parts[0];
}

function collectBundlePackages(metafiles, additionalPackages = []) {
  const packages = new Set(additionalPackages);
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile?.inputs ?? {})) {
      const name = packageNameFromInput(input);
      if (name) packages.add(name);
    }
  }
  return [...packages].sort((left, right) => left.localeCompare(right));
}

function copyBundleLicenses({ root, outputDirectory, metafiles, additionalPackages }) {
  const packageNames = collectBundlePackages(metafiles, additionalPackages);
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  const records = [];

  for (const name of packageNames) {
    const packageRoot = path.join(root, "node_modules", ...name.split("/"));
    const manifestPath = path.join(packageRoot, "package.json");
    if (!fs.existsSync(manifestPath)) {
      records.push({ name, version: "unknown", license: "UNKNOWN", files: [] });
      continue;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const entries = fs.readdirSync(packageRoot, { withFileTypes: true });
    let licenseFiles = entries.filter(
      (entry) => entry.isFile() && LICENSE_FILE_RE.test(entry.name),
    );
    let sharedLicenseSource = null;
    if (licenseFiles.length === 0) {
      const fallback = SHARED_LICENSE_SOURCES[name];
      if (fallback) {
        const fallbackPath = path.join(
          root,
          "node_modules",
          ...fallback.packageName.split("/"),
          fallback.fileName,
        );
        if (fs.existsSync(fallbackPath)) {
          licenseFiles = [{ name: "LICENSE.shared-upstream.txt", sourcePath: fallbackPath }];
          sharedLicenseSource = fallback.packageName;
        }
      }
    }
    const versionDirectory = path.join(
      outputDirectory,
      "npm",
      ...name.split("/"),
      manifest.version || "unknown",
    );
    const files = [];

    for (const entry of licenseFiles) {
      fs.mkdirSync(versionDirectory, { recursive: true });
      const destination = path.join(versionDirectory, entry.name);
      fs.copyFileSync(entry.sourcePath || path.join(packageRoot, entry.name), destination);
      files.push(path.relative(outputDirectory, destination).replaceAll("\\", "/"));
    }

    records.push({
      name,
      version: manifest.version || "unknown",
      license: manifest.license || "NOASSERTION",
      files,
      sharedLicenseSource,
      repository: manifest.repository?.url || manifest.repository || null,
    });
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  const lines = [
    "# Browser bundle third-party notices",
    "",
    "These packages were identified from the esbuild input manifests used for the shipped browser bundles.",
    "License files are copied from the matching installed package directories.",
    "",
  ];
  for (const record of records) {
    const licenseFiles = record.files.length
      ? record.files.map((file) => `\`${file}\``).join(", ")
      : "No package license file found";
    const sharedSource = record.sharedLicenseSource
      ? ` (shared upstream license from \`${record.sharedLicenseSource}\`)`
      : "";
    lines.push(
      `- **${record.name}@${record.version}** — ${record.license}; ${licenseFiles}${sharedSource}`,
    );
  }
  fs.writeFileSync(path.join(outputDirectory, "THIRD_PARTY_NOTICES.md"), `${lines.join("\n")}\n`);

  const withoutText = records.filter((record) => record.files.length === 0);
  console.log(
    `[vendor-licenses] recorded ${records.length} bundled npm packages; ${withoutText.length} have no recognized root license text`,
  );
  return records;
}

module.exports = { copyBundleLicenses, collectBundlePackages };
