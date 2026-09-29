// ABOUTME: Verifies the pinned upstream Pi npm dependency lock against the shipped runtime.

const crypto = require("node:crypto");

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedJson(value[key])]),
    );
  return value;
}

function verifyPiRuntimeLock({ expectedVersion, expectedSha256, lockText, packageText }) {
  const actualSha256 = crypto.createHash("sha256").update(lockText).digest("hex");
  if (actualSha256 !== String(expectedSha256 ?? "").toLowerCase())
    throw new Error(
      `Pi runtime shrinkwrap SHA-256 mismatch (expected ${expectedSha256}, got ${actualSha256})`,
    );

  const lock = JSON.parse(lockText);
  const bundledPackage = JSON.parse(packageText);
  const rootPackage = lock.packages?.[""];
  if (!rootPackage) throw new Error("Pi runtime shrinkwrap has no root package entry");

  for (const [label, metadata] of [
    ["shrinkwrap", lock],
    ["shrinkwrap root package", rootPackage],
    ["bundled package", bundledPackage],
  ]) {
    if (metadata.version !== expectedVersion)
      throw new Error(
        `${label} version ${metadata.version} does not match locked Pi version ${expectedVersion}`,
      );
  }
  if (rootPackage.name !== bundledPackage.name)
    throw new Error(
      `Pi runtime package name mismatch (${rootPackage.name} vs ${bundledPackage.name})`,
    );

  for (const field of ["dependencies", "optionalDependencies"]) {
    if (
      JSON.stringify(sortedJson(rootPackage[field] ?? {})) !==
      JSON.stringify(sortedJson(bundledPackage[field] ?? {}))
    )
      throw new Error(`Pi runtime ${field} differ between shrinkwrap and bundled package.json`);
  }

  const packages = Object.entries(lock.packages).filter(([packagePath]) => packagePath !== "");
  const missingMetadata = packages.filter(([, metadata]) => !metadata.version || !metadata.license);
  if (missingMetadata.length)
    throw new Error(
      `Pi runtime shrinkwrap has ${missingMetadata.length} package entries without version/license metadata`,
    );

  return {
    packageCount: packages.length,
    licenses: [...new Set(packages.map(([, metadata]) => metadata.license))].sort(),
    sha256: actualSha256,
  };
}

const TARGET_PLATFORMS = {
  "windows-x64": { os: "win32", cpu: "x64" },
  "windows-arm64": { os: "win32", cpu: "arm64" },
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "darwin-x64": { os: "darwin", cpu: "x64" },
  "linux-arm64": { os: "linux", cpu: "arm64" },
  "linux-x64": { os: "linux", cpu: "x64" },
};

function acceptsTarget(allowed, target) {
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  const excluded = allowed.filter((value) => value.startsWith("!")).map((value) => value.slice(1));
  const included = allowed.filter((value) => !value.startsWith("!"));
  return !excluded.includes(target) && (included.length === 0 || included.includes(target));
}

function packageNameFromLockPath(packagePath) {
  return packagePath.split("node_modules/").at(-1);
}

function createTargetRuntimeLock(lockText, targetPlatform) {
  const target = TARGET_PLATFORMS[targetPlatform];
  if (!target) throw new Error(`unsupported Pi runtime SBOM target: ${targetPlatform}`);
  const lock = JSON.parse(lockText);
  if (!lock.packages || typeof lock.packages !== "object")
    throw new Error("Pi runtime shrinkwrap has no packages map");

  const packages = Object.entries(lock.packages);
  const excludedNames = new Set();
  const includedNames = new Set();
  const excludedPaths = new Set();
  for (const [packagePath, metadata] of packages) {
    if (!packagePath) continue;
    const compatible =
      acceptsTarget(metadata.os, target.os) && acceptsTarget(metadata.cpu, target.cpu);
    const packageName = packageNameFromLockPath(packagePath);
    if (compatible) includedNames.add(packageName);
    else {
      excludedNames.add(packageName);
      excludedPaths.add(packagePath);
    }
  }

  for (const packagePath of excludedPaths) delete lock.packages[packagePath];
  for (const metadata of Object.values(lock.packages)) {
    for (const field of ["dependencies", "optionalDependencies"]) {
      if (!metadata[field]) continue;
      for (const dependencyName of Object.keys(metadata[field])) {
        if (excludedNames.has(dependencyName) && !includedNames.has(dependencyName))
          delete metadata[field][dependencyName];
      }
    }
  }
  return `${JSON.stringify(lock, null, 2)}\n`;
}

module.exports = { createTargetRuntimeLock, verifyPiRuntimeLock };
