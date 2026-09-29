import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCargoLicenseOutput } from "./cargo-license-output.cjs";

let temporaryDirectory;

afterEach(() => {
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("prepareCargoLicenseOutput", () => {
  it("clears only the requested target while preserving other target notices", () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pipline-cargo-output-"));
    const root = path.join(temporaryDirectory, "licenses", "cargo");
    const windowsDirectory = path.join(root, "x86_64-pc-windows-msvc");
    const macDirectory = path.join(root, "aarch64-apple-darwin");
    fs.mkdirSync(windowsDirectory, { recursive: true });
    fs.mkdirSync(macDirectory, { recursive: true });
    fs.writeFileSync(path.join(windowsDirectory, "THIRD_PARTY_NOTICES.md"), "Windows notices");
    fs.writeFileSync(path.join(macDirectory, "THIRD_PARTY_NOTICES.md"), "old Mac notices");

    const outputDirectory = prepareCargoLicenseOutput(root, "aarch64-apple-darwin");

    expect(fs.readFileSync(path.join(windowsDirectory, "THIRD_PARTY_NOTICES.md"), "utf8")).toBe(
      "Windows notices",
    );
    expect(fs.readdirSync(outputDirectory)).toEqual([]);
  });
});
