// @vitest-environment node

import { describe, expect, it } from "vitest";
import rustChecks from "./check-rust.cjs";

describe("cross-platform Rust check runner", () => {
  it("runs native cargo checks directly in a stable order", () => {
    const calls = [];
    const manifestPath = "D:/workspace/src-tauri/Cargo.toml";

    const status = rustChecks.runRustChecks({
      manifestPath,
      run: (command, args) => {
        calls.push([command, args]);
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(calls).toEqual([
      ["cargo", ["check", "--manifest-path", manifestPath, "--all-targets"]],
      [
        "cargo",
        ["clippy", "--manifest-path", manifestPath, "--all-targets", "--", "-D", "warnings"],
      ],
      ["cargo", ["test", "--manifest-path", manifestPath, "--quiet"]],
      ["cargo", ["fmt", "--check", "--manifest-path", manifestPath]],
    ]);
  });

  it("stops immediately when a cargo command fails", () => {
    const calls = [];
    const status = rustChecks.runRustChecks({
      manifestPath: "D:/workspace/src-tauri/Cargo.toml",
      run: (command, args) => {
        calls.push([command, args]);
        return { status: 101 };
      },
      log: () => {},
    });

    expect(status).toBe(101);
    expect(calls).toHaveLength(1);
  });
});
