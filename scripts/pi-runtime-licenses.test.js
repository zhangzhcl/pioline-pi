// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import runtimeLock from "./pi-runtime-lock.cjs";

const root = process.cwd();
const version = JSON.parse(readFileSync(join(root, "scripts/pi-version.json"), "utf8")).version;
const lockText = readFileSync(
  join(root, "licenses/pi-runtime", version, "npm-shrinkwrap.json"),
  "utf8",
);
const targets = ["windows-x64", "darwin-x64", "darwin-arm64"];
const expectedPackages = new Set();

for (const target of targets) {
  const targetLock = JSON.parse(runtimeLock.createTargetRuntimeLock(lockText, target));
  for (const [packagePath, metadata] of Object.entries(targetLock.packages)) {
    if (!packagePath) continue;
    const name = packagePath.split("node_modules/").at(-1);
    expectedPackages.add(`${name}@${metadata.version}`);
  }
}

const noticePath = join(root, "licenses/pi-runtime", version, "third-party-notices.json");

describe("embedded Pi runtime license material", () => {
  it("ships verified license texts for every supported Windows and macOS runtime package", () => {
    expect(existsSync(noticePath)).toBe(true);
    const notice = JSON.parse(readFileSync(noticePath, "utf8"));
    const actualPackages = new Set(
      notice.packages.map((entry) => `${entry.name}@${entry.version}`),
    );

    expect(actualPackages).toEqual(expectedPackages);
    for (const entry of notice.packages) {
      expect(entry.license).toEqual(expect.any(String));
      expect(entry.files.length).toBeGreaterThan(0);
      if (entry.sharedLicenseSource) {
        expect(entry.sharedLicenseSource).toMatch(
          /^(SPDX License List 3\.29\.0: .+|Pi repository-level MIT license)$/,
        );
      }
      for (const file of entry.files) {
        expect(existsSync(join(root, "licenses/pi-runtime", version, file))).toBe(true);
      }
    }
  });
});
