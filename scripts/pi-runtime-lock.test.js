import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import piRuntimeLock from "./pi-runtime-lock.cjs";

function fixture() {
  const root = {
    name: "@earendil-works/pi-coding-agent",
    version: "0.85.1",
    dependencies: { "@earendil-works/pi-ai": "^0.85.1", yaml: "2.9.0" },
    optionalDependencies: { "@mariozechner/clipboard": "0.3.9" },
  };
  const lockText = JSON.stringify({
    name: root.name,
    version: root.version,
    lockfileVersion: 3,
    packages: {
      "": root,
      "node_modules/@earendil-works/pi-ai": { version: "0.85.1", license: "MIT" },
      "node_modules/yaml": { version: "2.9.0", license: "ISC" },
    },
  });
  return {
    expectedVersion: "0.85.1",
    expectedSha256: crypto.createHash("sha256").update(lockText).digest("hex"),
    lockText,
    packageText: JSON.stringify(root),
  };
}

describe("verifyPiRuntimeLock", () => {
  it("accepts a pinned shrinkwrap that matches the bundled Pi manifest", () => {
    expect(piRuntimeLock.verifyPiRuntimeLock(fixture()).packageCount).toBe(2);
  });

  it("rejects an unexpected shrinkwrap checksum", () => {
    expect(() =>
      piRuntimeLock.verifyPiRuntimeLock({ ...fixture(), expectedSha256: "0".repeat(64) }),
    ).toThrow(/SHA-256 mismatch/);
  });

  it("rejects a lockfile from a different Pi version", () => {
    expect(() =>
      piRuntimeLock.verifyPiRuntimeLock({ ...fixture(), expectedVersion: "0.85.2" }),
    ).toThrow(/version/);
  });

  it("rejects direct or optional dependencies that differ from the bundled package", () => {
    const data = fixture();
    const packageManifest = JSON.parse(data.packageText);
    packageManifest.dependencies.yaml = "2.8.0";

    expect(() =>
      piRuntimeLock.verifyPiRuntimeLock({ ...data, packageText: JSON.stringify(packageManifest) }),
    ).toThrow(/dependencies/);
  });
});

describe("createTargetRuntimeLock", () => {
  it("keeps the selected optional native packages and removes other platforms", () => {
    const source = {
      lockfileVersion: 3,
      packages: {
        "": { name: "pi", version: "0.85.1", optionalDependencies: { clipboard: "1.0.0" } },
        "node_modules/clipboard": {
          version: "1.0.0",
          license: "MIT",
          optionalDependencies: { "clipboard-win-x64": "1.0.0", "clipboard-darwin-arm64": "1.0.0" },
        },
        "node_modules/clipboard-win-x64": {
          version: "1.0.0",
          license: "MIT",
          os: ["win32"],
          cpu: ["x64"],
          optional: true,
        },
        "node_modules/clipboard-darwin-arm64": {
          version: "1.0.0",
          license: "MIT",
          os: ["darwin"],
          cpu: ["arm64"],
          optional: true,
        },
      },
    };

    const result = JSON.parse(
      piRuntimeLock.createTargetRuntimeLock(JSON.stringify(source), "windows-x64"),
    );

    expect(Object.keys(result.packages)).toContain("node_modules/clipboard-win-x64");
    expect(Object.keys(result.packages)).not.toContain("node_modules/clipboard-darwin-arm64");
    expect(result.packages["node_modules/clipboard"].optionalDependencies).toEqual({
      "clipboard-win-x64": "1.0.0",
    });
  });

  it("rejects targets without a known platform mapping", () => {
    expect(() => piRuntimeLock.createTargetRuntimeLock("{}", "haiku-mips")).toThrow(/unsupported/);
  });
});
