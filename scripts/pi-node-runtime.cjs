// ABOUTME: Builds the macOS Pi runtime from Pi's official Node package and Node.js release.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { downloadPiAsset } = require("./download-pi-asset.cjs");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "src-tauri", "resources", "pi");
const CACHE_DIR = path.join(ROOT, ".cache", "node-runtime");
const PIN_FILE = path.join(__dirname, "node-runtime-version.json");
const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const RUNTIME_FORMAT_VERSION = 3;

function nodeArchiveForTarget(target) {
  const pin = JSON.parse(fs.readFileSync(PIN_FILE, "utf8"));
  const arch = target === "darwin-arm64" ? "arm64" : target === "darwin-x64" ? "x64" : null;
  if (!arch) throw new Error(`Unsupported Pi Node runtime target: ${target}`);
  const archive = `node-v${pin.version}-darwin-${arch}.tar.gz`;
  const sha256 = pin.sha256?.[archive];
  if (!/^[a-f0-9]{64}$/i.test(sha256 ?? "")) throw new Error(`Missing SHA-256 pin for ${archive}`);
  return { archive, sha256, version: pin.version };
}

function piLauncherScript() {
  return '#!/bin/sh\nSCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$SCRIPT_DIR/node/bin/node" "$SCRIPT_DIR/dist/bundle/cli.js" "$@"\n';
}

function inspectThinMachO(binary, sliceOffset) {
  if (sliceOffset + 32 > binary.length)
    throw new Error("Node runtime has a truncated 64-bit Mach-O slice");
  const littleEndian = binary.readUInt32LE(sliceOffset) === 0xfeedfacf;
  const bigEndian = !littleEndian && binary.readUInt32BE(sliceOffset) === 0xfeedfacf;
  if (!littleEndian && !bigEndian)
    throw new Error("Node runtime contains a non-64-bit Mach-O slice");
  const readUInt32 = littleEndian
    ? (offset) => binary.readUInt32LE(offset)
    : (offset) => binary.readUInt32BE(offset);
  const cpuType = readUInt32(sliceOffset + 4);
  const architecture = cpuType === 0x0100000c ? "arm64" : cpuType === 0x01000007 ? "x64" : null;
  const commandCount = readUInt32(sliceOffset + 16);
  let offset = sliceOffset + 32;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > binary.length)
      throw new Error("Node runtime has a truncated Mach-O command table");
    const command = readUInt32(offset);
    const commandSize = readUInt32(offset + 4);
    if (commandSize < 8 || offset + commandSize > binary.length)
      throw new Error("Node runtime has an invalid Mach-O load command");
    if (command === 0x32) {
      if (commandSize < 24)
        throw new Error("Node runtime has a truncated LC_BUILD_VERSION command");
      const packedVersion = readUInt32(offset + 12);
      return {
        architecture,
        minimumMacOS: `${(packedVersion >>> 16) & 0xffff}.${(packedVersion >>> 8) & 0xff}.${packedVersion & 0xff}`,
      };
    }
    if (command === 0x24) {
      if (commandSize < 16)
        throw new Error("Node runtime has a truncated LC_VERSION_MIN_MACOSX command");
      const packedVersion = readUInt32(offset + 8);
      return {
        architecture,
        minimumMacOS: `${(packedVersion >>> 16) & 0xffff}.${(packedVersion >>> 8) & 0xff}.${packedVersion & 0xff}`,
      };
    }
    offset += commandSize;
  }
  throw new Error("Node runtime does not declare an LC_BUILD_VERSION minimum OS");
}

function inspectMachO(binary, expectedArchitecture) {
  if (!Buffer.isBuffer(binary) || binary.length < 4)
    throw new Error("Node runtime is not a Mach-O executable");
  const fatMagic = binary.readUInt32BE(0);
  const isFat32 = fatMagic === 0xcafebabe || fatMagic === 0xbebafeca;
  const isFat64 = fatMagic === 0xcafebabf || fatMagic === 0xbfbafeca;
  if (!isFat32 && !isFat64) return inspectThinMachO(binary, 0);

  const littleEndian = fatMagic === 0xbebafeca || fatMagic === 0xbfbafeca;
  const readUInt32 = littleEndian
    ? (offset) => binary.readUInt32LE(offset)
    : (offset) => binary.readUInt32BE(offset);
  const count = readUInt32(4);
  const entrySize = isFat64 ? 32 : 20;
  const architectureName = (cpuType) =>
    cpuType === 0x0100000c ? "arm64" : cpuType === 0x01000007 ? "x64" : null;
  const available = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 8 + index * entrySize;
    if (entryOffset + entrySize > binary.length)
      throw new Error("Node runtime has a truncated universal Mach-O header");
    const architecture = architectureName(readUInt32(entryOffset));
    available.push(architecture ?? "unknown");
    if (expectedArchitecture && architecture !== expectedArchitecture) continue;
    const sliceOffset = isFat64
      ? Number(
          littleEndian
            ? binary.readBigUInt64LE(entryOffset + 8)
            : binary.readBigUInt64BE(entryOffset + 8),
        )
      : readUInt32(entryOffset + 8);
    if (!Number.isSafeInteger(sliceOffset) || sliceOffset >= binary.length)
      throw new Error("Node runtime has an invalid universal Mach-O slice offset");
    const metadata = inspectThinMachO(binary, sliceOffset);
    if (!expectedArchitecture || metadata.architecture === expectedArchitecture) return metadata;
  }
  throw new Error(
    `Universal Node runtime does not contain ${expectedArchitecture ?? "a supported"} slice (found ${available.join(", ")})`,
  );
}

