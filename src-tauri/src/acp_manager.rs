use crate::acp_launch::AcpLaunchSpec;
use crate::native_pi_manager::NativeRuntimeEvent;
use crate::pi_rpc_bridge::{BridgeFrame, PiRpcBridge, PiRpcProcess};
use crate::runtime_coordinator::{RuntimeCoordinator, RuntimeState, RuntimeTarget};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

mod protocol;

use self::protocol::{
    broadcast_event, build_prompt_blocks, handle_agent_frame, remove_closed_runtime,
    unwrap_jsonrpc_result,
};

const MAX_ACP_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// `initialize`/`session/new` are one-shot handshake calls; generous but
/// bounded so a hung ACP adapter fails the `#`-picker instead of hanging it.
const ACP_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

struct ManagedAcpRuntime {
    target: RuntimeTarget,
    bridge: PiRpcBridge,
    process: Option<PiRpcProcess>,
    acp_session_id: String,
}

struct AcpAgentManagerInner {
    coordinator: Mutex<RuntimeCoordinator>,
    runtimes: Mutex<HashMap<String, ManagedAcpRuntime>>,
    events: broadcast::Sender<NativeRuntimeEvent>,
    pending_permissions: Mutex<HashMap<String, Value>>,
}

/// Mirrors `NativePiManager`'s shape for external Agent Client Protocol (ACP)
/// agents (Claude Code today; Codex/Cursor are follow-up presets). Reuses
/// `PiRpcBridge` as the stdio transport and keeps its own `RuntimeCoordinator`
/// so a session can move from the Pi backend to an ACP backend (and back)
/// without instance collisions.
#[derive(Clone)]
pub struct AcpAgentManager {
    inner: Arc<AcpAgentManagerInner>,
}

