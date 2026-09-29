type PiToolStateApi = {
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string }>;
  setActiveTools(names: string[]): void;
};

/** Replace Pi's unavailable Windows Bash tool without changing its other tools. */
export function activateNativePowerShellFallback(
  pi: PiToolStateApi,
  fallbackEnabled: boolean,
): boolean {
  if (!fallbackEnabled) return false;

  const activeTools = pi.getActiveTools();
  if (!activeTools.includes("bash")) return false;
  if (!pi.getAllTools().some((tool) => tool.name === "powershell")) return false;

  pi.setActiveTools([...new Set([...activeTools.filter((name) => name !== "bash"), "powershell"])]);
  return true;
}
