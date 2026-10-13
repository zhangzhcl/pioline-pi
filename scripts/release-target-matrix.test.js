// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const cargoTargetExpression = ["$", "{{ matrix.cargo_target }}"].join("");
const piPlatformExpression = ["$", "{{ matrix.pi_target_platform }}"].join("");
const desktopPiTargetExpression = ["$", "{{ matrix.pi_target }}"].join("");
const releaseTargetExpression = ["$", "{PIPLINE_RELEASE_TARGET}"].join("");
const githubTokenExpression = ["$", "{{ github.token }}"].join("");
const priorMsiPathExpression = ["$", "{{ steps.prior_msi.outputs.path }}"].join("");

function readWorkflow(name) {
  return YAML.parse(fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8"));
}

describe("release workflow target matrix and signing gates", () => {
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
