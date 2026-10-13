import { setupRemoteAccessApproval } from "../features/remote-access-approval.js";
import { installRemoteAuthFetch, resolveRemoteAuth } from "../features/remote-auth.js";
import { setupTerminalPanel } from "../features/terminal-panel-integration.js";
import { sessionScopedClientId } from "../utils/random-id.js";
import { ConfigGateway } from "./config-gateway.js";
import { HostControlGateway } from "./control-gateway.js";
import { HostDataGateway } from "./data-gateway.js";
import { createOauthGateway } from "./oauth-gateway.js";
import { PreferenceGateway } from "./preference-gateway.js";
import { HostRuntimeAdapter, resolveHostWebSocketUrl } from "./runtime-adapter.js";
import { RuntimeGateway } from "./runtime-gateway.js";

/**
 * 初始化远程访问鉴权、WebSocket 适配器、终端集成与全部 Host 传输网关。
 */
export async function createNativeTransportStack({ getTarget }) {
  let configGatewayTargetReady = false;
  let resolveConfigGatewayReady;
  const configGatewayReady = new Promise((resolve) => {
    resolveConfigGatewayReady = resolve;
  });

  const remoteAuth = await resolveRemoteAuth();
  installRemoteAuthFetch(remoteAuth.deviceToken);
  if (remoteAuth.clientType === "desktop") setupRemoteAccessApproval();

  const adapter = new HostRuntimeAdapter({
    url: resolveHostWebSocketUrl(window),
    clientId: sessionScopedClientId(remoteAuth.clientType),
    clientType: remoteAuth.clientType,
    deviceToken: remoteAuth.deviceToken,
  });
  const terminalIntegration = setupTerminalPanel({
    adapter,
    getWorkspaceId: () => getTarget().workspaceId,
  });
  const runtime = new RuntimeGateway(adapter);
  const data = new HostDataGateway(adapter, {
    fetchImpl: window.fetch.bind(window),
    deviceToken: remoteAuth.deviceToken,
  });
  const control = new HostControlGateway(adapter);
  const preferences = new PreferenceGateway(adapter);
  const config = new ConfigGateway({
    runtime,
    getTarget,
    waitUntilReady: () => (configGatewayTargetReady ? Promise.resolve() : configGatewayReady),
  });
  const oauthGateway = createOauthGateway({ runtime, getTarget });
  window.__picotConfigCall = (op, params, options) => config.call(op, params, options);

  return {
    remoteAuth,
    adapter,
    terminalIntegration,
    runtime,
    data,
    control,
    preferences,
    config,
    oauthGateway,
    isConfigGatewayReady: () => configGatewayTargetReady,
    markConfigGatewayReady() {
      configGatewayTargetReady = true;
      resolveConfigGatewayReady();
    },
    markConfigGatewayUnready() {
      configGatewayTargetReady = false;
    },
  };
}
