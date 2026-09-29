// ABOUTME: Resolves canonical SPDX license texts for Cargo crates that omit them.

const fs = require("node:fs");
const path = require("node:path");

function findSpdxLicenseFiles(expression, licenseDirectory) {
  const normalized = String(expression ?? "").replaceAll("/", " OR ");
  if (/\bWITH\b/i.test(normalized)) return [];
  const identifiers = normalized
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter((identifier) => identifier && !["AND", "OR"].includes(identifier));

  if (identifiers.length === 0) return [];
  if (identifiers.some((identifier) => !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(identifier))) return [];

  const files = identifiers.map((identifier) => path.join(licenseDirectory, `${identifier}.txt`));
  return files.every((file) => fs.existsSync(file)) ? [...new Set(files)] : [];
}

function resolveLicenseTextSources(expression, localFiles, licenseDirectory, localSharedFrom) {
  const localSources = localFiles.map((sourcePath) => ({
    sourcePath,
    ...(localSharedFrom ? { sharedFrom: localSharedFrom } : {}),
  }));
  if (localSources.length > 0 && !/\bAND\b/i.test(String(expression ?? ""))) return localSources;

  const fallbackSources = findSpdxLicenseFiles(expression, licenseDirectory).map((sourcePath) => ({
    sourcePath,
    sharedFrom: "SPDX License List v3.29.0",
  }));
  const seen = new Set(localSources.map((source) => path.resolve(source.sourcePath)));
  return [
    ...localSources,
    ...fallbackSources.filter((source) => {
      const key = path.resolve(source.sourcePath);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

module.exports = { findSpdxLicenseFiles, resolveLicenseTextSources };
