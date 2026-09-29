import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isMac = process.platform === "darwin";

if (!isMac) {
  console.log("Skipping macOS workflow XPC service build on a non-macOS host.");
  process.exit(0);
}

const configuredTarget = process.env.PIPLINE_CARGO_TARGET || process.env.CARGO_BUILD_TARGET;
const arch = configuredTarget?.startsWith("x86_64-")
  ? "x86_64"
  : configuredTarget?.startsWith("aarch64-")
    ? "arm64"
    : process.arch === "arm64"
      ? "arm64"
      : "x86_64";
const targetTriple = arch === "arm64" ? "arm64-apple-macosx11.0" : "x86_64-apple-macosx11.0";
const cargoTarget = arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
process.env.MACOSX_DEPLOYMENT_TARGET = "11.0";
const destination = resolve(root, "src-tauri/target/workflow-xpc/PiplineWorkflowRunner.xpc");
const workerTargetDirectory = resolve(root, "src-tauri/target/workflow-code-worker");
const contents = resolve(destination, "Contents");
const executable = resolve(contents, "MacOS/PiplineWorkflowRunner");
const worker = resolve(contents, "MacOS/workflow-code-worker");

rmSync(destination, { recursive: true, force: true });
mkdirSync(dirname(executable), { recursive: true });
cpSync(
  resolve(root, "src-tauri/resources/workflow-xpc/Info.plist"),
  resolve(contents, "Info.plist"),
);

const result = spawnSync(
  "swiftc",
  [
    "-target",
    targetTriple,
    "-swift-version",
    "5",
    "-O",
    "-framework",
    "Foundation",
    resolve(root, "src-tauri/resources/workflow-xpc/PiplineWorkflowRunner.swift"),
    "-o",
    executable,
  ],
  { cwd: root, stdio: "inherit" },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const cargo = spawnSync(
  "cargo",
  [
    "build",
    "--manifest-path",
    resolve(root, "src-tauri/workflow-code-worker/Cargo.toml"),
    "--locked",
    "--bin",
    "workflow-code-worker",
    "--features",
    "workflow-code-runner-prototype",
    "--target",
    cargoTarget,
    "--target-dir",
    workerTargetDirectory,
  ],
  { cwd: root, stdio: "inherit" },
);
if (cargo.error) throw cargo.error;
if (cargo.status !== 0) process.exit(cargo.status ?? 1);
cpSync(resolve(workerTargetDirectory, cargoTarget, "debug/workflow-code-worker"), worker);
chmodSync(worker, 0o755);

const signing = spawnSync(
  "codesign",
  [
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--identifier",
    "app.pipline.desktop.workflow-runner.worker",
    "--timestamp=none",
    "--entitlements",
    resolve(root, "src-tauri/resources/workflow-xpc/workflow-runner.entitlements"),
    worker,
  ],
  { cwd: root, stdio: "inherit" },
);
if (signing.error) throw signing.error;
if (signing.status !== 0) process.exit(signing.status ?? 1);

const serviceSigning = spawnSync(
  "codesign",
  [
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--timestamp=none",
    "--entitlements",
    resolve(root, "src-tauri/resources/workflow-xpc/workflow-runner.entitlements"),
    destination,
  ],
  { cwd: root, stdio: "inherit" },
);
if (serviceSigning.error) throw serviceSigning.error;
if (serviceSigning.status !== 0) process.exit(serviceSigning.status ?? 1);
console.log(
  `Built the macOS ${arch} development workflow XPC prototype at ${destination}; it is not included in app bundles.`,
);
