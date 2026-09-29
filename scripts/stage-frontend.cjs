// ABOUTME: Stages frontend runtime assets for Tauri without shipping test modules.

const fs = require("node:fs");
const path = require("node:path");

const TEST_MODULE_PATTERN = /\.(?:test|spec)\.(?:[cm]?js|jsx|tsx?)$/i;

function pathsOverlap(left, right) {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function stageFrontend(sourceDirectory, destinationDirectory) {
  const source = path.resolve(sourceDirectory);
  const destination = path.resolve(destinationDirectory);
  if (pathsOverlap(source, destination) || pathsOverlap(destination, source)) {
    throw new Error("Frontend staging directories must not overlap");
  }
  if (!fs.statSync(source).isDirectory() || !fs.existsSync(path.join(source, "index.html"))) {
    throw new Error(`Frontend source is not a complete public directory: ${source}`);
  }

  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let copiedFiles = 0;
  let excludedTestFiles = 0;
  fs.cpSync(source, destination, {
    recursive: true,
    filter(sourcePath) {
      if (sourcePath === source) return true;
      const stats = fs.statSync(sourcePath);
      if (stats.isDirectory()) return true;
      if (TEST_MODULE_PATTERN.test(path.basename(sourcePath))) {
        excludedTestFiles += 1;
        return false;
      }
      copiedFiles += 1;
      return true;
    },
  });
  return { copiedFiles, excludedTestFiles };
}

module.exports = { stageFrontend };
