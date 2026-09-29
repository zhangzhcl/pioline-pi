// ABOUTME: Collects package-level license texts for the embedded Pi runtime.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createTargetRuntimeLock } = require("./pi-runtime-lock.cjs");

const LICENSE_FILE_RE = /^(license|licence|copying|notice|copyright)(?:[._-].*)?$/i;
const SUPPORTED_TARGETS = ["windows-x64", "darwin-x64", "darwin-arm64"];
const SHARED_PI_LICENSE_PACKAGES = new Set([
  "@earendil-works/chord",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-tui",
]);
const SPDX_LICENSE_DIRECTORY = path.resolve(__dirname, "..", "licenses", "spdx", "3.29.0");

function packageNameFromLockPath(packagePath) {
  return packagePath.split("node_modules/").at(-1);
}

function collectSupportedPackages(lockText, targetPlatforms = SUPPORTED_TARGETS) {
  const packagesById = new Map();
  for (const target of targetPlatforms) {
    const targetLock = JSON.parse(createTargetRuntimeLock(lockText, target));
    for (const [packagePath, metadata] of Object.entries(targetLock.packages ?? {})) {
      if (!packagePath) continue;
      const name = packageNameFromLockPath(packagePath);
      const record = { name, version: metadata.version, ...metadata };
      const id = `${name}@${metadata.version}`;
      const existing = packagesById.get(id);
      if (
        existing &&
        (existing.resolved !== record.resolved || existing.integrity !== record.integrity)
      ) {
        throw new Error(`Conflicting Pi runtime lock entries for ${id}`);
      }
      packagesById.set(id, record);
    }
  }
  return [...packagesById.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
}

function verifyTarballIntegrity(buffer, integrity, packageId) {
  const tokens = String(integrity ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) throw new Error(`Pi runtime package ${packageId} has no SRI integrity`);

  const supported = tokens.filter((token) => /^(sha1|sha256|sha384|sha512)-/.test(token));
  if (supported.length === 0)
    throw new Error(`Pi runtime package ${packageId} has unsupported SRI integrity`);

  const matches = supported.some((token) => {
    const separator = token.indexOf("-");
    const algorithm = token.slice(0, separator);
    const digest = token.slice(separator + 1).split("?")[0];
    const actual = crypto.createHash(algorithm).update(buffer).digest("base64");
    return actual === digest;
  });
  if (!matches)
    throw new Error(`Pi runtime package ${packageId} tarball failed SRI integrity check`);
}

function isLicenseArchivePath(entry) {
  const normalized = entry.replaceAll("\\", "/");
  if (!normalized.startsWith("package/") || normalized.endsWith("/")) return false;
  const relative = normalized.slice("package/".length);
  if (relative.startsWith("../") || relative.startsWith("/")) return false;
  const segments = relative.split("/");
  if (segments.some((segment) => segment === ".." || segment === "node_modules")) return false;
  if (segments.length === 1) return LICENSE_FILE_RE.test(segments[0]);
  return segments.length === 2 && ["licenses", "license"].includes(segments[0].toLowerCase());
}

function runTar(args, { maxBuffer = 16 * 1024 * 1024 } = {}) {
  const result = spawnSync("tar", args, { encoding: "buffer", maxBuffer, windowsHide: true });
  if (result.error) throw new Error(`Cannot run tar: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(
      `tar ${args[0]} failed: ${result.stderr?.toString("utf8").trim() || result.status}`,
    );
  return result.stdout;
}

function listLicenseArchivePaths(archivePath) {
  const entries = runTar(["-tzf", archivePath], { maxBuffer: 32 * 1024 * 1024 })
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  return entries.filter(isLicenseArchivePath).sort();
}

function extractArchiveFile(archivePath, entry) {
  return runTar(["-xOzf", archivePath, entry]);
}

function safePackagePath(name, version) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))
    throw new Error(`Unsafe Pi runtime npm package name: ${name}`);
  if (!/^[a-z0-9.+_-]+$/i.test(version))
    throw new Error(`Unsafe Pi runtime npm package version: ${version}`);
  return path.join("npm", ...name.split("/"), version);
}

async function downloadTarball(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok)
    throw new Error(`Cannot download Pi runtime npm package ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function getVerifiedTarball({ record, cacheDirectory, fetchImpl }) {
  const packageId = `${record.name}@${record.version}`;
  const cacheKey = crypto
    .createHash("sha256")
    .update(`${record.resolved}\n${record.integrity}`)
    .digest("hex");
  const cachePath = path.join(cacheDirectory, `${cacheKey}.tgz`);
  let buffer;
  if (fs.existsSync(cachePath)) buffer = fs.readFileSync(cachePath);
  else buffer = await downloadTarball(record.resolved, fetchImpl);
  verifyTarballIntegrity(buffer, record.integrity, packageId);
  if (!fs.existsSync(cachePath)) {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const temporary = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, buffer);
    fs.renameSync(temporary, cachePath);
  }
  return cachePath;
}

async function collectPiRuntimeLicenses({
  lockText,
  targetPlatforms = SUPPORTED_TARGETS,
  outputRoot,
  cacheDirectory,
  piLicensePath,
  fetchImpl = globalThis.fetch,
  archiveReader = { list: listLicenseArchivePaths, extract: extractArchiveFile },
  concurrency = 8,
}) {
  if (!fs.existsSync(piLicensePath))
    throw new Error(`Pi root license is missing: ${piLicensePath}`);
  const packages = collectSupportedPackages(lockText, targetPlatforms);
  const outputDirectory = path.join(outputRoot, "third-party");
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true });
  const records = new Array(packages.length);
  let nextIndex = 0;

  async function collectWorker() {
    while (nextIndex < packages.length) {
      const index = nextIndex++;
      const record = packages[index];
      const packageId = `${record.name}@${record.version}`;
      const destinationRoot = path.join(
        outputDirectory,
        safePackagePath(record.name, record.version),
      );
      fs.mkdirSync(destinationRoot, { recursive: true });
      let archivePaths;
      let archivePath;
      let sharedPiLicense = false;
      let spdxFallback = false;

      if (
        !record.integrity &&
        SHARED_PI_LICENSE_PACKAGES.has(record.name) &&
        record.license === "MIT"
      ) {
        archivePaths = ["LICENSE.shared-Pi-Coding-Agent.txt"];
        sharedPiLicense = true;
      } else {
        if (!record.integrity)
          throw new Error(
            `Pi runtime package ${packageId} needs an integrity pin or approved license source`,
          );
        archivePath = await getVerifiedTarball({ record, cacheDirectory, fetchImpl });
        archivePaths = archiveReader.list(archivePath);
        if (archivePaths.length === 0) {
          if (!/^[A-Za-z0-9.-]+$/.test(record.license ?? ""))
            throw new Error(`No package license files found in ${packageId} (${record.license})`);
          const fallbackPath = path.join(SPDX_LICENSE_DIRECTORY, `${record.license}.txt`);
          if (!fs.existsSync(fallbackPath))
            throw new Error(
              `No package license files or pinned SPDX text for ${packageId} (${record.license})`,
            );
          archivePaths = [fallbackPath];
          spdxFallback = true;
        }
      }

      const files = [];
      for (const archiveEntry of archivePaths) {
        const relativeArchivePath = spdxFallback
          ? `SPDX-${path.basename(archiveEntry)}`
          : sharedPiLicense
            ? archiveEntry
            : archiveEntry.slice("package/".length);
        const destination = path.join(destinationRoot, ...relativeArchivePath.split("/"));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const contents = spdxFallback
          ? fs.readFileSync(archiveEntry)
          : sharedPiLicense
            ? fs.readFileSync(piLicensePath)
            : archiveReader.extract(archivePath, archiveEntry);
        if (contents.length === 0)
          throw new Error(`Empty license file ${archiveEntry} in ${packageId}`);
        fs.writeFileSync(destination, contents);
        files.push(path.relative(outputRoot, destination).replaceAll("\\", "/"));
      }

      records[index] = {
        name: record.name,
        version: record.version,
        license: record.license,
        files,
        ...(sharedPiLicense ? { sharedLicenseSource: "Pi repository-level MIT license" } : {}),
        ...(spdxFallback
          ? { sharedLicenseSource: `SPDX License List 3.29.0: ${record.license}` }
          : {}),
      };
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, packages.length)) }, () =>
    collectWorker(),
  );
  await Promise.all(workers);

  const piVersion = JSON.parse(lockText).version;
  const notice = {
    schemaVersion: 1,
    packages: records,
    piVersion,
    targetPlatforms,
  };
  const indexPath = path.join(outputRoot, "third-party-notices.json");
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(indexPath, `${JSON.stringify(notice, null, 2)}\n`);
  fs.writeFileSync(
    path.join(outputRoot, "THIRD_PARTY_NOTICES.md"),
    buildMarkdownNotice(records, targetPlatforms, piVersion),
  );
  return {
    packageCount: records.length,
    licenseFileCount: records.reduce((sum, item) => sum + item.files.length, 0),
    indexPath,
  };
}

function buildMarkdownNotice(records, targetPlatforms, piVersion) {
  const lines = [
    "# Embedded Pi Runtime third-party notices",
    "",
    `Pi version: ${piVersion}`,
    `Supported runtime targets: ${targetPlatforms.join(", ")}`,
    "",
    "Each license text is copied from the exact npm tarball referenced by the locked Pi shrinkwrap and verified against its Subresource Integrity digest. Pi monorepo packages without a tarball digest use the matching repository-level MIT license.",
    "",
  ];
  for (const record of records) {
    const files = record.files.map((file) => `\`${file}\``).join(", ");
    const shared = record.sharedLicenseSource
      ? ` (shared source: ${record.sharedLicenseSource})`
      : "";
    lines.push(`- **${record.name}@${record.version}** — ${record.license}; ${files}${shared}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

module.exports = {
  collectPiRuntimeLicenses,
  collectSupportedPackages,
  isLicenseArchivePath,
  verifyTarballIntegrity,
};
