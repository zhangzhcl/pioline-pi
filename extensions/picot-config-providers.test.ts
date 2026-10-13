// @vitest-environment node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  ModelRuntime: { create: vi.fn() },
  SessionManager: { inMemory: vi.fn(), listAll: vi.fn(), open: vi.fn() },
}));
vi.mock("./session-title", () => ({
  generateTitleForSession: vi.fn().mockResolvedValue("Generated title"),
}));
vi.mock("./ssh-remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssh-remote")>();
  return { ...actual, testSshRemoteConnection: vi.fn() };
});

const tempHomes: string[] = [];

async function loadConfigWithTempHome() {
  const home = mkdtempSync(join(tmpdir(), "picot-config-auth-"));
  tempHomes.push(home);
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const module = await import("./picot-config.ts");
  return {
    home,
    handlePicotConfig: module.handlePicotConfig,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("picot config auth operations", () => {
  it("stores and removes API keys without requiring registry authStorage", async () => {
    vi.stubEnv("HOME", "");
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const authPath = join(home, ".pi", "agent", "auth.json");

    await expect(
      handlePicotConfig("set_api_key", { provider: "openai", apiKey: "sk-test" }, {}),
    ).resolves.toEqual({ ok: true, data: { provider: "openai" } });

    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      openai: { type: "api_key", key: "sk-test" },
    });

    await expect(handlePicotConfig("remove_api_key", { provider: "openai" }, {})).resolves.toEqual({
      ok: true,
      data: { provider: "openai" },
    });

    expect(existsSync(authPath)).toBe(true);
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({});
  });

  it("updates the active registry credential store before refreshing", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    const credentials = {
      modify: vi.fn(
        async (_provider: string, _mutate: (store: unknown) => Promise<unknown>) => undefined,
      ),
      delete: vi.fn(async (_provider: string) => undefined),
    };
    const registry = {
      runtime: { credentials },
      refresh: vi.fn(async () => undefined),
    };

    await expect(
      handlePicotConfig(
        "set_api_key",
        { provider: "anthropic", apiKey: "sk-ant-test" },
        {
          modelRegistry: registry as never,
        },
      ),
    ).resolves.toEqual({ ok: true, data: { provider: "anthropic" } });

    expect(credentials.modify).toHaveBeenCalledWith("anthropic", expect.any(Function));
    const [, applyMutation] = credentials.modify.mock.calls[0] ?? [];
    expect(applyMutation).toBeTypeOf("function");
    await expect(applyMutation?.(undefined)).resolves.toEqual({
      type: "api_key",
      key: "sk-ant-test",
    });
    expect(registry.refresh).toHaveBeenCalledTimes(1);

    await expect(
      handlePicotConfig(
        "remove_api_key",
        { provider: "anthropic" },
        {
          modelRegistry: registry as never,
        },
      ),
    ).resolves.toEqual({ ok: true, data: { provider: "anthropic" } });

    expect(credentials.delete).toHaveBeenCalledWith("anthropic");
    expect(registry.refresh).toHaveBeenCalledTimes(2);
  });
});

