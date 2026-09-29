import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = await readFile(join(process.cwd(), "src-tauri", "src", "main.rs"), "utf8");

describe("Tauri commands that create WebView windows", () => {
  it("runs the standalone workflow WebView builder from an async command", () => {
    expect(source).toMatch(/#\[tauri::command\]\s*async\s+fn\s+open_workflow_window\(/);
  });

  it("shows a newly created standalone workflow window before focusing it", () => {
    const builderBranch = source.slice(
      source.indexOf("let window = WebviewWindowBuilder::new(&app, &label"),
      source.indexOf(
        "return Ok(())",
        source.indexOf("let window = WebviewWindowBuilder::new(&app, &label"),
      ),
    );

    expect(builderBranch).toMatch(/window\s*\.show\(\)/);
    expect(builderBranch).toMatch(/window\s*\.show\(\)[\s\S]*window\.set_focus\(\)/);
  });

  it("runs the startup retry WebView builder from an async command", () => {
    expect(source).toMatch(/#\[tauri::command\]\s*async\s+fn\s+retry_startup\(/);
  });
});
