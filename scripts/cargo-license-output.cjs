// ABOUTME: Resets one target's generated Cargo notices without touching other targets.

const fs = require("node:fs");
const path = require("node:path");

function prepareCargoLicenseOutput(outputRoot, target) {
  const outputDirectory = path.join(outputRoot, target);
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true });
  return outputDirectory;
}

module.exports = { prepareCargoLicenseOutput };