function assertNodeRuntimeTarget(binary, expectedArchitecture) {
  const metadata = inspectMachO(binary, expectedArchitecture);
  if (metadata.architecture !== expectedArchitecture)
    throw new Error(
      `Node runtime architecture ${metadata.architecture ?? "unknown"} does not match ${expectedArchitecture}`,
    );
  const [major, minor, patch] = metadata.minimumMacOS.split(".").map(Number);
  if (major > 11 || (major === 11 && (minor > 0 || patch > 0)))
    throw new Error(
      `Node runtime requires macOS ${metadata.minimumMacOS}; Pipline supports macOS 11.0+`,
    );
  return metadata;
}

function validatePiNativeAddons(directory, expectedArchitecture) {
  const nativeAddons = [];
  function visit(currentDirectory) {
    for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".node")) {
        try {
          assertNodeRuntimeTarget(fs.readFileSync(entryPath), expectedArchitecture);
        } catch (error) {
          throw new Error(`${entryPath}: ${error.message}`);
        }
        nativeAddons.push(entryPath);
      }
    }
  }
  if (fs.existsSync(directory)) visit(directory);
  return nativeAddons;
}

function isMachO(binary) {
  if (binary.length < 4) return false;
  const magic = binary.readUInt32BE(0);
  return [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic);
}

function validateMachOBundle(directory, expectedArchitecture) {
  const binaries = [];
  function visit(currentDirectory) {
    for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) {
        const contents = fs.readFileSync(entryPath);
        if (!isMachO(contents)) continue;
        try {
          assertNodeRuntimeTarget(contents, expectedArchitecture);
        } catch (error) {
          throw new Error(`${entryPath}: ${error.message}`);
        }
        binaries.push(entryPath);
      }
    }
  }
  visit(directory);
  if (binaries.length === 0) throw new Error(`No Mach-O binaries found under ${directory}`);
  return binaries;
}

function prunePiNativeAddons(nodeModulesDirectory, architecture) {
  const nativeRoot = path.join(nodeModulesDirectory, "@earendil-works", "pi-tui", "native");
  fs.rmSync(path.join(nativeRoot, "win32"), { recursive: true, force: true });
  const darwinPrebuilds = path.join(nativeRoot, "darwin", "prebuilds");
  if (fs.existsSync(darwinPrebuilds)) {
    for (const entry of fs.readdirSync(darwinPrebuilds, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== `darwin-${architecture}`)
        fs.rmSync(path.join(darwinPrebuilds, entry.name), { recursive: true, force: true });
    }
  }
}

function nodeRuntimeIsUpToDate(target) {
  const nodeAsset = nodeArchiveForTarget(target);
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(OUT_DIR, ".runtime.json"), "utf8"));
    const piPin = JSON.parse(fs.readFileSync(path.join(__dirname, "pi-version.json"), "utf8"));
    return (
      marker.runtime === "node" &&
      marker.runtimeFormatVersion === RUNTIME_FORMAT_VERSION &&
      marker.piVersion === piPin.version &&
      marker.target === target &&
      marker.nodeVersion === nodeAsset.version &&
      marker.nodeArchiveSha256 === nodeAsset.sha256 &&
      marker.piDependencyLockSha256 === piPin.runtimeDependencyLock.sha256 &&
      fs.existsSync(path.join(OUT_DIR, ".version")) &&
      fs.readFileSync(path.join(OUT_DIR, ".version"), "utf8").trim() === piPin.version &&
      fs.existsSync(path.join(OUT_DIR, "node", "bin", "node")) &&
      fs.existsSync(path.join(OUT_DIR, "node", "LICENSE")) &&
      fs.existsSync(path.join(OUT_DIR, "dist", "bundle", "cli.js")) &&
      fs.existsSync(path.join(OUT_DIR, "dist", "modes", "interactive", "theme", "dark.json")) &&
      fs.existsSync(path.join(OUT_DIR, "docs", "rpc.md")) &&
      fs.existsSync(path.join(OUT_DIR, "node_modules", "@mariozechner", "clipboard", "index.js"))
    );
  } catch {
    return false;
  }
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
}

