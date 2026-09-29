import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findSpdxLicenseFiles, resolveLicenseTextSources } from "./cargo-license-fallback.cjs";

let temporaryDirectory;

afterEach(() => {
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("findSpdxLicenseFiles", () => {
  it("resolves every license in Cargo's slash-separated OR expression", () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pipline-spdx-test-"));
    fs.writeFileSync(path.join(temporaryDirectory, "MIT.txt"), "MIT terms");
    fs.writeFileSync(path.join(temporaryDirectory, "Apache-2.0.txt"), "Apache terms");

    expect(findSpdxLicenseFiles("MIT/Apache-2.0", temporaryDirectory)).toEqual([
      path.join(temporaryDirectory, "MIT.txt"),
      path.join(temporaryDirectory, "Apache-2.0.txt"),
    ]);
  });

  it("refuses partial or unknown license expressions", () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pipline-spdx-test-"));
    fs.writeFileSync(path.join(temporaryDirectory, "MIT.txt"), "MIT terms");

    expect(findSpdxLicenseFiles("MIT OR Unlisted-License", temporaryDirectory)).toEqual([]);
    expect(findSpdxLicenseFiles("../../MIT", temporaryDirectory)).toEqual([]);
  });

  it("does not discard a WITH exception from an SPDX expression", () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pipline-spdx-test-"));
    fs.writeFileSync(path.join(temporaryDirectory, "MIT.txt"), "MIT terms");
    fs.writeFileSync(path.join(temporaryDirectory, "Example-exception-1.0.txt"), "exception terms");

    expect(findSpdxLicenseFiles("MIT WITH Example-exception-1.0", temporaryDirectory)).toEqual([]);
  });
});

describe("resolveLicenseTextSources", () => {
  it("supplements local license files with every SPDX term in a conjunctive expression", () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pipline-spdx-test-"));
    const spdxDirectory = path.join(temporaryDirectory, "spdx");
    fs.mkdirSync(spdxDirectory);
    const localLicense = path.join(temporaryDirectory, "LICENSE.MIT");
    const bsdLicense = path.join(spdxDirectory, "BSD-3-Clause.txt");
    const mitLicense = path.join(spdxDirectory, "MIT.txt");
    fs.writeFileSync(localLicense, "Package-specific MIT terms");
    fs.writeFileSync(bsdLicense, "Canonical BSD terms");
    fs.writeFileSync(mitLicense, "Canonical MIT terms");

    expect(
      resolveLicenseTextSources("BSD-3-Clause AND MIT", [localLicense], spdxDirectory),
    ).toEqual([
      { sourcePath: localLicense },
      { sourcePath: bsdLicense, sharedFrom: "SPDX License List v3.29.0" },
      { sourcePath: mitLicense, sharedFrom: "SPDX License List v3.29.0" },
    ]);
  });
});
