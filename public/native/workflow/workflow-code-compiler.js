// ABOUTME: Lazily compile custom workflow TypeScript to a versioned single-file JavaScript artifact.

export const WORKFLOW_CODE_COMPILER_VERSION = "esbuild-wasm@0.28.0";
const MAX_SOURCE_BYTES = 50_000;
const MAX_COMPILED_BYTES = 50_000;
const COMPILATION_TIMEOUT_MS = 10_000;
let worker = null;
let nextRequestId = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(
    new URL("/vendor/workflow-code-compiler-worker.js", window.location.href).href,
  );
  worker.addEventListener("message", (event) => {
    const { id, ok, result, error } = event.data ?? {};
    const request = pending.get(id);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(id);
    if (ok) request.resolve(result);
    else request.reject(new Error(error || "Workflow TypeScript compilation failed."));
  });
  worker.addEventListener("error", (event) => {
    resetWorker(new Error(event.message || "Workflow compiler worker failed to load."));
  });
  return worker;
}

function resetWorker(error) {
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(error);
  }
  pending.clear();
}

/**
 * Compile a user-supplied NodeMeta TypeScript implementation to JS without
 * evaluating it or resolving any user modules. The generated JS is inert data.
 */
export async function compileWorkflowCode(source, entryFn) {
  if (typeof source !== "string") throw new TypeError("Workflow source must be text.");
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    throw new RangeError("Workflow source exceeds the 50 KB limit.");
  }
  if (typeof entryFn !== "string" || !/^[A-Za-z_$][\w$]*$/.test(entryFn)) {
    throw new TypeError("Workflow entryFn must be a valid JavaScript identifier.");
  }
  const id = ++nextRequestId;
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resetWorker(new Error("Workflow TypeScript compilation exceeded 10 seconds."));
    }, COMPILATION_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timeout });
    try {
      getWorker().postMessage({ id, source, entryFn });
    } catch (error) {
      resetWorker(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const compiledSource = result.compiledSource;
  if (result.compilerVersion !== WORKFLOW_CODE_COMPILER_VERSION) {
    throw new Error("The workflow compiler version does not match the locked desktop version.");
  }
  if (typeof compiledSource !== "string") {
    throw new Error("The workflow compiler returned no JavaScript output.");
  }
  if (new TextEncoder().encode(compiledSource).byteLength > MAX_COMPILED_BYTES) {
    throw new RangeError("Compiled workflow code exceeds the 50 KB limit.");
  }
  return {
    compiledSource,
    compilerVersion: result.compilerVersion,
    warnings: result.warnings,
  };
}