describe("picot config custom provider operations", () => {
  it("saves a relay provider into models.json and stores the API key", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const credentials = {
      modify: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const registry = {
      runtime: { credentials },
      refresh: vi.fn(async () => undefined),
      getAll: vi.fn(() => []),
      getAvailable: vi.fn(async () => []),
      getProviderAuthStatus: vi.fn(() => ({ configured: false, source: "none", label: "" })),
      getProviderDisplayName: vi.fn((provider: string) => provider),
    };

    const result = await handlePicotConfig(
      "save_custom_provider",
      {
        providerId: "My Relay",
        baseUrl: "https://relay.example.com/v1",
        apiKey: "sk-test",
        protocol: "openai-completions",
        models: [{ id: "gpt-4o-mini", contextWindow: 32768, maxTokens: 4096 }],
      },
      { modelRegistry: registry as never },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        providerId: "my-relay",
        protocol: "openai-completions",
        modelCount: 1,
        keyStored: true,
      },
    });
    const saved = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8"));
    expect(saved.providers["my-relay"]).toMatchObject({
      baseUrl: "https://relay.example.com/v1",
      api: "openai-completions",
      models: [
        expect.objectContaining({ id: "gpt-4o-mini", contextWindow: 32768, maxTokens: 4096 }),
      ],
    });
    expect(saved.providers["my-relay"].apiKey).toBeUndefined();
    expect(credentials.modify).toHaveBeenCalledWith("my-relay", expect.any(Function));
  });

  it("detects an OpenAI-compatible relay", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/v1/models")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "gpt-4o-mini", context_window: 32768 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const result = await handlePicotConfig(
        "detect_custom_provider",
        { baseUrl: "https://relay.example.com/v1", apiKey: "sk-test" },
        {},
      );
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({
        data: {
          protocol: "openai-completions",
          models: [expect.objectContaining({ id: "gpt-4o-mini" })],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("health-checks custom providers over HTTP instead of creating an agent session", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const registry = {
      getAll: () => [
        {
          provider: "my-relay",
          id: "gpt-4o-mini",
          api: "openai-completions",
          baseUrl: "https://relay.example.com/v1",
        },
      ],
      getAvailable: async () => [{ provider: "my-relay", id: "gpt-4o-mini" }],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: () => "my-relay",
      refresh: vi.fn(),
      getApiKeyForProvider: async () => "sk-test",
    };
    try {
      const result = await handlePicotConfig(
        "check_model_health",
        { provider: "my-relay", modelId: "gpt-4o-mini" },
        { modelRegistry: registry as never },
      );
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({
        data: { results: [expect.objectContaining({ provider: "my-relay", status: "healthy" })] },
      });
      expect(createAgentSession).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("picot config oauth operations", () => {
  it("rejects oauth_logout for providers outside the codex whitelist (design §3)", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");

    await expect(handlePicotConfig("oauth_logout", { provider: "anthropic" }, {})).resolves.toEqual(
      { ok: false, error: "Unsupported OAuth provider" },
    );
    await expect(handlePicotConfig("oauth_logout", {}, {})).resolves.toEqual({
      ok: false,
      error: "Unsupported OAuth provider",
    });
    expect(ModelRuntime.create).not.toHaveBeenCalled();
  });
});

describe("picot config ssh remote operations", () => {
  it("requires an active workspace to read config", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    await expect(handlePicotConfig("get_ssh_remote_config", {}, {})).resolves.toEqual({
      ok: false,
      error: "Active workspace is required",
    });
  });

  it("reads the project's sshRemote settings and reports trust state", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const workspace = join(home, "workspace");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    const settingsPath = join(workspace, ".pi", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ sshRemote: { enabled: true, host: "example.com" }, other: 1 }),
      "utf8",
    );

    await expect(
      handlePicotConfig(
        "get_ssh_remote_config",
        {},
        { cwd: workspace, isProjectTrusted: () => false },
      ),
    ).resolves.toEqual({
      ok: true,
      data: {
        config: { enabled: true, host: "example.com" },
        resolved: { enabled: true, host: "example.com" },
        hosts: {},
        trusted: false,
        path: settingsPath,
      },
    });
  });

  it("defaults to a disabled config when the project has no settings.json yet", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });

    await expect(
      handlePicotConfig(
        "get_ssh_remote_config",
        {},
        { cwd: workspace, isProjectTrusted: () => true },
      ),
    ).resolves.toEqual({
      ok: true,
      data: {
        config: { enabled: false, host: "" },
        resolved: { enabled: false, host: "" },
        hosts: {},
        trusted: true,
        path: join(workspace, ".pi", "settings.json"),
      },
    });
  });

  it("rejects writes to an untrusted project", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });

    await expect(
      handlePicotConfig(
        "set_ssh_remote_config",
        { config: { enabled: true, host: "example.com" } },
        { cwd: workspace, isProjectTrusted: () => false },
      ),
    ).resolves.toEqual({
      ok: false,
      error: "Project settings cannot be changed until the workspace is trusted",
    });
  });

  it("rejects enabling without a host", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });

    await expect(
      handlePicotConfig(
        "set_ssh_remote_config",
        { config: { enabled: true, host: "" } },
        { cwd: workspace, isProjectTrusted: () => true },
      ),
    ).resolves.toEqual({
      ok: false,
      error: "Host is required when SSH remote execution is enabled",
    });
  });

  it("writes sshRemote settings while preserving unrelated project settings", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const workspace = join(home, "workspace");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    const settingsPath = join(workspace, ".pi", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ defaultThinkingLevel: "low" }), "utf8");

    const result = await handlePicotConfig(
      "set_ssh_remote_config",
      { config: { enabled: true, host: "example.com", port: 2222 } },
      { cwd: workspace, isProjectTrusted: () => true },
    );

    expect(result).toEqual({
      ok: true,
      data: { config: { enabled: true, host: "example.com", port: 2222 }, path: settingsPath },
    });
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      defaultThinkingLevel: "low",
      sshRemote: { enabled: true, host: "example.com", port: 2222 },
    });
  });

  it("delegates connection testing to testSshRemoteConnection", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    const { testSshRemoteConnection } = await import("./ssh-remote");
    vi.mocked(testSshRemoteConnection).mockResolvedValue({
      ok: true,
      message: "Connected",
      remotePath: "/srv/app",
      latencyMs: 12,
    });

    await expect(
      handlePicotConfig(
        "test_ssh_remote_config",
        { config: { enabled: true, host: "example.com" } },
        {},
      ),
    ).resolves.toEqual({
      ok: true,
      data: { ok: true, message: "Connected", remotePath: "/srv/app", latencyMs: 12 },
    });
    expect(testSshRemoteConnection).toHaveBeenCalledWith(
      { enabled: true, host: "example.com" },
      undefined,
    );
  });

  it("forwards a one-off password to the connection test without persisting it", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    const { testSshRemoteConnection } = await import("./ssh-remote");
    vi.mocked(testSshRemoteConnection).mockResolvedValue({
      ok: true,
      message: "Connected",
      remotePath: "/srv/app",
      latencyMs: 12,
    });

    await handlePicotConfig(
      "test_ssh_remote_config",
      { config: { enabled: true, host: "example.com" }, password: "hunter2" },
      {},
    );
    expect(testSshRemoteConnection).toHaveBeenCalledWith(
      { enabled: true, host: "example.com" },
      "hunter2",
    );
  });

  it("resolves a hostRef binding against the global registry", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const globalSettings = join(home, ".pi", "agent", "settings.json");
    const sshHosts = { "gpu-box": { host: "10.0.0.5", user: "ubuntu", port: 2222 } };
    writeFileSync(globalSettings, JSON.stringify({ sshHosts }), "utf8");
    const workspace = join(home, "workspace");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    const sshRemote = { enabled: true, hostRef: "gpu-box", remotePath: "/srv/app" };
    writeFileSync(join(workspace, ".pi", "settings.json"), JSON.stringify({ sshRemote }), "utf8");

    const result = await handlePicotConfig(
      "get_ssh_remote_config",
      {},
      { cwd: workspace, isProjectTrusted: () => true },
    );

    expect(result.ok).toBe(true);
    expect((result as { data: { resolved: unknown } }).data.resolved).toEqual({
      ...sshHosts["gpu-box"],
      ...sshRemote,
    });
  });

  it("keeps credentials out of the project file when saving a hostRef binding", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const workspace = join(home, "workspace");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    const settingsPath = join(workspace, ".pi", "settings.json");
    const config = {
      enabled: true,
      hostRef: "gpu-box",
      host: "10.0.0.5",
      identityFile: "~/.ssh/id_ed25519",
      remotePath: "/srv/app",
    };

    await handlePicotConfig(
      "set_ssh_remote_config",
      { config },
      { cwd: workspace, isProjectTrusted: () => true },
    );

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      sshRemote: { enabled: true, hostRef: "gpu-box", remotePath: "/srv/app" },
    });
  });

  it("saves and deletes hosts in the global registry", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const globalPath = join(home, ".pi", "agent", "settings.json");
    const hostEntry = { host: "10.0.0.5", user: "ubuntu", identityFile: "~/.ssh/id_ed25519" };

    await handlePicotConfig("set_ssh_host", { alias: "gpu-box", config: hostEntry }, {});
    expect(JSON.parse(readFileSync(globalPath, "utf8")).sshHosts).toEqual({ "gpu-box": hostEntry });

    await expect(handlePicotConfig("get_ssh_hosts", {}, {})).resolves.toMatchObject({
      ok: true,
      data: { hosts: { "gpu-box": { host: "10.0.0.5" } } },
    });

    await handlePicotConfig("delete_ssh_host", { alias: "gpu-box" }, {});
    expect(JSON.parse(readFileSync(globalPath, "utf8")).sshHosts).toEqual({});
  });

  it("rejects a registry entry without a host", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    await expect(
      handlePicotConfig("set_ssh_host", { alias: "gpu-box", config: { user: "ubuntu" } }, {}),
    ).resolves.toEqual({ ok: false, error: "Host is required" });
  });
});
