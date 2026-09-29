import { describe, expect, it } from "vitest";
import en from "../../locales/en.json";
import es from "../../locales/es.json";
import ja from "../../locales/ja.json";
import zh from "../../locales/zh.json";
import { displayWorkflowName } from "./workflow-title.js";

const locales = [en, es, ja, zh];

describe("workflow title localization", () => {
  it.each(locales)("localizes a built-in default name using the active locale", (messages) => {
    const translate = (key) => key.split(".").reduce((current, part) => current?.[part], messages);
    const defaultName = messages.workflow.defaultName;

    expect(displayWorkflowName(defaultName, translate)).toBe(defaultName);
    expect(displayWorkflowName("Workflow", translate)).toBe(defaultName);
    expect(displayWorkflowName("工作流", translate)).toBe(defaultName);
    expect(displayWorkflowName("Flujo de trabajo", translate)).toBe(defaultName);
    expect(displayWorkflowName("ワークフロー", translate)).toBe(defaultName);
  });

  it("preserves a user-customized workflow name", () => {
    expect(displayWorkflowName("Nightly import", () => "Localized default")).toBe("Nightly import");
  });

  it("falls back to the saved default if its translation is unavailable", () => {
    expect(displayWorkflowName("工作流", () => undefined)).toBe("工作流");
  });
});
