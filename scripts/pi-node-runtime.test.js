import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNodeRuntimeTarget,
  nodeArchiveForTarget,
  piLauncherScript,
  prunePiNativeAddons,
  validateMachOBundle,
  validatePiNativeAddons,
} from "./pi-node-runtime.cjs";

describe("bundled Node Pi runtime", () => {
  it("selects the checksum-pinned Node archive for each macOS architecture", () => {
    expect(nodeArchiveForTarget("darwin-arm64")).toEqual({
      archive: "node-v22.23.3-darwin-arm64.tar.gz",
      sha256: "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53",
      version: "22.23.3",
    });
    expect(nodeArchiveForTarget("darwin-x64")).toEqual({
      archive: "node-v22.23.3-darwin-x64.tar.gz",
      sha256: "8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8",
      version: "22.23.3",
    });
  });

  it("rejects non-macOS targets instead of selecting an unrelated runtime", () => {
    expect(() => nodeArchiveForTarget("windows-x64")).toThrow(/unsupported/i);
  });

  it("launches Pi through the bundled Node binary and forwards every argument", () => {
    expect(piLauncherScript()).toBe(
      '#!/bin/sh\nSCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$SCRIPT_DIR/node/bin/node" "$SCRIPT_DIR/dist/bundle/cli.js" "$@"\n',
    );
  });

  it("rejects a Node Mach-O built above the macOS 11 floor", () => {
    expect(() => assertNodeRuntimeTarget(machO("arm64", 13, 0), "arm64")).toThrow(
      /macOS 13\.0\.0.*11\.0/i,
    );
  });

  it("accepts the pinned architecture at the macOS 11 floor", () => {
    expect(assertNodeRuntimeTarget(machO("x64", 11, 0), "x64")).toEqual({
      architecture: "x64",
      minimumMacOS: "11.0.0",
    });
  });

  it("checks every bundled native addon against the target architecture and OS floor", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipline-native-addon-test-"));
    try {
      const nested = path.join(directory, "@example", "native");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "addon.node"), machO("arm64", 11, 0));
      expect(validatePiNativeAddons(directory, "arm64")).toEqual([path.join(nested, "addon.node")]);
      fs.writeFileSync(path.join(nested, "addon.node"), machO("arm64", 13, 0));
      expect(() => validatePiNativeAddons(directory, "arm64")).toThrow(/macOS 13\.0\.0/i);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("checks the matching slice in a universal native addon", () => {
    const binary = universalMachO([machO("x64", 11, 0), machO("arm64", 13, 0)]);
    expect(assertNodeRuntimeTarget(binary, "x64")).toEqual({
      architecture: "x64",
      minimumMacOS: "11.0.0",
    });
    expect(() => assertNodeRuntimeTarget(binary, "arm64")).toThrow(/macOS 13\.0\.0/i);
  });

  it("checks every Mach-O in the installed app bundle for the target slice and macOS 11 floor", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipline-macho-bundle-test-"));
    try {
      fs.mkdirSync(path.join(directory, "Contents", "Frameworks"), { recursive: true });
      fs.writeFileSync(path.join(directory, "Contents", "Info.plist"), "not a Mach-O");
      fs.writeFileSync(path.join(directory, "Contents", "MacOS"), machO("arm64", 11, 0));
      fs.writeFileSync(
        path.join(directory, "Contents", "Frameworks", "libgood.dylib"),
        machO("arm64", 11, 0),
      );
      expect(validateMachOBundle(directory, "arm64")).toHaveLength(2);
      fs.writeFileSync(
        path.join(directory, "Contents", "Frameworks", "libgood.dylib"),
        machO("x64", 11, 0),
      );
      expect(() => validateMachOBundle(directory, "arm64")).toThrow(/architecture.*x64/i);
      fs.writeFileSync(
        path.join(directory, "Contents", "Frameworks", "libgood.dylib"),
        machO("arm64", 12, 0),
      );
      expect(() => validateMachOBundle(directory, "arm64")).toThrow(/macOS 12\.0\.0/i);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps only Pi TUI native addons for the selected macOS architecture", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipline-native-prune-test-"));
    const nativeRoot = path.join(directory, "@earendil-works", "pi-tui", "native");
    try {
      for (const platform of ["darwin-arm64", "darwin-x64", "win32-x64"])
        fs.mkdirSync(
          path.join(
            nativeRoot,
            platform.startsWith("win") ? "win32" : "darwin",
            "prebuilds",
            platform,
          ),
          { recursive: true },
        );
      prunePiNativeAddons(directory, "x64");
      expect(fs.existsSync(path.join(nativeRoot, "darwin", "prebuilds", "darwin-x64"))).toBe(true);
      expect(fs.existsSync(path.join(nativeRoot, "darwin", "prebuilds", "darwin-arm64"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(nativeRoot, "win32"))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function machO(architecture, major, minor) {
  const binary = Buffer.alloc(56);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  binary.writeUInt32LE(1, 16);
  binary.writeUInt32LE(0x32, 32);
  binary.writeUInt32LE(24, 36);
  binary.writeUInt32LE(1, 40);
  binary.writeUInt32LE((major << 16) | (minor << 8), 44);
  return binary;
}

function universalMachO(slices) {
  const headerSize = 8 + slices.length * 20;
  const binary = Buffer.alloc(
    headerSize + slices.reduce((total, slice) => total + slice.length, 0),
  );
  binary.writeUInt32BE(0xcafebabe, 0);
  binary.writeUInt32BE(slices.length, 4);
  let sliceOffset = headerSize;
  slices.forEach((slice, index) => {
    const entryOffset = 8 + index * 20;
    binary.writeUInt32BE(slice.readUInt32LE(4), entryOffset);
    binary.writeUInt32BE(0, entryOffset + 4);
    binary.writeUInt32BE(sliceOffset, entryOffset + 8);
    binary.writeUInt32BE(slice.length, entryOffset + 12);
    binary.writeUInt32BE(0, entryOffset + 16);
    slice.copy(binary, sliceOffset);
    sliceOffset += slice.length;
  });
  return binary;
}
