#!/usr/bin/env node
/**
 * Builds browser-only ESM vendor bundles for CodeMirror and PDF.js.
 *
 * Source modules import @codemirror/* and pdfjs-dist directly from node_modules
 * (resolved by Vitest). At browser runtime, index.html contains an import map
 * that redirects those specifiers to the same-origin generated files under
 * public/vendor/.
 *
 * Outputs:
 *   public/vendor/codemirror.js     — all CodeMirror runtime exports used by the app
 *   public/vendor/pdf.js            — PDF.js facade (getDocument, GlobalWorkerOptions)
 *   public/vendor/pdf.worker.js     — PDF.js worker
 *   public/vendor/xterm.js          — xterm constructors on globalThis.PicotXterm
 *   public/vendor/chart.js          — Chart.js constructor on globalThis.Chart
 *   public/vendor/tauri-notification.js — Tauri notification browser facade
 */

const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");
const { copyBundleLicenses } = require("./vendor-license-collector.js");
const { stageFrontend } = require("./stage-frontend.cjs");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const OUT_DIR = path.join(ROOT, "public", "vendor");
const COMPAT_DIR = path.join(ROOT, "public", "compat");
const STAGED_PUBLIC_DIR = path.join(ROOT, "src-tauri", "target", "frontend-dist");

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "safari14",
  // Destructuring is native on Safari 14, but esbuild's target table marks it
  // for lowering and its lowering path is intentionally unsupported.
  supported: { destructuring: true },
  sourcemap: false,
  legalComments: "external",
};

/** @type {import('esbuild').BuildOptions[]} */
const entries = [
  {
    ...common,
    entryPoints: [path.join(ROOT, "public", "codemirror-vendor-entry.js")],
    outfile: path.join(OUT_DIR, "codemirror.js"),
  },
  {
    ...common,
    entryPoints: [path.join(ROOT, "public", "pdf-vendor-entry.js")],
    outfile: path.join(OUT_DIR, "pdf.js"),
  },
  {
    ...common,
    entryPoints: [
      path.join(ROOT, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"),
    ],
    outfile: path.join(OUT_DIR, "pdf.worker.js"),
  },
  {
    // Classic <script> tags share the global scope. ESM output would leak
    // top-level `var` bindings (xterm/Chart.js both declare helpers that
    // collide with browser APIs such as getComputedStyle) and recurse.
    ...common,
    format: "iife",
    entryPoints: [path.join(ROOT, "public", "terminal-vendor-entry.js")],
    outfile: path.join(OUT_DIR, "xterm.js"),
  },
  {
    ...common,
    format: "iife",
    entryPoints: [path.join(ROOT, "public", "chart-vendor-entry.js")],
    outfile: path.join(OUT_DIR, "chart.js"),
  },
  {
    ...common,
    entryPoints: [path.join(ROOT, "public", "tauri-notification-vendor-entry.js")],
    outfile: path.join(OUT_DIR, "tauri-notification.js"),
  },
  {
    // The workflow canvas is a separate dynamic entry so the ordinary Pi chat
    // never downloads or evaluates React, React Flow, or canvas-only styles.
    ...common,
    jsx: "automatic",
    entryPoints: [path.join(ROOT, "public", "native", "workflow", "workflow-canvas.jsx")],
    outfile: path.join(OUT_DIR, "workflow-canvas.js"),
  },
  {
    // TypeScript compilation for generated node metadata is a separate lazy
    // module and its WASM payload is copied as a static app resource below.
    ...common,
    entryPoints: [path.join(ROOT, "public", "native", "workflow", "workflow-code-compiler.js")],
    outfile: path.join(OUT_DIR, "workflow-code-compiler.js"),
  },
  {
    // Keep WASM initialization and TypeScript parsing off the WebView thread.
    ...common,
    format: "iife",
    target: "es2020",
    entryPoints: [
      path.join(ROOT, "public", "native", "workflow", "workflow-code-compiler-worker.js"),
    ],
    outfile: path.join(OUT_DIR, "workflow-code-compiler-worker.js"),
  },
];

// Static assets copied verbatim into public/vendor/. Each entry is a
// [source-relative-to-ROOT, destination-filename] pair.
const staticAssets = [
  ["node_modules/remend/dist/index.js", "remend.js"],
  ["node_modules/@xterm/xterm/css/xterm.css", "xterm.css"],
  ["node_modules/esbuild-wasm/esbuild.wasm", "esbuild.wasm"],
  ["node_modules/esbuild-wasm/LICENSE.md", "esbuild-wasm-LICENSE.md"],
];

function collectCompatibilityModules(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "vendor" || entry.name === "compat") continue;
      collectCompatibilityModules(path.join(directory, entry.name), files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    if (
      entry.name.endsWith(".test.js") ||
      entry.name.endsWith(".spec.js") ||
      entry.name.endsWith("-vendor-entry.js") ||
      entry.name === "compatibility.js" ||
      entry.name === "workflow-code-compiler-worker.js"
    )
      continue;
    files.push(path.join(directory, entry.name));
  }
  return files;
}

