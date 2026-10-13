// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const matrixOsExpression = ["$", "{{ matrix.os }}"].join("");

function readWorkflow(name) {
  return YAML.parse(fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8"));
}

describe("desktop Cargo target matrix", () => {
  it("uses the same pinned Bun version for development and release builds", () => {
    const desktop = readWorkflow("desktop-build.yml");
    const release = readWorkflow("release.yml");
    const getBunVersion = (workflow) => {
      const buildJob = Object.values(workflow.jobs).find((job) =>
        job.steps?.some((step) => step.uses === "oven-sh/setup-bun@v2"),
      );
      return buildJob.steps.find((step) => step.uses === "oven-sh/setup-bun@v2").with[
        "bun-version"
      ];
    };

    const desktopBun = getBunVersion(desktop);
    const releaseBun = getBunVersion(release);

    expect(releaseBun).toBe(desktopBun);
  });

  it("keeps the development-only workflow worker in its own Cargo package", () => {
    const metadata = spawnSync(
      "cargo",
      [
        "metadata",
        "--no-deps",
        "--format-version",
        "1",
        "--manifest-path",
        path.join(root, "src-tauri", "Cargo.toml"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(metadata.status).toBe(0);
    const packageMetadata = JSON.parse(metadata.stdout).packages.find(
      (entry) => entry.name === "pipline",
    );
    const binaries = packageMetadata.targets.filter((target) => target.kind.includes("bin"));
    const workerMetadata = spawnSync(
      "cargo",
      [
        "metadata",
        "--no-deps",
        "--format-version",
        "1",
        "--manifest-path",
        path.join(root, "src-tauri", "workflow-code-worker", "Cargo.toml"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(workerMetadata.status).toBe(0);
    const workerPackage = JSON.parse(workerMetadata.stdout).packages.find(
      (entry) => entry.name === "pipline-workflow-code-worker",
    );
    const workerBinary = workerPackage.targets.find(
      (target) => target.name === "workflow-code-worker" && target.kind.includes("bin"),
    );

    expect(binaries.map((target) => target.name)).toEqual(["pipline"]);
    expect(workerBinary["required-features"]).toContain("workflow-code-runner-prototype");
    const macPrototypeBuild = fs.readFileSync(
      path.join(root, "scripts", "build-workflow-xpc.js"),
      "utf8",
    );
    expect(macPrototypeBuild).toContain('"src-tauri/workflow-code-worker/Cargo.toml"');
    expect(macPrototypeBuild).toContain('"--bin"');
    expect(macPrototypeBuild).toContain('"src-tauri/target/workflow-code-worker"');
  });

  it("runs the shared Rust check command, including Rust unit tests, in CI quality gates", () => {
    const workflow = readWorkflow("desktop-build.yml");
    const quality = workflow.jobs.quality;
    const commands = quality.steps.map((step) => step.run).filter(Boolean);

    expect(quality["runs-on"]).toBe(matrixOsExpression);
    expect(quality.strategy.matrix.include.map((entry) => entry.os)).toEqual([
      "windows-2022",
      "macos-15",
    ]);
    expect(commands).toContain("bun run check:rust");
  });

  it("smokes the embedded Pi Host RPC on every native desktop installer runner", () => {
    const workflow = readWorkflow("desktop-build.yml");
    const build = workflow.jobs.build;
    const buildInstallerIndex = build.steps.findIndex(
      (step) => step.name === "Build desktop installer",
    );
    const smokeIndex = build.steps.findIndex(
      (step) => step.name === "Smoke test embedded Pi through Host WebSocket",
    );

    expect(build.strategy.matrix.include.map((entry) => entry.os)).toEqual([
      "windows-2022",
      "macos-15",
      "macos-15-intel",
    ]);
    expect(smokeIndex).toBeGreaterThan(buildInstallerIndex);
    expect(build.steps[smokeIndex].run).toBe(
      "cargo test --manifest-path src-tauri/Cargo.toml real_pi_websocket_smoke -- --ignored --nocapture",
    );
    const workflowSmokeIndex = build.steps.findIndex(
      (step) => step.name === "Smoke test Pi workflow proposal and NodeMeta RPC",
    );
    expect(workflowSmokeIndex).toBeGreaterThan(smokeIndex);
    expect(build.steps[workflowSmokeIndex].run).toBe("bun run smoke:pi-workflow-rpc");
  });

  it("runs the embedded Pi and DAG Agent smoke on every native installer runner", () => {
    const workflow = readWorkflow("desktop-build.yml");
    const build = workflow.jobs.build;
    const installerIndex = build.steps.findIndex((step) => step.name === "Build desktop installer");
    const smokeIndex = build.steps.findIndex(
      (step) => step.name === "Smoke test embedded Pi RPC and DAG Agent workflow",
    );

    expect(smokeIndex).toBeGreaterThan(installerIndex);
    expect(build.steps[smokeIndex]).toMatchObject({ run: "bun run smoke:pi-rpc" });
    expect(build.steps[smokeIndex]).not.toHaveProperty("if");
  });

  it("smokes Pi workflow proposal approval through the Host on every native runner", () => {
    const workflow = readWorkflow("desktop-build.yml");
    const build = workflow.jobs.build;
    const hostSmokeIndex = build.steps.findIndex(
      (step) => step.name === "Smoke test embedded Pi through Host WebSocket",
    );
    const workflowHostSmokeIndex = build.steps.findIndex(
      (step) => step.name === "Smoke test Pi workflow proposal through Host WebSocket",
    );

    expect(workflowHostSmokeIndex).toBeGreaterThan(hostSmokeIndex);
    expect(build.steps[workflowHostSmokeIndex].run).toBe(
      "cargo test --manifest-path src-tauri/Cargo.toml real_pi_workflow_proposal_websocket_smoke -- --ignored --nocapture",
    );
  });

  it("checks the built Windows MSI keeps the configured upgrade identity", () => {
    const workflow = readWorkflow("desktop-build.yml");
    const build = workflow.jobs.build;
    const installerIndex = build.steps.findIndex((step) => step.name === "Build desktop installer");
    const checkIndex = build.steps.findIndex((step) => step.name === "Verify MSI upgrade identity");

    expect(checkIndex).toBeGreaterThan(installerIndex);
    expect(build.steps[checkIndex]).toMatchObject({
      if: "runner.os == 'Windows'",
      shell: "pwsh",
    });
    expect(build.steps[checkIndex].run).toContain("./scripts/check-msi-upgrade-code.ps1 -MsiPath");
    const checker = fs.readFileSync(
      path.join(root, "scripts", "check-msi-upgrade-code.ps1"),
      "utf8",
    );
    expect(checker).toContain("Get-MsiProperty -Database $database -PropertyName 'ALLUSERS'");
    expect(checker).toContain("MSI must be per-machine with ALLUSERS=1");
  });

  it("installs and uninstalls the Windows MSI on the privileged clean runner", () => {
    const workflow = readWorkflow("desktop-build.yml");
    const build = workflow.jobs.build;
    const installerIndex = build.steps.findIndex((step) => step.name === "Build desktop installer");
    const smokeIndex = build.steps.findIndex(
      (step) => step.name === "Smoke test Windows MSI install and uninstall",
    );

    expect(smokeIndex).toBeGreaterThan(installerIndex);
    expect(build.steps[smokeIndex]).toMatchObject({
      if: "runner.os == 'Windows'",
      shell: "pwsh",
    });
    expect(build.steps[smokeIndex].run).toContain("./scripts/smoke-msi-install.ps1 -MsiPath");
  });

  it("launches the installed Windows app and verifies its bundled Pi process before uninstall", () => {
    const smoke = fs.readFileSync(path.join(root, "scripts", "smoke-msi-install.ps1"), "utf8");

    expect(smoke).toContain('$piAgentDirectory = Join-Path $env:TEMP "pipline-msi-pi-agent-$PID"');
    expect(smoke).toContain(
      "SetEnvironmentVariable('PI_CODING_AGENT_DIR', $piAgentDirectory, 'Process')",
    );
    expect(smoke).toContain(
      "SetEnvironmentVariable('PI_CODING_AGENT_DIR', $previousPiAgentDirectory, 'Process')",
    );
    expect(smoke).toContain("Remove-Item -LiteralPath $fullPiAgentDirectory -Recurse -Force");
    expect(smoke).toContain("$appProcess = Start-Process -FilePath $appPath");
    expect(smoke).toContain("$expectedPiPath = Join-Path $installLocation 'pi\\pi.exe'");
    expect(smoke).toContain("$_.Path -eq $expectedPiPath");
    expect(smoke).toContain("$script:appProcess.CloseMainWindow()");
  });

  it("verifies staged frontend assets and test exclusion in the installed Windows MSI", () => {
    const smoke = fs.readFileSync(path.join(root, "scripts", "smoke-msi-install.ps1"), "utf8");

    expect(smoke).toContain("$publicDirectory = Join-Path $installLocation 'public'");
    expect(smoke).toContain("compat\\bootstrap-entry.js");
    expect(smoke).toContain("vendor\\workflow-code-compiler-worker.js");
    expect(smoke).toContain("vendor\\esbuild.wasm");
    expect(smoke).toContain("extensions\\picot-bridge.mjs");
    expect(smoke).toContain("MSI installation contains frontend test modules");
  });

  it("checks every installed license file against its staged SHA-256", () => {
    const checker = fs.readFileSync(
      path.join(root, "scripts", "assert-installed-license-payload.ps1"),
      "utf8",
    );
    const msiSmoke = fs.readFileSync(path.join(root, "scripts", "smoke-msi-install.ps1"), "utf8");
    const nsisSmoke = fs.readFileSync(path.join(root, "scripts", "smoke-nsis-install.ps1"), "utf8");

    expect(checker).toContain("Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256");
    expect(checker).toContain("$installedHash -ne $sourceHash");
    expect(msiSmoke).toContain("Assert-PiplineLicensePayload -InstallDirectory $installLocation");
    expect(nsisSmoke).toContain("Assert-PiplineLicensePayload -InstallDirectory $installDirectory");
  });

  it("installs, launches, and uninstalls the Windows NSIS package in an isolated directory", () => {
    const workflow = readWorkflow("desktop-build.yml");
    const build = workflow.jobs.build;
    const msiIndex = build.steps.findIndex(
      (step) => step.name === "Smoke test Windows MSI install and uninstall",
    );
    const nsisIndex = build.steps.findIndex(
      (step) => step.name === "Smoke test Windows NSIS install, launch, and uninstall",
    );

    expect(nsisIndex).toBeGreaterThan(msiIndex);
    expect(build.steps[nsisIndex]).toMatchObject({ if: "runner.os == 'Windows'", shell: "pwsh" });
    expect(build.steps[nsisIndex].run).toContain("bundle/nsis/*.exe");
    expect(build.steps[nsisIndex].run).toContain("scripts/smoke-nsis-install.ps1");
    const smoke = fs.readFileSync(path.join(root, "scripts", "smoke-nsis-install.ps1"), "utf8");
    expect(smoke).toContain("$uninstallerPath = Join-Path $installDirectory 'uninstall.exe'");
    expect(smoke).toContain("$piAgentDirectory = Join-Path $fullTempRoot 'pi-agent'");
    expect(smoke).toContain(
      "SetEnvironmentVariable('PI_CODING_AGENT_DIR', $piAgentDirectory, 'Process')",
    );
    expect(smoke).toContain(
      "SetEnvironmentVariable('PI_CODING_AGENT_DIR', $previousPiAgentDirectory, 'Process')",
    );
    expect(smoke).toContain("Remove-Item -LiteralPath $fullTempRoot -Recurse -Force");
    expect(smoke).toContain("extensions\\picot-bridge.mjs");
    expect(smoke).toContain("$_.Path -eq $expectedPiPath");
    expect(smoke).toContain("function Get-PiplineRegistration");
    expect(smoke).toContain("if ($existingRegistrations.Count -ne 0)");
    expect(smoke).toContain("if ($remainingRegistrations.Count -ne 0)");
    expect(smoke).toContain("$_.PSObject.Properties['DisplayName']");
    expect(smoke).toContain("$registeredLocation");
    expect(smoke).toContain("$installDirectory");
  });

  it("builds macOS DMGs without running deferred native install or launch validation", () => {
    const workflow = readWorkflow("desktop-build.yml");
    const build = workflow.jobs.build;
    const macTargets = build.strategy.matrix.include.filter((entry) =>
      entry.os.startsWith("macos-"),
    );
    const installerStep = build.steps.find((step) => step.name === "Build desktop installer");

    expect(macTargets).toHaveLength(2);
    expect(macTargets.every((entry) => entry.tauri_args.includes("--bundles dmg"))).toBe(true);
    expect(installerStep).toBeDefined();
    expect(build.steps.some((step) => step.run?.includes("smoke-macos-dmg.sh"))).toBe(false);
  });
});
