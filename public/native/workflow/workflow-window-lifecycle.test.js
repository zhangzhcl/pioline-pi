import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workflowPanelSource = readFileSync(resolve(testDirectory, "workflow-panel.js"), "utf8");
const workflowWindowSource = readFileSync(resolve(testDirectory, "workflow-window.js"), "utf8");
const appSource = readFileSync(resolve(testDirectory, "../app.js"), "utf8");

describe("standalone workflow window lifecycle", () => {
  it("keeps workflow mode and its run alive when the editor window is hidden", () => {
    expect(workflowPanelSource).not.toMatch(/addEventListener\("pipline:workflow-window-hidden"/);
    expect(workflowPanelSource).toMatch(
      /cancelWorkflowRun\s*=\s*\(\)\s*=>\s*runControls\.cancelRun\?\.\(\)/,
    );
    expect(workflowPanelSource).toMatch(
      /function closeWorkflowPanel\(\)[\s\S]*?cancelWorkflowRun\(\)/,
    );
  });

  it("restores the detached workflow panel without turning workflow mode off", () => {
    expect(appSource).toMatch(
      /addEventListener\("pipline:workflow-window-hidden",\s*\(\)\s*=>\s*\{[\s\S]*?classList\.remove\("is-detached"\);[\s\S]*?setAttribute\("aria-expanded",\s*"true"\)/,
    );
  });

  it("updates the standalone observer to the newly selected Pi session", () => {
    expect(workflowWindowSource).toMatch(
      /addEventListener\("pipline:workflow-target-changed",\s*\(event\)\s*=>\s*\{[\s\S]*?target\s*=\s*next;[\s\S]*?adapter\.subscribeTarget\(next\);[\s\S]*?piActivity\.setTarget\(next\)/,
    );
  });

  it("checks the live Pi session before allowing a workflow Run", () => {
    expect(workflowWindowSource).not.toMatch(/getPiBusy:\s*\(\)\s*=>\s*false/);
    expect(workflowWindowSource).toMatch(/getPiBusy:\s*piActivity\.getBusy/);
  });

  it("hides the editor with a native event that reaches the workspace chat", () => {
    const hostSource = readFileSync(
      resolve(testDirectory, "../../../src-tauri/src/main.rs"),
      "utf8",
    );
    expect(hostSource).toContain("notify_workflow_window_hidden(&app, workspace_id)");
    expect(hostSource).toContain("pipline:workflow-window-hidden");
  });
});
