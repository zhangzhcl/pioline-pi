// @vitest-environment node

import { describe, expect, it } from "vitest";
import fetchCargo from "./fetch-cargo-dependencies.cjs";

describe("Cargo source prefetch", () => {
  it("fetches the locked dependency graph for the selected bundle target", () => {
    const calls = [];
    const status = fetchCargo.fetchCargoDependencies({
      manifestPath: "D:/workspace/src-tauri/Cargo.toml",
      target: "x86_64-pc-windows-msvc",
      run: (command, args) => {
        calls.push([command, args]);
        return { status: 0 };
      },
      log: () => {},
    });

    expect(status).toBe(0);
    expect(calls).toEqual([
      [
        "cargo",
        [
          "fetch",
          "--manifest-path",
          "D:/workspace/src-tauri/Cargo.toml",
          "--locked",
          "--target",
          "x86_64-pc-windows-msvc",
        ],
      ],
    ]);
  });

  it("rejects malformed target triples without running Cargo", () => {
    const calls = [];
    const status = fetchCargo.fetchCargoDependencies({
      target: "../../other-target",
      run: (...args) => calls.push(args),
      error: () => {},
    });

    expect(status).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
