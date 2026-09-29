import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import mplSources from "./cargo-mpl-sources.cjs";

const temporaryDirectories = [];

function tempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipline-mpl-sources-"));
  temporaryDirectories.push(directory);
  return directory;
}

function cargoLock(name, version, checksum) {
  return `version = 4\n\n[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${checksum}"\n`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("copyMplSourceArchives", () => {
  it("copies MPL crate archives only after matching the Cargo.lock checksum", () => {
    const temp = tempDirectory();
    const archive = Buffer.from("verified crate archive");
    const checksum = crypto.createHash("sha256").update(archive).digest("hex");
    const sourceArchive = path.join(temp, "option-ext-0.2.0.crate");
    const outputDirectory = path.join(temp, "licenses", "mpl-source");
    fs.writeFileSync(sourceArchive, archive);

    const result = mplSources.copyMplSourceArchives({
      packages: [
        { name: "option-ext", version: "0.2.0", source: "registry+crates.io", license: "MPL-2.0" },
      ],
      cargoLockText: cargoLock("option-ext", "0.2.0", checksum),
      outputDirectory,
      resolveArchivePath: () => sourceArchive,
    });

    expect(result).toEqual([{ name: "option-ext", version: "0.2.0", sha256: checksum }]);
    expect(fs.readFileSync(path.join(outputDirectory, "option-ext-0.2.0.crate"))).toEqual(archive);
    expect(fs.readFileSync(path.join(outputDirectory, "README.md"), "utf8")).toContain(checksum);
  });

  it("rejects a cached archive that differs from the Cargo.lock checksum", () => {
    const temp = tempDirectory();
    const sourceArchive = path.join(temp, "option-ext-0.2.0.crate");
    fs.writeFileSync(sourceArchive, "tampered archive");

    expect(() =>
      mplSources.copyMplSourceArchives({
        packages: [
          {
            name: "option-ext",
            version: "0.2.0",
            source: "registry+crates.io",
            license: "MPL-2.0",
          },
        ],
        cargoLockText: cargoLock("option-ext", "0.2.0", "a".repeat(64)),
        outputDirectory: path.join(temp, "licenses", "mpl-source"),
        resolveArchivePath: () => sourceArchive,
      }),
    ).toThrow(/checksum mismatch/);
  });

  it("does not copy crates that do not declare MPL-2.0", () => {
    const temp = tempDirectory();
    const result = mplSources.copyMplSourceArchives({
      packages: [
        {
          name: "serde",
          version: "1.0.0",
          source: "registry+crates.io",
          license: "MIT OR Apache-2.0",
        },
      ],
      cargoLockText: "version = 4\n",
      outputDirectory: path.join(temp, "licenses", "mpl-source"),
      resolveArchivePath: () => {
        throw new Error("non-MPL package must not resolve an archive");
      },
    });

    expect(result).toEqual([]);
    expect(
      fs.readFileSync(path.join(temp, "licenses", "mpl-source", "README.md"), "utf8"),
    ).toContain("No MPL-2.0");
  });
});
