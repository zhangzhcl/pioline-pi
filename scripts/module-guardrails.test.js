// ABOUTME: Verifies repository-wide 500-line module ceiling, no-emoji policy, and MODULE_SPLIT_PLAN path integrity.
// ABOUTME: Runs automatically in the Vitest suite to prevent regressions across public, extensions, scripts, and src-tauri.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SOURCE_DIRS = ["public", "extensions", "scripts", "src-tauri/src"];
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "target",
  "vendor",
  "compat",
  "resources",
  ".git",
]);
const LINE_LIMIT_EXT = /\.(js|jsx|ts|tsx|rs|css|cjs|mjs|sh|ps1|m)$/;
const EMOJI_CHECK_EXT = /\.(js|jsx|ts|tsx|rs|css|cjs|mjs|html|json)$/;
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;
const ALLOWED_DIRECTIONAL_ARROWS = new Set([0x2194, 0x2197]);
const MAX_LINES = 500;

function collectFiles(dir, predicate, results = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, predicate, results);
    } else if (predicate(entry, full)) {
      results.push(full);
    }
  }
  return results;
}

describe("repository module and style guardrails", () => {
  it("keeps every source, script, style, and test module within the 500-line ceiling", () => {
    const violations = [];
    for (const dir of SOURCE_DIRS) {
      const files = collectFiles(join(REPO_ROOT, dir), (entry) => LINE_LIMIT_EXT.test(entry));
      for (const file of files) {
        const lines = readFileSync(file, "utf8").split(/\r?\n/).length;
        if (lines > MAX_LINES) {
          violations.push(`${relative(REPO_ROOT, file).replaceAll("\\", "/")} (${lines} lines)`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("forbids emoji pictographs across source, test, style, HTML, and locale files", () => {
    const violations = [];
    for (const dir of SOURCE_DIRS) {
      const files = collectFiles(join(REPO_ROOT, dir), (entry) => EMOJI_CHECK_EXT.test(entry));
      for (const file of files) {
        const content = readFileSync(file, "utf8");
        const disallowed = [...content.matchAll(EMOJI_REGEX)]
          .map((match) => match[0])
          .filter((char) => !ALLOWED_DIRECTIONAL_ARROWS.has(char.codePointAt(0)));
        if (disallowed.length > 0) {
          const unique = [
            ...new Set(
              disallowed.map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase()}`),
            ),
          ];
          violations.push(
            `${relative(REPO_ROOT, file).replaceAll("\\", "/")}: ${unique.join(", ")}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps every module path referenced in docs/MODULE_SPLIT_PLAN.md, AGENTS.md, and ARCHITECTURE.md synchronized with disk", () => {
    const docs = ["docs/MODULE_SPLIT_PLAN.md", "AGENTS.md", "ARCHITECTURE.md"];
    const missing = [];
    let totalChecked = 0;

    for (const docRelPath of docs) {
      const content = readFileSync(join(REPO_ROOT, docRelPath), "utf8");
      const referencedPaths = [
        ...content.matchAll(
          /`((?:public|extensions|src-tauri\/src|scripts|docs|\.github)\/[a-zA-Z0-9_./-]+\.(?:js|jsx|ts|tsx|rs|css|cjs|mjs|json|md|yml|ps1))`/g,
        ),
      ].map((match) => match[1]);

      for (const relPath of new Set(referencedPaths)) {
        totalChecked += 1;
        if (!existsSync(join(REPO_ROOT, relPath))) {
          missing.push(`${docRelPath} -> ${relPath}`);
        }
      }
    }

    expect(totalChecked).toBeGreaterThan(60);
    expect(missing).toEqual([]);
  });

  it("forbids allow(dead_code) and allow(clippy::...) suppressions across Rust modules in src-tauri/src", () => {
    const violations = [];
    const rustFiles = collectFiles(join(REPO_ROOT, "src-tauri/src"), (entry) =>
      entry.endsWith(".rs"),
    );
    for (const file of rustFiles) {
      const content = readFileSync(file, "utf8");
      if (/allow\s*\(\s*(dead_code|clippy::)/.test(content)) {
        violations.push(relative(REPO_ROOT, file).replaceAll("\\", "/"));
      }
    }
    expect(violations).toEqual([]);
  });
});
