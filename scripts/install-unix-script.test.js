import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Pipline macOS/Linux install script", () => {
  const bash = process.env.BASH || "bash";
  const canRunBash = process.platform !== "win32" || Boolean(process.env.BASH);

  it.skipIf(!canRunBash)("documents Pipline release repository selection", () => {
    const output = execFileSync(bash, [join(process.cwd(), "scripts", "install.sh"), "--help"], {
      encoding: "utf8",
    });

    expect(output).toContain("Pipline");
    expect(output).toContain("--repository <owner/repository>");
    expect(output).toContain("PIPLINE_GITHUB_REPOSITORY");
    expect(output).not.toContain("Picot");
  });

  it.skipIf(!canRunBash)("rejects missing and empty version values before network access", () => {
    const script = join(process.cwd(), "scripts", "install.sh");

    for (const args of [["--version"], ["--version", ""]]) {
      try {
        execFileSync(bash, [script, ...args], { encoding: "utf8" });
        throw new Error(`Expected install.sh ${args.join(" ")} to fail.`);
      } catch (error) {
        expect(error.status).toBe(1);
        expect(`${error.stdout || ""}${error.stderr || ""}`).toContain("requires");
      }
    }
  });
});
