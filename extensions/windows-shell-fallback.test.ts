import { describe, expect, it, vi } from "vitest";
import { activateNativePowerShellFallback } from "./windows-shell-fallback";

function createPi(active: string[], all: string[]) {
  return {
    getActiveTools: vi.fn(() => active),
    getAllTools: vi.fn(() => all.map((name) => ({ name }))),
    setActiveTools: vi.fn(),
  };
}

describe("Windows Pi shell fallback", () => {
  it("does nothing when the launch did not request a fallback", () => {
    const pi = createPi(["read", "bash", "write"], ["read", "bash", "powershell", "write"]);

    expect(activateNativePowerShellFallback(pi, false)).toBe(false);
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("does nothing when the user's active tool set does not include Bash", () => {
    const pi = createPi(["read", "write"], ["read", "bash", "powershell", "write"]);

    expect(activateNativePowerShellFallback(pi, true)).toBe(false);
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("does nothing when this Pi platform has no native PowerShell tool", () => {
    const pi = createPi(["read", "bash", "write"], ["read", "bash", "write"]);

    expect(activateNativePowerShellFallback(pi, true)).toBe(false);
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("replaces only Bash and preserves other native and extension tools", () => {
    const pi = createPi(
      ["read", "bash", "write", "mcp_search", "pipline_workflow"],
      ["read", "bash", "powershell", "write", "mcp_search", "pipline_workflow"],
    );

    expect(activateNativePowerShellFallback(pi, true)).toBe(true);
    expect(pi.setActiveTools).toHaveBeenCalledWith([
      "read",
      "write",
      "mcp_search",
      "pipline_workflow",
      "powershell",
    ]);
  });

  it("does not duplicate PowerShell when the user already enabled it", () => {
    const pi = createPi(["read", "bash", "powershell"], ["read", "bash", "powershell"]);

    expect(activateNativePowerShellFallback(pi, true)).toBe(true);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "powershell"]);
  });
});
