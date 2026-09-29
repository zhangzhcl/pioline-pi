import { afterEach, describe, expect, it, vi } from "vitest";

class CompilerWorkerStub {
  listeners = new Map();
  terminated = false;
  request = null;

  constructor(url) {
    this.url = String(url);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  postMessage(request) {
    this.request = request;
  }

  respond(data) {
    this.listeners.get("message")?.({ data });
  }

  fail(message) {
    this.listeners.get("error")?.({ message });
  }

  terminate() {
    this.terminated = true;
  }
}

describe("workflow TypeScript compiler bridge", () => {
  let workers;

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function setupCompiler() {
    vi.resetModules();
    workers = [];
    vi.stubGlobal("window", { location: { href: "http://localhost/app" } });
    vi.stubGlobal(
      "Worker",
      class extends CompilerWorkerStub {
        constructor(url) {
          super(url);
          workers.push(this);
        }
      },
    );
    return import("./workflow-code-compiler.js");
  }

  it("sends bounded source to the local worker and returns the locked artifact", async () => {
    const compiler = await setupCompiler();
    const pending = compiler.compileWorkflowCode("export function run() { return 1; }", "run");
    const [worker] = workers;

    expect(worker.url).toBe("http://localhost/vendor/workflow-code-compiler-worker.js");
    expect(worker.request).toMatchObject({
      id: 1,
      source: "export function run() { return 1; }",
      entryFn: "run",
    });
    worker.respond({
      id: worker.request.id,
      ok: true,
      result: {
        compilerVersion: compiler.WORKFLOW_CODE_COMPILER_VERSION,
        compiledSource: "(() => ({ run: () => 1 }))()",
        warnings: [],
      },
    });

    await expect(pending).resolves.toEqual({
      compilerVersion: compiler.WORKFLOW_CODE_COMPILER_VERSION,
      compiledSource: "(() => ({ run: () => 1 }))()",
      warnings: [],
    });
    expect(worker.terminated).toBe(false);
  });

  it("rejects invalid and oversized inputs before creating a worker", async () => {
    const compiler = await setupCompiler();

    await expect(compiler.compileWorkflowCode("x", "not-valid!")).rejects.toThrow(
      "valid JavaScript identifier",
    );
    await expect(compiler.compileWorkflowCode("x".repeat(50_001), "run")).rejects.toThrow(
      "50 KB limit",
    );
    expect(workers).toHaveLength(0);
  });

  it("terminates the worker and rejects pending requests after the compilation timeout", async () => {
    vi.useFakeTimers();
    const compiler = await setupCompiler();
    const pending = compiler.compileWorkflowCode("export function run() {}", "run");
    const [worker] = workers;
    const rejection = expect(pending).rejects.toThrow("exceeded 10 seconds");

    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;

    expect(worker.terminated).toBe(true);
  });
});
