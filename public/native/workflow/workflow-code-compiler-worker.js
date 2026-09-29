// ABOUTME: Dedicated worker for offline TypeScript parsing and JS emission.

import * as esbuild from "esbuild-wasm";

const GLOBAL_EXPORT_NAME = "__piplineWorkflowExports";
const COMPILER_VERSION = `esbuild-wasm@${esbuild.version}`;
const MAX_SOURCE_BYTES = 50_000;
const MAX_COMPILED_BYTES = 50_000;
let initializePromise;

async function initializeCompiler() {
  if (!initializePromise) {
    const wasmURL = new URL("./esbuild.wasm", self.location.href);
    initializePromise = esbuild.initialize({ wasmURL, worker: false });
  }
  return initializePromise;
}

async function compile(source, entryFn) {
  if (typeof source !== "string") throw new TypeError("Workflow source must be text.");
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    throw new RangeError("Workflow source exceeds the 50 KB limit.");
  }
  if (typeof entryFn !== "string" || !/^[A-Za-z_$][\w$]*$/.test(entryFn)) {
    throw new TypeError("Workflow entryFn must be a valid JavaScript identifier.");
  }
  await initializeCompiler();
  const result = await esbuild.build({
    stdin: {
      contents: `${source}\nexport { ${entryFn} as __pipline_entry };`,
      sourcefile: "workflow-node.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "neutral",
    target: "es2020",
    format: "iife",
    globalName: GLOBAL_EXPORT_NAME,
    charset: "utf8",
    sourcemap: false,
    legalComments: "none",
    minify: false,
    treeShaking: false,
    plugins: [
      {
        name: "reject-workflow-module-resolution",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => ({
            errors: [{ text: `Workflow code cannot import modules (${args.path}).` }],
          }));
        },
      },
    ],
  });
  if (result.warnings.length > 0) {
    const messages = result.warnings
      .map((warning) => warning.text)
      .join("; ")
      .slice(0, 4_000);
    throw new Error(`The TypeScript compiler reported unsupported code: ${messages}`);
  }
  const compiledSource = result.outputFiles[0]?.text;
  if (typeof compiledSource !== "string") {
    throw new Error("The workflow compiler returned no JavaScript output.");
  }
  if (new TextEncoder().encode(compiledSource).byteLength > MAX_COMPILED_BYTES) {
    throw new RangeError("Compiled workflow code exceeds the 50 KB limit.");
  }
  return {
    compilerVersion: COMPILER_VERSION,
    compiledSource,
    warnings: result.warnings.map((warning) => warning.text),
  };
}

self.addEventListener("message", async (event) => {
  const { id, source, entryFn } = event.data ?? {};
  try {
    const result = await compile(source, entryFn);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: (error?.message || String(error)).slice(0, 4_000),
    });
  }
});
