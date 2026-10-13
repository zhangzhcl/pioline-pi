import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n, setLocale } from "../../i18n.js";
import { setupModelsPage } from "./models-page.js";

function makeCatalogResponse(providers) {
  return { ok: true, data: { providers } };
}

function expectVisibilityCall(call, provider, modelId, visible) {
  const calls = call.mock.calls.filter(([operation]) => operation === "set_model_visibility");
  expect(
    calls.some(
      ([, params]) =>
        params?.provider === provider && params?.modelId === modelId && params?.visible === visible,
    ),
  ).toBe(true);
}

describe("settings model search, health checks, and scroll preservation", () => {
  let dom;

  beforeEach(async () => {
    dom = new JSDOM(`
      <div id="settings-api-keys"></div>
      <button id="config-editor-close"></button>
      <button id="config-editor-cancel"></button>
      <button id="config-editor-save"></button>
      <div id="config-editor-overlay"></div>
      <div id="config-editor-modal"></div>
      <textarea id="config-editor-textarea"></textarea>
      <div id="config-editor-error"></div>
      <div id="config-editor-path"></div>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.confirm = vi.fn(() => true);
    globalThis.requestAnimationFrame = (callback) => callback();
    vi.stubGlobal("fetch", async (url) => {
      const locale = String(url).includes("/zh") ? "zh" : "en";
      const content = readFileSync(join(process.cwd(), "public/locales", `${locale}.json`), "utf8");
      return { ok: true, status: 200, json: async () => JSON.parse(content) };
    });
    await initI18n();
    await setLocale("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.confirm;
    delete globalThis.requestAnimationFrame;
  });

  test("syncs the provider header in place when a single model is toggled", async () => {
    const call = vi.fn(async (operation) => {
      if (operation === "list_model_catalog") {
        return makeCatalogResponse([
          {
            provider: "anthropic",
            displayName: "Anthropic",
            configured: true,
            source: "stored",
            models: [
              {
                provider: "anthropic",
                id: "claude-sonnet-5",
                available: true,
                visible: true,
                health: { status: "healthy" },
              },
              {
                provider: "anthropic",
                id: "claude-opus-5",
                available: true,
                visible: true,
                health: { status: "healthy" },
              },
            ],
          },
        ]);
      }
      if (operation === "set_model_visibility") return { ok: true };
      throw new Error(`Unexpected operation: ${operation}`);
    });

    const onModelConfigurationChanged = vi.fn();
    const { loadApiKeysPanel } = setupModelsPage({
      configGateway: { call },
      onModelConfigurationChanged,
    });

    await loadApiKeysPanel();
    const providerRow = document.querySelector(".api-key-row");
    const selectAll = document.querySelector(".api-model-select-all-toggle");
    expect(selectAll.checked).toBe(true);
    expect(selectAll.indeterminate).toBe(false);
    expect(document.querySelector(".api-key-row-summary").textContent).toBe(
      "2 enabled · 2 healthy · 0 issues",
    );

    const toggle = document.querySelector(
      '.api-model-row[data-model-id="claude-opus-5"] .api-model-visibility-toggle',
    );
    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(onModelConfigurationChanged).toHaveBeenCalledTimes(1));
    expect(document.querySelector(".api-key-row")).toBe(providerRow);
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);
    expect(document.querySelector(".api-key-row-summary").textContent).toBe(
      "1 enabled · 2 healthy · 0 issues",
    );
    expect(document.querySelector(".api-model-check-visible").disabled).toBe(false);
  });

  test("keeps the model search query when a model is toggled", async () => {
    const models = Array.from({ length: 25 }, (_, index) => ({
      provider: "anthropic",
      id: `claude-model-${index}`,
      available: true,
      visible: true,
      health: { status: "unknown" },
    }));
    const onModelConfigurationChanged = vi.fn();
    const call = vi.fn(async (operation) => {
      if (operation === "list_model_catalog") {
        return makeCatalogResponse([
          {
            provider: "anthropic",
            displayName: "Anthropic",
            configured: true,
            source: "stored",
            models,
          },
        ]);
      }
      if (operation === "set_model_visibility") return { ok: true };
      throw new Error(`Unexpected operation: ${operation}`);
    });

    const { loadApiKeysPanel } = setupModelsPage({
      configGateway: { call },
      onModelConfigurationChanged,
    });

    await loadApiKeysPanel();
    const search = document.querySelector(".api-model-list-search");
    expect(search).not.toBeNull();
    search.value = "claude-model-1";
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(document.querySelectorAll(".api-model-row-filtered-out")).toHaveLength(14);

    const toggle = document.querySelector(
      '.api-model-row[data-model-id="claude-model-1"] .api-model-visibility-toggle',
    );
    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    await vi.waitFor(() => expectVisibilityCall(call, "anthropic", "claude-model-1", false));
    await vi.waitFor(() => expect(onModelConfigurationChanged).toHaveBeenCalledTimes(1));
    expect(document.querySelector(".api-model-list-search")).toBe(search);
    expect(search.value).toBe("claude-model-1");
    expect(document.querySelectorAll(".api-model-row-filtered-out")).toHaveLength(14);
    expect(toggle.disabled).toBe(false);
  });

  test("restores the model search query after a full panel re-render", async () => {
    const models = Array.from({ length: 25 }, (_, index) => ({
      provider: "anthropic",
      id: `claude-model-${index}`,
      available: true,
      visible: true,
      health: { status: "unknown" },
    }));
    const call = vi.fn(async (operation) => {
      if (operation === "list_model_catalog") {
        return makeCatalogResponse([
          {
            provider: "anthropic",
            displayName: "Anthropic",
            configured: true,
            source: "stored",
            models,
          },
        ]);
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });

    const { loadApiKeysPanel } = setupModelsPage({
      configGateway: { call },
      onModelConfigurationChanged: vi.fn(),
    });

    await loadApiKeysPanel();
    const search = document.querySelector(".api-model-list-search");
    search.value = "claude-model-1";
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    await setLocale("zh");

    await vi.waitFor(() => {
      const rerendered = document.querySelector(".api-model-list-search");
      expect(rerendered).not.toBe(search);
      expect(rerendered.value).toBe("claude-model-1");
    });
    expect(document.querySelectorAll(".api-model-row-filtered-out")).toHaveLength(14);
  });

  test("health check updates model row state", async () => {
    const call = vi.fn(async (operation) => {
      if (operation === "list_model_catalog") {
        return makeCatalogResponse([
          {
            provider: "anthropic",
            displayName: "Anthropic",
            configured: true,
            source: "stored",
            models: [
              {
                provider: "anthropic",
                id: "claude-sonnet-5",
                available: true,
                visible: true,
                health: { status: "unknown" },
              },
            ],
          },
        ]);
      }
      if (operation === "check_model_health") {
        expect(document.querySelector(".api-model-health-dot.checking")).not.toBeNull();
        return {
          ok: true,
          data: {
            results: [
              {
                provider: "anthropic",
                modelId: "claude-sonnet-5",
                status: "unhealthy",
                error: "model overloaded",
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });

    const { loadApiKeysPanel } = setupModelsPage({
      configGateway: { call },
      onModelConfigurationChanged: vi.fn(),
    });

    await loadApiKeysPanel();
    document.querySelector(".api-key-row-actions .api-model-check-visible").click();

    await vi.waitFor(() => {
      expect(document.querySelector(".api-model-health-dot.unhealthy")).not.toBeNull();
      expect(document.querySelector(".api-model-health-status").textContent).toContain(
        "model overloaded",
      );
    });
  });

  test("keeps the provider card mounted when a health check fails", async () => {
    const call = vi.fn(async (operation) => {
      if (operation === "list_model_catalog") {
        return makeCatalogResponse([
          {
            provider: "anthropic",
            displayName: "Anthropic",
            configured: true,
            models: [
              {
                provider: "anthropic",
                id: "claude-sonnet-5",
                available: true,
                visible: true,
                health: { status: "unknown" },
              },
            ],
          },
        ]);
      }
      if (operation === "check_model_health") {
        return { ok: false, error: "Request timed out" };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });

    const { loadApiKeysPanel } = setupModelsPage({
      configGateway: { call },
      onModelConfigurationChanged: vi.fn(),
    });

    await loadApiKeysPanel();
    const providerRow = document.querySelector(".api-key-row");
    document.querySelector(".api-key-row-actions .api-model-check-visible").click();

    await vi.waitFor(() => {
      expect(document.querySelector(".api-key-row")).toBe(providerRow);
      expect(document.querySelector(".api-model-health-status").textContent).toContain(
        "Request timed out",
      );
    });
    expect(
      call.mock.calls.filter(([operation]) => operation === "list_model_catalog"),
    ).toHaveLength(1);
  });

  test("keeps provider expansion state and scroll position after toggling a model", async () => {
    const settingsContent = document.createElement("div");
    settingsContent.className = "settings-content";
    settingsContent.style.cssText = "overflow-y: auto; height: 100px;";
    const settingsApiKeys = document.createElement("div");
    settingsApiKeys.id = "settings-api-keys";
    settingsContent.appendChild(settingsApiKeys);
    const createNode = (tag, id) => {
      const node = document.createElement(tag);
      node.id = id;
      return node;
    };
    document.body.replaceChildren(
      settingsContent,
      createNode("button", "config-editor-close"),
      createNode("button", "config-editor-cancel"),
      createNode("button", "config-editor-save"),
      createNode("div", "config-editor-overlay"),
      createNode("div", "config-editor-modal"),
      createNode("textarea", "config-editor-textarea"),
      createNode("div", "config-editor-error"),
      createNode("div", "config-editor-path"),
    );
    const call = vi.fn(async (operation) => {
      if (operation === "list_model_catalog") {
        return makeCatalogResponse([
          {
            provider: "anthropic",
            displayName: "Anthropic",
            configured: true,
            source: "stored",
            models: [
              {
                provider: "anthropic",
                id: "claude-sonnet-5",
                available: true,
                visible: true,
                health: { status: "unknown" },
              },
            ],
          },
          {
            provider: "openai",
            displayName: "OpenAI",
            configured: true,
            source: "stored",
            models: [
              {
                provider: "openai",
                id: "gpt-5",
                available: true,
                visible: true,
                health: { status: "unknown" },
              },
            ],
          },
        ]);
      }
      if (operation === "set_model_visibility") return { ok: true };
      throw new Error(`Unexpected operation: ${operation}`);
    });

    const { loadApiKeysPanel } = setupModelsPage({
      configGateway: { call },
      onModelConfigurationChanged: vi.fn(),
    });

    await loadApiKeysPanel();
    document.querySelector('.api-key-row[data-provider="anthropic"] .api-key-row-header').click();
    const scrollContainer = document.querySelector(".settings-content");
    scrollContainer.scrollTop = 320;

    const openAiToggle = document.querySelector(
      '.api-model-row[data-provider="openai"] .api-model-visibility-toggle',
    );
    openAiToggle.checked = false;
    openAiToggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    await vi.waitFor(() => expectVisibilityCall(call, "openai", "gpt-5", false));
    expect(
      document
        .querySelector('.api-key-row[data-provider="anthropic"] .api-model-list')
        .classList.contains("collapsed"),
    ).toBe(true);
    expect(scrollContainer.scrollTop).toBe(320);
  });
});
