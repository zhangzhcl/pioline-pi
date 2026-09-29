import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const STATIC_IMPORT = /^import(?:[^;\n]*\sfrom\s+|\s*\()\s*["'](\.[^"']+)["']/gm;
const BARE_IMPORT = /^import(?:[^;\n]*\sfrom\s+|\s*\()\s*["']([^./][^"']*)["']/gm;

function collectMissingImports(entryPath) {
  const pending = [entryPath];
  const visited = new Set();
  const missing = [];

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (visited.has(filePath)) continue;
    visited.add(filePath);

    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const importedPath = resolve(dirname(filePath), match[1]);
      if (!existsSync(importedPath)) {
        missing.push(`${filePath} imports missing ${importedPath}`);
        continue;
      }
      if (importedPath.endsWith(".js")) pending.push(importedPath);
    }
  }

  return missing;
}

function collectBareImports(entryPath) {
  const pending = [entryPath];
  const visited = new Set();
  const bareImports = new Set();

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (visited.has(filePath)) continue;
    visited.add(filePath);

    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(BARE_IMPORT)) bareImports.add(match[1]);
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const importedPath = resolve(dirname(filePath), match[1]);
      if (existsSync(importedPath) && importedPath.endsWith(".js")) pending.push(importedPath);
    }
  }

  return [...bareImports].sort();
}

const NAMED_IMPORT = /^import\s+(?:[\w$]+\s*,\s*)?\{([^}]+)\}\s+from\s+["'](\.[^"']+)["']/gm;

function parseImportedNames(clause) {
  return clause
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      part
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim(),
    )
    .filter(Boolean);
}

function collectExportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(
    /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/gm,
  )) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s+\{([^}]+)\}/gm)) {
    for (const part of match[1].split(",")) {
      const bits = part.trim().split(/\s+as\s+/);
      const exported = (bits[1] || bits[0]).trim();
      if (exported) names.add(exported);
    }
  }
  return names;
}

function collectMissingNamedImports(entryPath) {
  const pending = [entryPath];
  const visited = new Set();
  const missing = [];

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (visited.has(filePath)) continue;
    visited.add(filePath);

    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(NAMED_IMPORT)) {
      const importedPath = resolve(dirname(filePath), match[2]);
      if (!importedPath.endsWith(".js") || !existsSync(importedPath)) continue;
      const exported = collectExportedNames(readFileSync(importedPath, "utf8"));
      for (const name of parseImportedNames(match[1])) {
        if (!exported.has(name)) {
          missing.push(`${filePath} imports '${name}' from ${importedPath}`);
        }
      }
      pending.push(importedPath);
    }
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const importedPath = resolve(dirname(filePath), match[1]);
      if (existsSync(importedPath) && importedPath.endsWith(".js")) pending.push(importedPath);
    }
  }

  return missing;
}

function firstImportAfterTopLevelAwait(filePath) {
  const source = readFileSync(filePath, "utf8");
  const awaitMatch = source.match(/^await\s/m);
  if (!awaitMatch) return null;
  const afterAwait = source.slice(awaitMatch.index);
  const lateImport = afterAwait.match(/^import\s/m);
  if (!lateImport) return null;
  const line = source.slice(0, awaitMatch.index + lateImport.index).split("\n").length;
  return line;
}

describe("native application module graph", () => {
  it("loads bundled compatibility entrypoints as native ES modules", () => {
    const publicDir = resolve(process.cwd(), "public");
    const indexHtml = readFileSync(resolve(publicDir, "index.html"), "utf8");
    const moduleSources = [
      ...indexHtml.matchAll(/<script\s+type=["']module["']\s+src=["']([^"']+)["']/g),
    ].map(([, source]) => source);

    expect(
      moduleSources.map((source) => resolve(publicDir, source)).filter((path) => !existsSync(path)),
    ).toEqual([]);
    expect(moduleSources).toContain("compat/bootstrap-entry.js");
    expect(indexHtml).not.toContain('type="module-shim"');
    expect(indexHtml).not.toContain('type="importmap-shim"');
    expect(indexHtml).not.toContain("vendor/es-module-shims.js");
  });

  it("does not request missing modules that the static fallback serves as HTML", () => {
    const entryPath = resolve(process.cwd(), "public/native/app.js");

    expect(collectMissingImports(entryPath)).toEqual([]);
  });

  it("imports only names that the target module exports", () => {
    const entryPath = resolve(process.cwd(), "public/native/app.js");

    expect(collectMissingNamedImports(entryPath)).toEqual([]);
  });

  it("declares every static import before the first top-level await", () => {
    const entryPath = resolve(process.cwd(), "public/native/app.js");

    expect(firstImportAfterTopLevelAwait(entryPath)).toBeNull();
  });

  it("bundles all app entry dependencies without bare browser imports", () => {
    const publicDir = resolve(process.cwd(), "public");
    const entries = [
      "compat/bootstrap-entry.js",
      "compat/native/app.js",
      "compat/native/features/app-launcher.js",
      "compat/native/workflow/workflow-window.js",
    ].map((path) => resolve(publicDir, path));

    for (const entryPath of entries) {
      expect(existsSync(entryPath), `${entryPath} was not built`).toBe(true);
      expect(collectMissingImports(entryPath)).toEqual([]);
      expect(collectBareImports(entryPath)).toEqual([]);
    }
  });
});
