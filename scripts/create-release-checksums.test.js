import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReleaseChecksums } from "./create-release-checksums.cjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pipline-release-checksum-test-"));
}

function addFile(root, relativePath, content) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function writeTauriConfig(root, version = "1.2.3") {
  addFile(root, "src-tauri/tauri.conf.json", JSON.stringify({ productName: "Pipline", version }));
}

describe("release installer checksums", () => {
  it("manifests both Windows installer formats with SHA-256", () => {
    const root = tempRoot();
    try {
      writeTauriConfig(root);
      const msi = addFile(
        root,
        "target/release/bundle/msi/Pipline_1.2.3_x64_en-US.msi",
        "msi bytes",
      );
      const nsis = addFile(
        root,
        "target/release/bundle/nsis/Pipline_1.2.3_x64-setup.exe",
        "nsis bytes",
      );
      const result = createReleaseChecksums({
        root,
        target: "windows-x64",
        cargoTarget: "x86_64-pc-windows-msvc",
      });
      const digest = (file) =>
        crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

      expect(result.files).toEqual([msi, nsis]);
      expect(fs.readFileSync(result.output, "utf8")).toBe(
        `${digest(msi)}  target/release/bundle/msi/Pipline_1.2.3_x64_en-US.msi\n${digest(nsis)}  target/release/bundle/nsis/Pipline_1.2.3_x64-setup.exe\n`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes stale versions and unrelated smoke installers", () => {
    const root = tempRoot();
    try {
      writeTauriConfig(root);
      const currentMsi = addFile(
        root,
        "target/release/bundle/msi/Pipline_1.2.3_x64_en-US.msi",
        "current msi",
      );
      const currentNsis = addFile(
        root,
        "target/release/bundle/nsis/Pipline_1.2.3_x64-setup.exe",
        "current nsis",
      );
      addFile(root, "target/release/bundle/msi/Pipline_1.2.2_x64_en-US.msi", "old msi");
      addFile(
        root,
        "target/release/bundle/nsis/Pipline Upgrade Smoke_1.2.3_x64-setup.exe",
        "smoke installer",
      );

      const result = createReleaseChecksums({
        root,
        target: "windows-x64",
        cargoTarget: "x86_64-pc-windows-msvc",
      });

      expect(result.files).toEqual([currentMsi, currentNsis]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the explicit cross-target directory for the Intel macOS DMG", () => {
    const root = tempRoot();
    try {
      const dmg = addFile(
        root,
        "target/x86_64-apple-darwin/release/bundle/dmg/Pipline_1.2.3_x64.dmg",
        "dmg bytes",
      );
      writeTauriConfig(root);
      const result = createReleaseChecksums({
        root,
        target: "darwin-x64",
        cargoTarget: "x86_64-apple-darwin",
        crossTarget: true,
      });

      expect(result.files).toEqual([dmg]);
      expect(fs.readFileSync(result.output, "utf8")).toContain(
        "target/x86_64-apple-darwin/release/bundle/dmg/Pipline_1.2.3_x64.dmg",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when an expected installer format is missing", () => {
    const root = tempRoot();
    try {
      writeTauriConfig(root);
      addFile(root, "target/release/bundle/msi/Pipline_1.2.3_x64_en-US.msi", "msi bytes");
      expect(() =>
        createReleaseChecksums({
          root,
          target: "windows-x64",
          cargoTarget: "x86_64-pc-windows-msvc",
        }),
      ).toThrow(/exactly one current-version NSIS installer/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
