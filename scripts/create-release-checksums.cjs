// ABOUTME: Creates a SHA-256 manifest for the installers built by release.yml.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function collectFiles(directory, extension) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => path.join(directory, entry.name));
}

function createReleaseChecksums({ root = ROOT, target, cargoTarget, crossTarget = false }) {
  if (!new Set(["windows-x64", "windows-arm64", "darwin-arm64", "darwin-x64"]).has(target))
    throw new TypeError(`Unsupported release checksum target: ${target}`);
  if (typeof cargoTarget !== "string" || !/^[a-z0-9_]+-[a-z0-9_-]+-[a-z0-9_-]+$/.test(cargoTarget))
    throw new TypeError("A valid Cargo target triple is required");

  const bundleRoot = path.join(
    root,
    "target",
    ...(crossTarget ? [cargoTarget] : []),
    "release",
    "bundle",
  );
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  if (typeof tauriConfig.productName !== "string" || typeof tauriConfig.version !== "string")
    throw new Error("Tauri productName and version are required to select release installers");
  const installerPrefix = `${tauriConfig.productName}_${tauriConfig.version}_`.toLowerCase();
  const currentInstallers = (directory, extension) =>
    collectFiles(directory, extension).filter((file) =>
      path.basename(file).toLowerCase().startsWith(installerPrefix),
    );
  const files = target.startsWith("windows-")
    ? [
        ...currentInstallers(path.join(bundleRoot, "msi"), ".msi"),
        ...currentInstallers(path.join(bundleRoot, "nsis"), ".exe"),
      ]
    : currentInstallers(path.join(bundleRoot, "dmg"), ".dmg");
  if (!files.length) throw new Error(`No ${target} installers found under ${bundleRoot}`);
  if (target.startsWith("windows-")) {
    const msiFiles = files.filter((file) => file.toLowerCase().endsWith(".msi"));
    const nsisFiles = files.filter((file) => file.toLowerCase().endsWith(".exe"));
    if (msiFiles.length !== 1)
      throw new Error(
        `Expected exactly one current-version MSI for ${target}, found ${msiFiles.length}`,
      );
    if (nsisFiles.length !== 1)
      throw new Error(
        `Expected exactly one current-version NSIS installer for ${target}, found ${nsisFiles.length}`,
      );
  } else if (files.length !== 1) {
    throw new Error(
      `Expected exactly one current-version DMG for ${target}, found ${files.length}`,
    );
  }

  const lines = files.sort().map((file) => {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    return `${digest}  ${path.relative(root, file).split(path.sep).join("/")}`;
  });
  const output = path.join(root, `pipline-${target}-SHA256SUMS.txt`);
  fs.writeFileSync(output, `${lines.join("\n")}\n`, "utf8");
  return { output, files, lines };
}

if (require.main === module) {
  const [target, cargoTarget, crossTarget = "false"] = process.argv.slice(2);
  if (!target || !cargoTarget)
    throw new Error(
      "Usage: node scripts/create-release-checksums.cjs <platform> <cargo-target> [cross-target]",
    );
  const { output, files } = createReleaseChecksums({
    target,
    cargoTarget,
    crossTarget: crossTarget === "true",
  });
  console.log(`[release-checksums] ${files.length} installer(s) -> ${output}`);
}

module.exports = { createReleaseChecksums };
