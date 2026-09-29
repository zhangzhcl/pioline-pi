// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const cargoTargetExpression = ["$", "{{ matrix.cargo_target }}"].join("");
const matrixOsExpression = ["$", "{{ matrix.os }}"].join("");
const piPlatformExpression = ["$", "{{ matrix.pi_target_platform }}"].join("");
const desktopPiTargetExpression = ["$", "{{ matrix.pi_target }}"].join("");
const releaseTargetExpression = ["$", "{PIPLINE_RELEASE_TARGET}"].join("");
const githubTokenExpression = ["$", "{{ github.token }}"].join("");
const priorMsiPathExpression = ["$", "{{ steps.prior_msi.outputs.path }}"].join("");

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

  it("keeps release drafts unpublished until the MSI upgrade gate passes", () => {
    const release = readWorkflow("release.yml");
    const steps = release.jobs["build-and-release"].steps;
    expect(release.jobs["build-and-release"].if).toBe("startsWith(github.ref, 'refs/tags/v')");
    const buildReleaseIndexes = steps
      .map((step, index) => (step.uses === "tauri-apps/tauri-action@v0" ? index : -1))
      .filter((index) => index >= 0);
    const draftPriorMsiIndex = steps.findIndex(
      (step) => step.name === "Download prior stable MSI for upgrade smoke",
    );
    const upgradeIndex = steps.findIndex((step) => step.name === "Smoke test Windows MSI upgrade");
    const publisher = release.jobs["publish-release"];

    expect(buildReleaseIndexes).toHaveLength(2);
    for (const index of buildReleaseIndexes) expect(steps[index].with.releaseDraft).toBe(true);
    expect(draftPriorMsiIndex).toBeGreaterThan(
      steps.findIndex(
        (step) => step.if === "runner.os != 'Linux'" && step.uses === "tauri-apps/tauri-action@v0",
      ),
    );
    expect(upgradeIndex).toBeGreaterThan(draftPriorMsiIndex);
    expect(publisher.needs).toBe("build-and-release");
    expect(publisher.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(
      publisher.steps.some((step) =>
        step.run?.includes('gh release edit "$GITHUB_REF_NAME" --draft=false'),
      ),
    ).toBe(true);
    expect(release.jobs["publish-beta-manifest"].needs).toBe("publish-release");
  });

  it("tests Windows MSI upgrade from the latest lower stable release before publishing", () => {
    const release = readWorkflow("release.yml");
    const priorMsiScript = fs.readFileSync(
      path.join(root, "scripts", "download-prior-msi.ps1"),
      "utf8",
    );
    const steps = release.jobs["build-and-release"].steps;
    const draftIndex = steps.findIndex(
      (step) => step.uses === "tauri-apps/tauri-action@v0" && step.if === "runner.os != 'Linux'",
    );
    const priorMsiIndex = steps.findIndex(
      (step) => step.name === "Download prior stable MSI for upgrade smoke",
    );
    const upgradeIndex = steps.findIndex((step) => step.name === "Smoke test Windows MSI upgrade");

    expect(priorMsiIndex).toBeGreaterThan(draftIndex);
    expect(upgradeIndex).toBeGreaterThan(priorMsiIndex);
    expect(steps[priorMsiIndex]).toMatchObject({
      id: "prior_msi",
      if: "runner.os == 'Windows' && matrix.cargo_target == 'x86_64-pc-windows-msvc'",
      env: { GH_TOKEN: githubTokenExpression },
      shell: "pwsh",
    });
    expect(steps[priorMsiIndex].run).toContain("./scripts/download-prior-msi.ps1");
    expect(priorMsiScript).toContain("--exclude-drafts");
    expect(priorMsiScript).toContain("--json tagName,isPrerelease,isDraft");
    expect(priorMsiScript).toContain("$release.isDraft -or $release.isPrerelease");
    expect(steps[upgradeIndex].run).toContain("./scripts/smoke-msi-install.ps1 -MsiPath");
    expect(steps[upgradeIndex].run).toContain("-PreviousMsiPath");
    expect(steps[upgradeIndex].env.PREVIOUS_MSI_PATH).toBe(priorMsiPathExpression);
  });

  it("runs the Pi workflow proposal and NodeMeta smoke before release packaging", () => {
    const workflow = readWorkflow("release.yml");
    const steps = workflow.jobs["build-and-release"].steps;
    const extensionsIndex = steps.findIndex((step) => step.name === "Build pi extensions bundle");
    const smokeIndex = steps.findIndex(
      (step) => step.name === "Smoke test Pi workflow proposal and NodeMeta RPC",
    );
    const packagingIndexes = steps
      .map((step, index) => (step.uses === "tauri-apps/tauri-action@v0" ? index : -1))
      .filter((index) => index >= 0);

    expect(smokeIndex).toBeGreaterThan(extensionsIndex);
    expect(packagingIndexes.length).toBeGreaterThan(0);
    expect(smokeIndex).toBeLessThan(Math.min(...packagingIndexes));
    expect(steps[smokeIndex].run).toBe("bun run smoke:pi-workflow-rpc");
  });

  it("runs the embedded Pi DAG Agent smoke before release packaging", () => {
    const workflow = readWorkflow("release.yml");
    const steps = workflow.jobs["build-and-release"].steps;
    const extensionsIndex = steps.findIndex((step) => step.name === "Build pi extensions bundle");
    const smokeIndex = steps.findIndex(
      (step) => step.name === "Smoke test embedded Pi RPC and DAG Agent workflow",
    );
    const packagingIndexes = steps
      .map((step, index) => (step.uses === "tauri-apps/tauri-action@v0" ? index : -1))
      .filter((index) => index >= 0);

    expect(smokeIndex).toBeGreaterThan(extensionsIndex);
    expect(packagingIndexes.length).toBeGreaterThan(0);
    expect(smokeIndex).toBeLessThan(Math.min(...packagingIndexes));
    expect(steps[smokeIndex].run).toBe("bun run smoke:pi-rpc");
  });

  it("checks the updater signing private key before release dependency installation", () => {
    const workflow = readWorkflow("release.yml");
    const steps = workflow.jobs["build-and-release"].steps;
    const configIndex = steps.findIndex(
      (step) => step.name === "Configure updater for this Pipline repository",
    );
    const bunIndex = steps.findIndex((step) => step.name === "Setup Bun");

    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(configIndex).toBeLessThan(bunIndex);
    expect(steps[configIndex].env.TAURI_SIGNING_PRIVATE_KEY).toBe(
      ["$", "{{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"].join(""),
    );
    expect(steps[configIndex].run).toBe("node scripts/write-tauri-release-config.js");
  });

  it("verifies the updater private key matches its public key before fetching release assets", () => {
    const workflow = readWorkflow("release.yml");
    const steps = workflow.jobs["build-and-release"].steps;
    const dependenciesIndex = steps.findIndex(
      (step) => step.name === "Install frontend dependencies",
    );
    const verifyIndex = steps.findIndex((step) => step.name === "Verify updater signing key pair");
    const fetchPiIndex = steps.findIndex((step) => step.name === "Fetch embedded pi binary");

    expect(verifyIndex).toBeGreaterThan(dependenciesIndex);
    expect(verifyIndex).toBeLessThan(fetchPiIndex);
    expect(steps[verifyIndex].env.TAURI_SIGNING_PRIVATE_KEY).toBe(
      ["$", "{{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"].join(""),
    );
    expect(steps[verifyIndex].env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe(
      ["$", "{{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}"].join(""),
    );
    expect(steps[verifyIndex].env.PIPLINE_UPDATER_PUBLIC_KEY).toBe(
      ["$", "{{ vars.PIPLINE_UPDATER_PUBLIC_KEY }}"].join(""),
    );
    expect(steps[verifyIndex].run).toBe("node scripts/verify-tauri-updater-keypair.js");
  });

  it("sets a target triple for every release artifact and exports it to build hooks", () => {
    const workflow = readWorkflow("release.yml");
    const targets = workflow.jobs["build-and-release"].strategy.matrix.include;
    const warmTargets = readWorkflow("cache-warm.yml").jobs.warm.strategy.matrix.include;

    expect(workflow.jobs["build-and-release"].env.PIPLINE_CARGO_TARGET).toBe(cargoTargetExpression);
    expect(targets.map((entry) => entry.cargo_target)).toEqual([
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-unknown-linux-gnu",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
      "x86_64-pc-windows-msvc",
      "aarch64-pc-windows-msvc",
    ]);
    expect(targets.find((entry) => entry.cargo_target === "aarch64-apple-darwin")?.os).toBe(
      "macos-15",
    );
    expect(warmTargets.find((entry) => entry.os === "macos-15")?.pi_target_platform).toBe(
      "darwin-arm64",
    );
  });

  it("builds macOS Intel artifacts on an Intel runner", () => {
    const releaseTargets =
      readWorkflow("release.yml").jobs["build-and-release"].strategy.matrix.include;
    const intelRelease = releaseTargets.find(
      (entry) => entry.cargo_target === "x86_64-apple-darwin",
    );
    const desktopTargets = readWorkflow("desktop-build.yml").jobs.build.strategy.matrix.include;
    const intelDesktop = desktopTargets.find(
      (entry) => entry.cargo_target === "x86_64-apple-darwin",
    );
    const warmTargets = readWorkflow("cache-warm.yml").jobs.warm.strategy.matrix.include;
    const intelWarm = warmTargets.find((entry) => entry.pi_target_platform === "darwin-x64");

    expect(intelRelease?.os).toBe("macos-15-intel");
    expect(intelDesktop?.os).toBe("macos-15-intel");
    expect(intelWarm?.os).toBe("macos-15-intel");
  });

  it("keeps the macOS 11 deployment floor in both installer workflows", () => {
    const desktop = readWorkflow("desktop-build.yml");
    const release = readWorkflow("release.yml");
    const desktopTargets = desktop.jobs.build.strategy.matrix.include;
    const releaseTargets = release.jobs["build-and-release"].strategy.matrix.include;
    const macTargets = [
      ...desktopTargets.filter((entry) => entry.pi_target.startsWith("darwin-")),
      ...releaseTargets.filter((entry) => entry.pi_target_platform.startsWith("darwin-")),
    ];

    expect(desktop.jobs.build.env.MACOSX_DEPLOYMENT_TARGET).toBe("11.0");
    expect(release.jobs["build-and-release"].env.MACOSX_DEPLOYMENT_TARGET).toBe("11.0");
    expect(macTargets).toHaveLength(4);
    expect(macTargets.map((entry) => entry.pi_target ?? entry.pi_target_platform)).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "darwin-arm64",
      "darwin-x64",
    ]);
  });

  it("assigns each desktop CI bundle the same target used by Cargo license collection", () => {
    const workflow = readWorkflow("desktop-build.yml");
    const targets = workflow.jobs.build.strategy.matrix.include;

    expect(targets.map((entry) => entry.cargo_target)).toEqual([
      "x86_64-pc-windows-msvc",
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
    ]);
    expect(workflow.jobs.build.env.PIPLINE_CARGO_TARGET).toBe(cargoTargetExpression);
  });

  it("attaches platform SBOMs, installer hashes, and license archives to releases", () => {
    const workflow = readWorkflow("release.yml");
    const job = workflow.jobs["build-and-release"];
    const steps = job.steps;

    expect(job.permissions ?? workflow.permissions).toMatchObject({
      actions: "read",
      contents: "write",
    });
    const sbomSteps = steps.filter((step) => step.uses === "anchore/sbom-action@v0");
    expect(sbomSteps).toHaveLength(2);
    for (const [index, step] of sbomSteps.entries()) {
      expect(step.with).toMatchObject({
        "upload-artifact": true,
        "upload-release-assets": true,
      });
      expect(step.with["artifact-name"]).toBe(
        index === 0
          ? `pipline-${piPlatformExpression}-build-sbom.spdx.json`
          : `pipline-pi-runtime-${piPlatformExpression}-sbom.spdx.json`,
      );
    }
    expect(steps.some((step) => step.name === "Generate bundled Node runtime SBOM (macOS)")).toBe(
      true,
    );
    const releaseNodeSbomUpload = steps.find(
      (step) =>
        step.name === "Upload release checksums and license archive" &&
        step.if === "runner.os == 'macOS'",
    );
    expect(releaseNodeSbomUpload?.run).toContain(
      `"pipline-node-runtime-${releaseTargetExpression}-sbom.spdx.json"`,
    );
    const desktop = readWorkflow("desktop-build.yml");
    const desktopNodeSbomUpload = desktop.jobs.build.steps.find(
      (step) => step.name === "Upload macOS installer and dependency SBOM",
    );
    expect(desktopNodeSbomUpload?.with.path).toContain(
      `pipline-node-runtime-${desktopPiTargetExpression}-sbom.spdx.json`,
    );
    expect(steps.some((step) => step.name === "Create release installer SHA-256 manifest")).toBe(
      true,
    );
    expect(steps.some((step) => step.name === "Archive third-party licenses")).toBe(true);
    expect(steps.some((step) => step.name === "Upload release checksums and license archive")).toBe(
      true,
    );
  });
});
