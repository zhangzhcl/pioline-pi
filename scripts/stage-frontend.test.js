import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { stageFrontend } = require("./stage-frontend.cjs");
const temporaryRoots = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipline-frontend-stage-"));
  temporaryRoots.push(root);
  const source = path.join(root, "source");
  const destination = path.join(root, "stage");
  fs.mkdirSync(path.join(source, "native", "workflow"), { recursive: true });
  fs.writeFileSync(path.join(source, "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(source, "app.js"), "import './module.js';");
  fs.writeFileSync(path.join(source, "module.js"), "export {};");
  fs.writeFileSync(path.join(source, "app.test.js"), "test source");
  fs.writeFileSync(path.join(source, "native", "workflow", "panel.spec.js"), "test source");
  fs.writeFileSync(path.join(source, "native", "workflow", "canvas.jsx"), "runtime source");
  return { source, destination };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("frontend release staging", () => {
  it("copies runtime assets and excludes nested test modules", () => {
    const { source, destination } = createFixture();

    const result = stageFrontend(source, destination);

    expect(result).toMatchObject({ copiedFiles: 4, excludedTestFiles: 2 });
    expect(fs.readFileSync(path.join(destination, "index.html"), "utf8")).toBe("<!doctype html>");
    expect(fs.existsSync(path.join(destination, "native", "workflow", "canvas.jsx"))).toBe(true);
    expect(fs.existsSync(path.join(destination, "app.test.js"))).toBe(false);
    expect(fs.existsSync(path.join(destination, "native", "workflow", "panel.spec.js"))).toBe(
      false,
    );
  });

  it("replaces stale staged assets on every build", () => {
    const { source, destination } = createFixture();
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "stale.js"), "stale");

    stageFrontend(source, destination);

    expect(fs.existsSync(path.join(destination, "stale.js"))).toBe(false);
  });

  it("refuses a destination that overlaps the source tree", () => {
    const { source } = createFixture();

    expect(() => stageFrontend(source, path.join(source, "stage"))).toThrow(
      "Frontend staging directories must not overlap",
    );
    expect(fs.existsSync(path.join(source, "index.html"))).toBe(true);
  });

  it("points Tauri production assets at the generated stage", () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, "src-tauri", "tauri.conf.json"), "utf8"),
    );
    const buildScript = fs.readFileSync(
      path.join(repositoryRoot, "scripts", "build-frontend.js"),
      "utf8",
    );

    expect(config.build.frontendDist).toBe("./target/frontend-dist");
    expect(config.bundle.resources["./target/frontend-dist"]).toBe("public");
    expect(buildScript).toContain("stageFrontend(PUBLIC_DIR, STAGED_PUBLIC_DIR)");
  });
});
