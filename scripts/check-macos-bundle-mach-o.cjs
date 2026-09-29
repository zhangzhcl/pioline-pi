#!/usr/bin/env node

const path = require("node:path");
const { validateMachOBundle } = require("./pi-node-runtime.cjs");

const [, , appPath, architecture] = process.argv;
if (!appPath || !["arm64", "x64"].includes(architecture)) {
  console.error("Usage: check-macos-bundle-mach-o.cjs <app-bundle> <arm64|x64>");
  process.exit(2);
}

try {
  const binaries = validateMachOBundle(path.resolve(appPath, "Contents"), architecture);
  console.log(
    `[macos-mach-o-check] validated ${binaries.length} Mach-O files for ${architecture} and macOS 11.0+`,
  );
} catch (error) {
  console.error(`[macos-mach-o-check] ${error.message}`);
  process.exit(1);
}
