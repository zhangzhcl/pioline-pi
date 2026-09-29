#!/usr/bin/env node
// ABOUTME: Collects license texts for Cargo packages resolved for one desktop target.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveLicenseTextSources } = require("./cargo-license-fallback.cjs");
const { copyMplSourceArchives } = require("./cargo-mpl-sources.cjs");
const { prepareCargoLicenseOutput } = require("./cargo-license-output.cjs");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_ROOT = path.join(ROOT, "licenses", "cargo");
const SPDX_LICENSE_DIR = path.join(ROOT, "licenses", "spdx", "3.29.0");
const LICENSE_FILE_RE = /^(license|licence|copying|notice|copyright)(?:[._-].*)?$/i;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;

function fail(message) {
  console.error(`[cargo-licenses] FAIL: ${message}`);
  process.exit(1);
}

function hostTargetTriple() {
  const result = spawnSync("rustc", ["-vV"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) fail(`could not detect the rustc host target: ${result.stderr}`);
  const target = result.stdout.match(/^host: (.+)$/m)?.[1];
  if (!target) fail("rustc -vV did not report a host target");
  return target;
}

function loadMetadata(target) {
  const result = spawnSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      path.join(ROOT, "src-tauri", "Cargo.toml"),
      "--locked",
      "--format-version",
      "1",
      "--filter-platform",
      target,
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_METADATA_BYTES },
  );
  if (result.status !== 0) fail(`cargo metadata failed for ${target}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function packageLicenseFiles(pkg) {
  const packageRoot = path.dirname(pkg.manifest_path);
  if (pkg.license_file) {
    const declaredFile = path.resolve(packageRoot, pkg.license_file);
    if (fs.existsSync(declaredFile) && fs.statSync(declaredFile).isFile()) return [declaredFile];
  }
  return fs
    .readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_RE.test(entry.name))
    .map((entry) => path.join(packageRoot, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function cachedCrateArchive(pkg) {
  const cargoHome = process.env.CARGO_HOME || path.join(require("node:os").homedir(), ".cargo");
  const cacheRoot = path.join(cargoHome, "registry", "cache");
  if (!fs.existsSync(cacheRoot)) return null;
  const fileName = `${pkg.name}-${pkg.version}.crate`;
  for (const registry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!registry.isDirectory()) continue;
    const candidate = path.join(cacheRoot, registry.name, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeLicenseExpression(license) {
  return String(license || "NOASSERTION")
    .replace(/\s*\/\s*/g, " OR ")
    .split(/\s+OR\s+/i)
    .map((part) => part.trim().toUpperCase())
    .sort()
    .join(" OR ");
}

function findLicenseSources(pkg, packagesByRepository) {
  const localFiles = packageLicenseFiles(pkg);
  if (localFiles.length)
    return resolveLicenseTextSources(pkg.license, localFiles, SPDX_LICENSE_DIR);
  if (!pkg.repository) return resolveLicenseTextSources(pkg.license, [], SPDX_LICENSE_DIR);

  const candidates = packagesByRepository.get(pkg.repository) ?? [];
  for (const candidate of candidates) {
    if (
      candidate.id === pkg.id ||
      normalizeLicenseExpression(candidate.license) !== normalizeLicenseExpression(pkg.license)
    )
      continue;
    const sharedFiles = packageLicenseFiles(candidate);
    if (sharedFiles.length)
      return resolveLicenseTextSources(
        pkg.license,
        sharedFiles,
        SPDX_LICENSE_DIR,
        `${candidate.name}@${candidate.version}`,
      );
  }
  return resolveLicenseTextSources(pkg.license, [], SPDX_LICENSE_DIR);
}

function markdownText(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function main() {
  const target = process.env.PIPLINE_CARGO_TARGET || hostTargetTriple();
  if (!/^[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(?:-[a-z0-9_]+)*$/.test(target))
    fail(`invalid target triple: ${target}`);
  const metadata = loadMetadata(target);
  const resolvedIds = new Set((metadata.resolve?.nodes ?? []).map((node) => node.id));
  const packages = metadata.packages
    .filter((pkg) => pkg.source && resolvedIds.has(pkg.id))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    );
  if (packages.length === 0) fail(`no third-party Cargo packages resolved for ${target}`);
  const packagesByRepository = new Map();
  for (const pkg of packages) {
    if (!pkg.repository) continue;
    const repositoryPackages = packagesByRepository.get(pkg.repository) ?? [];
    repositoryPackages.push(pkg);
    packagesByRepository.set(pkg.repository, repositoryPackages);
  }

  const OUTPUT_DIR = prepareCargoLicenseOutput(OUTPUT_ROOT, target);
  const mplSourceArchives = copyMplSourceArchives({
    packages,
    cargoLockText: fs.readFileSync(path.join(ROOT, "src-tauri", "Cargo.lock"), "utf8"),
    outputDirectory: path.join(OUTPUT_DIR, "mpl-source"),
    resolveArchivePath: cachedCrateArchive,
  });
  const storedTexts = new Map();
  const records = [];

  for (const pkg of packages) {
    const files = [];
    const sources = findLicenseSources(pkg, packagesByRepository);
    const sharedSources = new Set();
    for (const { sourcePath, sharedFrom } of sources) {
      const contents = fs.readFileSync(sourcePath);
      const digest = crypto.createHash("sha256").update(contents).digest("hex");
      if (!storedTexts.has(digest)) {
        const extension = path.extname(sourcePath) || ".txt";
        const relativePath = path.posix.join("texts", `${digest}${extension}`);
        const destination = path.join(OUTPUT_DIR, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, contents);
        storedTexts.set(digest, relativePath);
      }
      files.push(storedTexts.get(digest));
      if (sharedFrom)
        sharedSources.add(
          typeof sharedFrom === "string" ? sharedFrom : `${sharedFrom.name}@${sharedFrom.version}`,
        );
    }
    records.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license || "NOASSERTION",
      files: [...new Set(files)],
      sharedSources: [...sharedSources],
      authors: pkg.authors ?? [],
      repository: pkg.repository || null,
    });
  }

  const lines = [
    "# Cargo third-party notices",
    "",
    `Target: \`${target}\`. Packages come from the locked Cargo dependency graph for this platform.`,
    "License text files are deduplicated by SHA-256 under `texts/`.",
    `MPL-2.0 source archives (${mplSourceArchives.length}) are checksum-verified against Cargo.lock under \`mpl-source/\`; see \`mpl-source/README.md\`.`,
    "",
  ];
  for (const pkg of records) {
    const declaredLicense = markdownText(pkg.license);
    const files = pkg.files.length
      ? pkg.files.map((file) => `\`${file}\``).join(", ")
      : "No license text file found in the crate source";
    const attribution = pkg.authors.length
      ? `; authors: ${pkg.authors.map(markdownText).join(", ")}`
      : "";
    const repository = pkg.repository ? `; source: ${pkg.repository}` : "";
    const shared = pkg.sharedSources.length
      ? `; shared license text from ${pkg.sharedSources.map((name) => `\`${name}\``).join(", ")}`
      : "";
    lines.push(
      `- **${pkg.name}@${pkg.version}** — ${declaredLicense}; ${files}${attribution}${repository}${shared}`,
    );
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, "THIRD_PARTY_NOTICES.md"), `${lines.join("\n")}\n`);

  const missing = records.filter((pkg) => pkg.files.length === 0);
  console.log(
    `[cargo-licenses] ${target}: recorded ${records.length} crates, ${storedTexts.size} unique license texts, ${missing.length} crates without bundled license text`,
  );
  for (const pkg of missing)
    console.warn(`[cargo-licenses] missing text: ${pkg.name}@${pkg.version} (${pkg.license})`);
}

main();
