// ABOUTME: Fetches the locked Cargo sources before license notices are collected.

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGET_RE = /^[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(?:-[a-z0-9_]+)*$/;

function detectHostTarget(run) {
  const result = run("rustc", ["-vV"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `could not detect the rustc host target: ${result.error?.message || result.stderr}`,
    );
  const target = result.stdout.match(/^host: (.+)$/m)?.[1];
  if (!target) throw new Error("rustc -vV did not report a host target");
  return target;
}

function fetchCargoDependencies({
  manifestPath = path.join(ROOT, "src-tauri", "Cargo.toml"),
  target = process.env.PIPLINE_CARGO_TARGET,
  run = spawnSync,
  log = console.log,
  error = console.error,
} = {}) {
  let selectedTarget = target;
  try {
    selectedTarget ||= detectHostTarget(run);
  } catch (failure) {
    error(`[cargo-fetch] FAIL: ${failure.message}`);
    return 1;
  }
  if (!TARGET_RE.test(selectedTarget)) {
    error(`[cargo-fetch] FAIL: invalid target triple: ${selectedTarget}`);
    return 1;
  }

  const args = ["fetch", "--manifest-path", manifestPath, "--locked", "--target", selectedTarget];
  log(`[cargo-fetch] fetching locked sources for ${selectedTarget}`);
  const result = run("cargo", args, {
    cwd: ROOT,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    error(`[cargo-fetch] FAIL: could not start Cargo: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) return result.status ?? 1;
  return 0;
}

if (require.main === module) process.exitCode = fetchCargoDependencies();

module.exports = { fetchCargoDependencies };
