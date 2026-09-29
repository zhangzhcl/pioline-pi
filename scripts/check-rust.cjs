// ABOUTME: Runs Tauri Rust quality checks with native Cargo on every platform.

const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function cargoCommands(manifestPath) {
  return [
    {
      label: "cargo check (all targets)",
      args: ["check", "--manifest-path", manifestPath, "--all-targets"],
    },
    {
      label: "cargo clippy (warnings as errors)",
      args: ["clippy", "--manifest-path", manifestPath, "--all-targets", "--", "-D", "warnings"],
    },
    {
      label: "cargo test (unit)",
      args: ["test", "--manifest-path", manifestPath, "--quiet"],
    },
    {
      label: "cargo fmt --check",
      args: ["fmt", "--check", "--manifest-path", manifestPath],
    },
  ];
}

function cargoEnvironment() {
  const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");
  const cargoBin = path.join(cargoHome, "bin");
  const currentPath = process.env.PATH || "";
  return {
    ...process.env,
    PATH: [cargoBin, currentPath].filter(Boolean).join(path.delimiter),
  };
}

function runRustChecks({
  manifestPath = path.resolve(__dirname, "..", "src-tauri", "Cargo.toml"),
  run = spawnSync,
  log = console.log,
  error = console.error,
} = {}) {
  for (const command of cargoCommands(manifestPath)) {
    log(`==> ${command.label}`);
    const result = run("cargo", command.args, {
      env: cargoEnvironment(),
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) {
      error(`    could not start Cargo: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  log("==> all Rust checks passed");
  return 0;
}

if (require.main === module) process.exitCode = runRustChecks();

module.exports = { cargoCommands, runRustChecks };