async function fetchPiNodeRuntime(target) {
  const nodeAsset = nodeArchiveForTarget(target);
  const piPin = JSON.parse(fs.readFileSync(path.join(__dirname, "pi-version.json"), "utf8"));
  const packageSource = path.join(ROOT, "node_modules", ...PACKAGE_NAME.split("/"));
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageSource, "package.json"), "utf8"));
  if (packageJson.version !== piPin.version)
    throw new Error(
      `Pi npm package ${packageJson.version} does not match locked version ${piPin.version}`,
    );
  if (!fs.existsSync(path.join(packageSource, "dist", "bundle", "cli.js")))
    throw new Error(`Pi npm package is missing its bundled CLI: ${packageSource}`);

  const lockText = fs.readFileSync(path.join(packageSource, "npm-shrinkwrap.json"), "utf8");
  const lockHash = crypto.createHash("sha256").update(lockText).digest("hex");
  if (lockHash !== piPin.runtimeDependencyLock.sha256)
    throw new Error(`Pi npm shrinkwrap checksum mismatch (${lockHash})`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const archivePath = path.join(CACHE_DIR, nodeAsset.archive);
  if (fs.existsSync(archivePath) && sha256File(archivePath) !== nodeAsset.sha256)
    fs.rmSync(archivePath, { force: true });
  if (!fs.existsSync(archivePath)) {
    await downloadPiAsset(
      `https://nodejs.org/dist/v${nodeAsset.version}/${nodeAsset.archive}`,
      archivePath,
    );
  }
  const actualHash = sha256File(archivePath);
  if (actualHash !== nodeAsset.sha256)
    throw new Error(`Node.js archive SHA-256 mismatch for ${nodeAsset.archive}: ${actualHash}`);

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipline-pi-node-"));
  try {
    const piStage = path.join(stageDir, "pi");
    const nodeStage = path.join(stageDir, "node");
    fs.mkdirSync(piStage, { recursive: true });
    fs.mkdirSync(nodeStage, { recursive: true });
    fs.cpSync(path.join(packageSource, "dist"), path.join(piStage, "dist"), { recursive: true });
    fs.cpSync(path.join(packageSource, "docs"), path.join(piStage, "docs"), { recursive: true });
    fs.copyFileSync(path.join(packageSource, "package.json"), path.join(piStage, "package.json"));
    fs.copyFileSync(
      path.join(packageSource, "npm-shrinkwrap.json"),
      path.join(piStage, "npm-shrinkwrap.json"),
    );

    run("tar", ["-xzf", archivePath, "-C", stageDir], ROOT);
    const nodeRoot = path.join(
      stageDir,
      `node-v${nodeAsset.version}-darwin-${target.endsWith("arm64") ? "arm64" : "x64"}`,
    );
    assertNodeRuntimeTarget(
      fs.readFileSync(path.join(nodeRoot, "bin", "node")),
      target.endsWith("arm64") ? "arm64" : "x64",
    );
    fs.copyFileSync(path.join(nodeRoot, "bin", "node"), path.join(nodeStage, "node"));
    fs.copyFileSync(path.join(nodeRoot, "LICENSE"), path.join(nodeStage, "LICENSE"));
    fs.chmodSync(path.join(nodeStage, "node"), 0o755);
    fs.copyFileSync(
      path.join(nodeRoot, "LICENSE"),
      path.join(ROOT, "licenses", `Node.js-${nodeAsset.version}-LICENSE.txt`),
    );

    run(
      "bun",
      [
        "install",
        "--production",
        "--no-save",
        "--os=darwin",
        `--cpu=${target.endsWith("arm64") ? "arm64" : "x64"}`,
        "--ignore-scripts",
      ],
      piStage,
    );
    prunePiNativeAddons(
      path.join(piStage, "node_modules"),
      target.endsWith("arm64") ? "arm64" : "x64",
    );
    validatePiNativeAddons(
      path.join(piStage, "node_modules"),
      target.endsWith("arm64") ? "arm64" : "x64",
    );

    const runtimeMarker = {
      piVersion: piPin.version,
      runtime: "node",
      runtimeFormatVersion: RUNTIME_FORMAT_VERSION,
      nodeVersion: nodeAsset.version,
      nodeArchiveSha256: nodeAsset.sha256,
      piDependencyLockSha256: piPin.runtimeDependencyLock.sha256,
      target,
    };
    fs.writeFileSync(path.join(piStage, "pi"), piLauncherScript(), { mode: 0o755 });
    fs.mkdirSync(path.join(piStage, "node", "bin"), { recursive: true });
    fs.copyFileSync(path.join(nodeStage, "node"), path.join(piStage, "node", "bin", "node"));
    fs.copyFileSync(path.join(nodeStage, "LICENSE"), path.join(piStage, "node", "LICENSE"));
    fs.writeFileSync(path.join(piStage, ".version"), `${piPin.version}\n`);
    fs.writeFileSync(
      path.join(piStage, ".runtime.json"),
      `${JSON.stringify(runtimeMarker, null, 2)}\n`,
    );

    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.cpSync(piStage, OUT_DIR, { recursive: true });
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
  console.log(
    `[fetch-pi] staged Pi ${piPin.version} on Node.js ${nodeAsset.version} for ${target}`,
  );
}

module.exports = {
  fetchPiNodeRuntime,
  assertNodeRuntimeTarget,
  inspectMachO,
  validateMachOBundle,
  nodeArchiveForTarget,
  nodeRuntimeIsUpToDate,
  piLauncherScript,
  prunePiNativeAddons,
  validatePiNativeAddons,
};
