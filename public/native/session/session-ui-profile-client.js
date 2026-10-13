import { SessionUiStateStore } from "../../session-ui-state.js";

/**
 * 构建绑定到当前宿主运行时的会话 UI 配置存储实例，负责持久化每个会话的模型与思考等级选择。
 * 优先走 WebSocket 宿主请求通道，若不可用则回退到 `/v2/host` HTTP 端点。
 */
export function createNativeSessionUiStateStore({
  waitUntilReady,
  getSessionId,
  getRuntime,
  fetchImpl = globalThis.fetch?.bind(globalThis),
}) {
  return new SessionUiStateStore({
    waitUntilReady,
    profileClient: {
      load: () => {
        const sessionId = getSessionId();
        if (!sessionId || sessionId === "pending-bootstrap") return Promise.resolve(null);
        const runtime = getRuntime();
        return runtime?.sendHostRequest
          ? runtime
              .sendHostRequest({
                operation: "session_ui_profile_load",
                expectedSessionId: sessionId,
                fallbackToLatest: sessionId.startsWith("temporary-"),
              })
              .then((response) => response?.profile ?? null)
          : fetchImpl("/v2/host", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                operation: "session_ui_profile_load",
                expectedSessionId: sessionId,
                fallbackToLatest: sessionId.startsWith("temporary-"),
              }),
            })
              .then(async (response) => {
                if (!response.ok) return null;
                const data = await response.json();
                return data?.profile ?? null;
              })
              .catch(() => null);
      },
      save: (profile) => {
        const sessionId = getSessionId();
        if (!sessionId || sessionId === "pending-bootstrap") return Promise.resolve(null);
        const payload = {
          operation: "session_ui_profile_save",
          expectedSessionId: sessionId,
          ...profile,
        };
        const runtime = getRuntime();
        return runtime?.sendHostRequest
          ? runtime.sendHostRequest(payload).then((response) => response?.profile ?? profile)
          : fetchImpl("/v2/host", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            })
              .then(async (response) => {
                if (!response.ok) return profile;
                const data = await response.json();
                return data?.profile ?? profile;
              })
              .catch(() => profile);
      },
    },
  });
}
