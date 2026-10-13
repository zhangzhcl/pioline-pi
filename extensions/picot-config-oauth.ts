// ABOUTME: OAuth device-code login/logout operation handlers for picot-config.

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createOAuthLoginOperationManager,
  type OAuthOperationEvent,
} from "./oauth-login-operations";
import { createPiOAuthLoginAdapter } from "./pi-oauth-login-adapter";
import { type CatalogRegistry, invalidateModelCatalogCache } from "./picot-config-models";
import { asString, type ConfigContext } from "./picot-config-settings";

const oauthLoginManager = createOAuthLoginOperationManager();

export async function handleOAuthConfigOp(
  op: string,
  params: Record<string, unknown>,
  ctx: ConfigContext,
  registry: CatalogRegistry | undefined,
): Promise<{ ok: true; data?: unknown } | null> {
  switch (op) {
    case "get_oauth_login_capabilities": {
      const runtime = await ModelRuntime.create();
      const adapter = createPiOAuthLoginAdapter(runtime);
      const capability = await adapter.getCodexCapability();
      if (capability.kind !== "supported") {
        return { ok: true, data: { providers: [] } };
      }
      const configured = Boolean(await runtime.checkAuth("openai-codex"));
      return {
        ok: true,
        data: { providers: [{ providerId: "openai-codex", deviceCode: true, configured }] },
      };
    }

    case "start_oauth_login": {
      const provider = asString(params.provider);
      const method = asString(params.method);
      if (provider !== "openai-codex" || method !== "device_code") {
        throw new Error("Unsupported OAuth provider or method");
      }
      if (!ctx.oauthNotify) throw new Error("OAuth event channel is unavailable");
      const started = oauthLoginManager.start();
      const emit = (event: OAuthOperationEvent) => ctx.oauthNotify?.(event);
      void (async () => {
        const runtime = await ModelRuntime.create();
        const adapter = createPiOAuthLoginAdapter(runtime);
        let expiryTimer: ReturnType<typeof setTimeout> | null = null;
        const clearExpiryTimer = () => {
          if (expiryTimer) {
            clearTimeout(expiryTimer);
            expiryTimer = null;
          }
        };
        try {
          await adapter.startCodexDeviceCodeLogin(
            {
              onDeviceCode: (code) => {
                try {
                  emit(oauthLoginManager.bindDeviceCode(started.operationId, code));
                  if (code.expiresInSeconds && code.expiresInSeconds > 0) {
                    clearExpiryTimer();
                    expiryTimer = setTimeout(() => {
                      expiryTimer = null;
                      try {
                        emit(oauthLoginManager.expire(started.operationId));
                      } catch {
                        // Operation already terminal.
                      }
                    }, code.expiresInSeconds * 1000);
                  }
                } catch {
                  // Operation already terminal; nothing to emit.
                }
              },
              onProgress: (message) => {
                try {
                  emit(oauthLoginManager.bindProgress(started.operationId, message));
                } catch {
                  // Operation already terminal; nothing to emit.
                }
              },
            },
            started.signal,
          );
          clearExpiryTimer();
          try {
            emit(oauthLoginManager.complete(started.operationId));
            if (registry) {
              await registry.refresh();
              invalidateModelCatalogCache();
            }
          } catch {
            // Already removed (cancelled/expired) — nothing to complete.
          }
        } catch (error) {
          clearExpiryTimer();
          const aborted = (error as Error | null)?.name === "AbortError";
          try {
            const event = aborted
              ? oauthLoginManager.cancel(started.operationId)
              : oauthLoginManager.fail(started.operationId, error);
            if (event) emit(event);
          } catch {
            // Already terminal; nothing to emit.
          }
        }
      })().catch((error) => {
        console.warn("[picot-config] OAuth login chain error:", error);
      });
      return {
        ok: true,
        data: { operationId: started.operationId, provider: "openai-codex", state: "starting" },
      };
    }

    case "cancel_oauth_login": {
      const operationId = asString(params.operationId);
      if (!operationId) throw new Error("operationId is required");
      const cancelled = oauthLoginManager.cancel(operationId);
      if (cancelled) ctx.oauthNotify?.(cancelled);
      return { ok: true, data: { operationId } };
    }

    case "get_oauth_login_status": {
      const operationId = asString(params.operationId);
      if (!operationId) throw new Error("operationId is required");
      return { ok: true, data: oauthLoginManager.getStatus(operationId) };
    }

    case "oauth_logout": {
      const provider = asString(params.provider);
      if (provider !== "openai-codex") throw new Error("Unsupported OAuth provider");
      const runtime = await ModelRuntime.create();
      await runtime.logout(provider);
      if (registry) {
        await registry.refresh();
        invalidateModelCatalogCache();
      }
      return { ok: true, data: { provider } };
    }

    default:
      return null;
  }
}
