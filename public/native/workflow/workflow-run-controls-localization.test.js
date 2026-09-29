import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { initI18n, setLocale } from "../../i18n.js";
import en from "../../locales/en.json";
import zh from "../../locales/zh.json";
import { createWorkflowRunControls } from "./workflow-run-controls.js";

describe("workflow run control localization", () => {
  let dom;
  let originalFetch;

  afterEach(() => {
    dom?.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.Event;
    if (originalFetch) globalThis.fetch = originalFetch;
    originalFetch = null;
  });

  it("localizes the run input placeholder on startup and when the shared locale changes", async () => {
    dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => ({
      ok: true,
      async json() {
        return String(url).endsWith("/zh.json") ? zh : en;
      },
    });
    await initI18n();

    const controls = createWorkflowRunControls({
      workflow: () => ({ id: "workflow-localization", workspaceId: "workspace-localization" }),
      control: {
        async listWorkflowRuns() {
          return [];
        },
      },
      nodeMetas: new Map(),
    });
    document.body.append(controls);
    const input = controls.querySelector(".workflow-run-controls__input");

    expect(input.placeholder).toBe(en.workflow.runInputPlaceholder);
    await setLocale("zh", { persist: false });
    expect(input.placeholder).toBe(zh.workflow.runInputPlaceholder);
    await setLocale("en", { persist: false });
    expect(input.placeholder).toBe(en.workflow.runInputPlaceholder);
  });
});
