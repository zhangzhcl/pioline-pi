// ABOUTME: Packages checksum-verified source archives for Cargo crates declaring MPL-2.0.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function lockField(block, field) {
  return block.match(new RegExp(`^${field} = "([^"]+)"$`, "m"))?.[1] ?? null;
}

function registryChecksums(cargoLockText) {
  const checksums = new Map();
  for (const block of cargoLockText.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = lockField(block, "name");
    const version = lockField(block, "version");
    const source = lockField(block, "source");
    const checksum = lockField(block, "checksum");
    if (name && version && source?.startsWith("registry+") && checksum)
      checksums.set(`${name}@${version}`, checksum.toLowerCase());
  }
  return checksums;
}

function declaresMpl20(expression) {
  return /(?:^|[^A-Za-z0-9.-])MPL-2\.0(?:$|[^A-Za-z0-9.-])/i.test(String(expression ?? ""));
}

function copyMplSourceArchives({ packages, cargoLockText, outputDirectory, resolveArchivePath }) {
  const checksums = registryChecksums(cargoLockText);
  const records = packages
    .filter((pkg) => pkg.source?.startsWith("registry+") && declaresMpl20(pkg.license))
    .map((pkg) => {
      const key = `${pkg.name}@${pkg.version}`;
      const checksum = checksums.get(key);
      if (!checksum || !/^[0-9a-f]{64}$/.test(checksum))
        throw new Error(`Cargo.lock has no valid registry checksum for MPL crate ${key}`);
      if (path.basename(pkg.name) !== pkg.name || path.basename(pkg.version) !== pkg.version)
        throw new Error(`unsafe Cargo package name or version for MPL crate ${key}`);
      const sourceArchive = resolveArchivePath(pkg);
      if (!sourceArchive || !fs.existsSync(sourceArchive))
        throw new Error(`cached Cargo source archive is missing for MPL crate ${key}`);
      const actualChecksum = crypto
        .createHash("sha256")
        .update(fs.readFileSync(sourceArchive))
        .digest("hex");
      if (actualChecksum !== checksum)
        throw new Error(`Cargo archive checksum mismatch for MPL crate ${key}`);
      return {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        checksum,
        sourceArchive,
      };
    })
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    );

  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true });
  const lines = [
    "# MPL-2.0 Cargo source archives",
    "",
    "These unmodified crates.io source archives are copied from Cargo's local registry cache and verified against the package checksums in `src-tauri/Cargo.lock`.",
    "",
  ];
  for (const record of records) {
    const fileName = `${record.name}-${record.version}.crate`;
    fs.copyFileSync(record.sourceArchive, path.join(outputDirectory, fileName));
    lines.push(
      `- **${record.name}@${record.version}** — ${record.license}; \`${fileName}\`; SHA-256 \`${record.checksum}\``,
    );
  }
  if (records.length === 0)
    lines.push("No MPL-2.0 registry crates are present in this target dependency graph.");
  fs.writeFileSync(path.join(outputDirectory, "README.md"), `${lines.join("\n")}\n`);
  return records.map(({ name, version, checksum }) => ({ name, version, sha256: checksum }));
}

module.exports = { copyMplSourceArchives };