function compatibilityBuildOptions(sources) {
  return {
    entryPoints: sources,
    outbase: PUBLIC_DIR,
    outdir: COMPAT_DIR,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "safari14",
    // Destructuring is supported on Safari 14; esbuild cannot lower it, so
    // leave that syntax intact while lowering newer syntax around it.
    supported: { destructuring: true },
    sourcemap: false,
    legalComments: "external",
    metafile: true,
  };
}

async function buildCompatibilityModules() {
  const resolvedPublic = path.resolve(PUBLIC_DIR);
  const resolvedCompat = path.resolve(COMPAT_DIR);
  if (!resolvedCompat.startsWith(`${resolvedPublic}${path.sep}`))
    throw new Error("Compatibility build output must remain under public/");
  fs.rmSync(COMPAT_DIR, { recursive: true, force: true });

  const sources = collectCompatibilityModules(PUBLIC_DIR);
  const result = await esbuild.build(compatibilityBuildOptions(sources));
  console.log(`[build-frontend] ${sources.length} app modules transpiled for Safari 14`);
  return result.metafile;
}

function copyStaticAssets() {
  for (const [relSrc, destName] of staticAssets) {
    const src = path.join(ROOT, relSrc);
    const dest = path.join(OUT_DIR, destName);
    fs.copyFileSync(src, dest);
    const sizeKb = (fs.statSync(dest).size / 1024).toFixed(1);
    console.log(`[build-frontend] ${path.relative(ROOT, dest)} (${sizeKb} KB)`);
  }
}

async function buildOnce() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const bundleMetafiles = [];
  for (const obsoleteAsset of ["es-module-shims.js", "es-module-shims-LICENSE.md"]) {
    fs.rmSync(path.join(OUT_DIR, obsoleteAsset), { force: true });
  }
  for (const entry of entries) {
    const result = await esbuild.build({ ...entry, metafile: true });
    bundleMetafiles.push(result.metafile);
    const outPath = entry.outfile;
    const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(1);
    console.log(`[build-frontend] ${path.relative(ROOT, outPath)} (${sizeKb} KB)`);
  }
  copyStaticAssets();
  // Compatibility entries can depend on generated vendor modules (notably
  // the lazy workflow canvas), so compile them only after vendor outputs are
  // fresh. Otherwise they can bundle the previous build's JSX/runtime code.
  bundleMetafiles.push(await buildCompatibilityModules());
  copyBundleLicenses({
    root: ROOT,
    outputDirectory: path.join(OUT_DIR, "licenses"),
    metafiles: bundleMetafiles,
    additionalPackages: ["remend"],
  });
  const staged = stageFrontend(PUBLIC_DIR, STAGED_PUBLIC_DIR);
  console.log(
    `[build-frontend] staged ${staged.copiedFiles} runtime files; excluded ${staged.excludedTestFiles} test modules`,
  );
}

async function buildWatch() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const contexts = [];
  const compatibilitySources = collectCompatibilityModules(PUBLIC_DIR);
  const compatibilityContext = await esbuild.context(
    compatibilityBuildOptions(compatibilitySources),
  );
  contexts.push(compatibilityContext);
  await compatibilityContext.watch();
  console.log(`[build-frontend] watching ${compatibilitySources.length} Safari 14 app modules`);
  for (const entry of entries) {
    const ctx = await esbuild.context(entry);
    contexts.push(ctx);
    await ctx.watch();
    console.log(
      `[build-frontend] watching ${path.relative(ROOT, entry.entryPoints[0])} → ${path.relative(ROOT, entry.outfile)}`,
    );
  }
  console.log("[build-frontend] watch mode active. Press Ctrl+C to stop.");
}

async function main() {
  const watch = process.argv.includes("--watch");
  try {
    if (watch) {
      await buildWatch();
    } else {
      await buildOnce();
      console.log("[build-frontend] done.");
    }
  } catch (err) {
    console.error("[build-frontend] failed:", err);
    process.exit(1);
  }
}

main();