impl AcpAgentManager {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            inner: Arc::new(AcpAgentManagerInner {
                coordinator: Mutex::new(RuntimeCoordinator::new(1)),
                runtimes: Mutex::new(HashMap::new()),
                events,
                pending_permissions: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn spawn(
        &self,
        target: RuntimeTarget,
        spec: AcpLaunchSpec,
    ) -> Result<String, String> {
        let mut command = Command::new(&spec.command);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .env("PATH", crate::pi_launch::build_augmented_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().map_err(|error| {
            format!(
                "Cannot start ACP agent '{}' ({}): {error}",
                spec.agent_id, spec.command
            )
        })?;
        let (bridge, process) = PiRpcBridge::attach(child, MAX_ACP_FRAME_BYTES)?;

        fn with_stderr(process: &PiRpcProcess, message: String) -> String {
            match process.drain_diagnostics() {
                Some(diagnostics) => format!("{message}\n--- agent stderr ---\n{diagnostics}"),
                None => message,
            }
        }

        let initialize = json!({
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": true, "writeTextFile": true },
                    "terminal": false
                }
            }
        });
        let init_response = bridge
            .request(initialize, ACP_HANDSHAKE_TIMEOUT)
            .await
            .map_err(|error| {
                let message = with_stderr(&process, format!("ACP initialize failed: {error:?}"));
                let _ = process.kill();
                message
            })?;
        if let Some(error) = init_response.get("error") {
            let message = with_stderr(&process, format!("ACP initialize rejected: {error}"));
            let _ = process.kill();
            return Err(message);
        }

        let new_session = json!({
            "jsonrpc": "2.0",
            "method": "session/new",
            "params": { "cwd": spec.cwd.to_string_lossy(), "mcpServers": [] }
        });
        let session_response = bridge
            .request(new_session, ACP_HANDSHAKE_TIMEOUT)
            .await
            .map_err(|error| {
                let message = with_stderr(&process, format!("ACP session/new failed: {error:?}"));
                let _ = process.kill();
                message
            })?;
        if let Some(error) = session_response.get("error") {
            let message = with_stderr(&process, format!("ACP session/new rejected: {error}"));
            let _ = process.kill();
            return Err(message);
        }
        let acp_session_id = session_response
            .get("result")
            .and_then(|result| result.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let Some(acp_session_id) = acp_session_id else {
            let _ = process.kill();
            return Err("ACP session/new returned no sessionId".to_string());
        };

        let register_result = self
            .inner
            .coordinator
            .lock()
            .map_err(|_| "ACP coordinator lock poisoned".to_string())?
            .register(target.clone(), RuntimeState::Ready);
        if let Err(error) = register_result {
            let _ = process.kill();
            return Err(format!("Cannot register ACP runtime: {error:?}"));
        }
        self.inner
            .runtimes
            .lock()
            .map_err(|_| "ACP runtime registry lock poisoned".to_string())?
            .insert(
                target.instance_id.clone(),
                ManagedAcpRuntime {
                    target: target.clone(),
                    bridge: bridge.clone(),
                    process: Some(process),
                    acp_session_id: acp_session_id.clone(),
                },
            );
        self.start_event_pump(target, bridge, spec.cwd);
        Ok(acp_session_id)
    }

    fn start_event_pump(&self, target: RuntimeTarget, bridge: PiRpcBridge, cwd: PathBuf) {
        let inner = Arc::clone(&self.inner);
        let canonical_cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.clone());
        tauri::async_runtime::spawn(async move {
            while let Some(frame) = bridge.next_frame().await {
                let is_registered = inner
                    .runtimes
                    .lock()
                    .ok()
                    .is_some_and(|runtimes| runtimes.contains_key(&target.instance_id));
                if !is_registered {
                    return;
                }
                match frame {
                    BridgeFrame::ProtocolError(message) => {
                        broadcast_event(
                            &inner,
                            &target,
                            json!({ "type": "acp_error", "message": message }),
                        );
                    }
                    BridgeFrame::Event(event) | BridgeFrame::ExtensionUi(event) => {
                        handle_agent_frame(&inner, &target, &bridge, &cwd, &canonical_cwd, event)
                            .await;
                    }
                }
            }
            remove_closed_runtime(&inner, &target.instance_id);
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<NativeRuntimeEvent> {
        self.inner.events.subscribe()
    }

    pub fn owns(&self, target: &RuntimeTarget) -> bool {
        self.inner
            .coordinator
            .lock()
            .is_ok_and(|coordinator| coordinator.validate(target).is_ok())
    }

    pub async fn request(
        &self,
        target: &RuntimeTarget,
        command: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "ACP coordinator lock poisoned".to_string())?
            .validate(target)
            .map_err(|error| format!("ACP request rejected: {error:?}"))?;
        let (bridge, acp_session_id) = {
            let runtimes = self
                .inner
                .runtimes
                .lock()
                .map_err(|_| "ACP runtime registry lock poisoned".to_string())?;
            let managed = runtimes
                .get(&target.instance_id)
                .ok_or_else(|| "ACP runtime instance is not running".to_string())?;
            (managed.bridge.clone(), managed.acp_session_id.clone())
        };
        match command.get("type").and_then(Value::as_str) {
            Some("acp_prompt") => {
                let payload = json!({
                    "jsonrpc": "2.0",
                    "method": "session/prompt",
                    "params": {
                        "sessionId": acp_session_id,
                        "prompt": build_prompt_blocks(&command),
                    }
                });
                let response = bridge
                    .request(payload, timeout)
                    .await
                    .map_err(|error| format!("ACP session/prompt failed: {error:?}"))?;
                unwrap_jsonrpc_result(response)
            }
            Some("acp_cancel") => {
                let payload = json!({
                    "jsonrpc": "2.0",
                    "method": "session/cancel",
                    "params": { "sessionId": acp_session_id }
                });
                bridge
                    .send_frame(payload)
                    .await
                    .map_err(|error| format!("ACP session/cancel failed: {error:?}"))?;
                Ok(json!({ "acknowledged": true }))
            }
            other => Err(format!("Unsupported ACP command: {other:?}")),
        }
    }

    pub async fn respond_permission(
        &self,
        target: &RuntimeTarget,
        response: Value,
    ) -> Result<(), String> {
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "ACP coordinator lock poisoned".to_string())?
            .validate(target)
            .map_err(|error| format!("ACP permission response rejected: {error:?}"))?;
        let request_key = response
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| "requestId is required".to_string())?;
        let key = format!("{}:{request_key}", target.instance_id);
        let original_id = self
            .inner
            .pending_permissions
            .lock()
            .map_err(|_| "ACP pending-permission lock poisoned".to_string())?
            .remove(&key)
            .ok_or_else(|| "Unknown or already-answered permission request".to_string())?;
        let outcome = match response.get("optionId").and_then(Value::as_str) {
            Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
            None => json!({ "outcome": "cancelled" }),
        };
        let bridge = {
            let runtimes = self
                .inner
                .runtimes
                .lock()
                .map_err(|_| "ACP runtime registry lock poisoned".to_string())?;
            runtimes
                .get(&target.instance_id)
                .ok_or_else(|| "ACP runtime instance is not running".to_string())?
                .bridge
                .clone()
        };
        bridge
            .send_frame(
                json!({ "jsonrpc": "2.0", "id": original_id, "result": { "outcome": outcome } }),
            )
            .await
            .map_err(|error| format!("Cannot send ACP permission response: {error:?}"))
    }

    pub fn stop(&self, target: &RuntimeTarget) -> Result<(), String> {
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "ACP coordinator lock poisoned".to_string())?
            .validate(target)
            .map_err(|error| format!("ACP stop rejected: {error:?}"))?;
        let mut runtime = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| "ACP runtime registry lock poisoned".to_string())?
            .remove(&target.instance_id)
            .ok_or_else(|| "ACP runtime instance is not running".to_string())?;
        if let Some(process) = &mut runtime.process {
            process.kill()?;
        }
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "ACP coordinator lock poisoned".to_string())?
            .unregister(target)
            .map_err(|error| format!("Cannot unregister stopped ACP runtime: {error:?}"))?;
        if let Ok(mut pending) = self.inner.pending_permissions.lock() {
            let prefix = format!("{}:", target.instance_id);
            pending.retain(|key, _| !key.starts_with(&prefix));
        }
        Ok(())
    }

    pub fn stop_workspace(&self, workspace_id: &str) {
        let targets = self
            .inner
            .runtimes
            .lock()
            .map(|runtimes| {
                runtimes
                    .values()
                    .filter(|runtime| runtime.target.workspace_id == workspace_id)
                    .map(|runtime| runtime.target.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for target in targets {
            let _ = self.stop(&target);
        }
    }

    pub fn stop_all(&self) {
        let targets = self
            .inner
            .runtimes
            .lock()
            .map(|runtimes| {
                runtimes
                    .values()
                    .map(|runtime| runtime.target.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for target in targets {
            let _ = self.stop(&target);
        }
    }
}

impl Default for AcpAgentManager {
    fn default() -> Self {
        Self::new()
    }
}
