#!/usr/bin/env node
// ABOUTME: Checks the vendored Pi runtime lock before packaging and stages its SBOM input.

const fs = require("node:fs");
const path = require("node:path");
const { createTargetRuntimeLock, verifyPiRuntimeLock } = require("./pi-runtime-lock.cjs");
const { collectPiRuntimeLicenses } = require("./pi-runtime-licenses.cjs");

const ROOT = path.resolve(__dirname, "..");
const fail = (message) => {
  console.error(`[pi-runtime-lock] FAIL: ${message}`);
  process.exit(1);
};

async function main() {
  const piVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "pi-version.json"), "utf8"));
  const pin = piVersion.runtimeDependencyLock;
  if (!pin || typeof pin.file !== "string" || typeof pin.sha256 !== "string")
    fail("pi-version.json must pin runtimeDependencyLock.file and runtimeDependencyLock.sha256");

  const lockPath = path.resolve(ROOT, pin.file);
  const relativeLockPath = path.relative(ROOT, lockPath);
  if (relativeLockPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeLockPath))
    fail("runtime dependency lock path must stay inside the repository");

  const lockText = fs.readFileSync(lockPath, "utf8");
  const packagePath = path.join(ROOT, "src-tauri", "resources", "pi", "package.json");
  if (!fs.existsSync(packagePath))
    fail("embedded Pi package.json is missing; run bun run fetch:pi first");
  const packageText = fs.readFileSync(packagePath, "utf8");
  const result = verifyPiRuntimeLock({
    expectedVersion: piVersion.version,
    expectedSha256: pin.sha256,
    lockText,
    packageText,
  });

  const targetPlatform =
    process.env.PI_TARGET_PLATFORM ||
    `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const targetLockText = createTargetRuntimeLock(lockText, targetPlatform);
  const sbomInput = path.join(ROOT, ".cache", "pi-runtime-sbom", targetPlatform);
  fs.mkdirSync(sbomInput, { recursive: true });
  fs.writeFileSync(path.join(sbomInput, "package-lock.json"), targetLockText);
  const licenseResult = await collectPiRuntimeLicenses({
    lockText,
    outputRoot: path.dirname(lockPath),
    cacheDirectory: path.join(ROOT, ".cache", "pi-runtime-license-packages"),
    piLicensePath: path.join(ROOT, "licenses", `Pi-Coding-Agent-${piVersion.version}-MIT.txt`),
  });
  console.log(
    `[pi-runtime-lock] verified Pi ${piVersion.version}: ${result.packageCount} lock entries, ${result.licenses.length} license expressions; staged ${targetPlatform} SBOM input and ${licenseResult.packageCount} package notices (${licenseResult.licenseFileCount} license files)`,
  );
}

main().catch((error) => fail(error.message));
