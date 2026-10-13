// ABOUTME: Spawns and supervises embedded `pi --mode rpc` processes, routing
// ABOUTME: RPC requests, event streams, and extension UI prompts per RuntimeTarget.

mod lifecycle;
#[cfg(test)]
mod tests;

#[cfg(test)]
use crate::pi_rpc_bridge::InMemoryPiProcess;
use crate::pi_rpc_bridge::{BridgeFrame, PiRpcBridge, PiRpcProcess};
use crate::runtime_coordinator::{
    MutationAcceptance, RuntimeCoordinator, RuntimeState, RuntimeTarget,
};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

use self::lifecycle::remove_closed_runtime;

const MAX_RPC_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct NativeLaunchSpec {
    pub binary: PathBuf,
    pub cwd: PathBuf,
    pub session_path: Option<PathBuf>,
    pub extensions: Vec<PathBuf>,
    pub pi_version: String,
    pub path_env: String,
    /// When true, spawn `pi --approve`: the desktop owner trusts the chosen
    /// workspace's project-local resources (.pi/settings.json, .agents/skills,
    /// project extensions) for this run. Picot's workspace is opened via the OS
    /// folder picker, so the user has already opted in; pi's non-interactive
    /// rpc mode otherwise leaves the project untrusted even when a saved
    /// decision exists in ~/.pi/agent/trust.json.
    pub approve: bool,
    /// Switch to Pi's native PowerShell tool only when Windows has no usable Bash.
    pub windows_powershell_fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchDescription {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub environment: BTreeMap<String, OsString>,
}

impl NativeLaunchSpec {
    pub fn command_description(&self) -> LaunchDescription {
        let mut args = Vec::new();
        for extension in &self.extensions {
            args.push("--extension".into());
            args.push(extension.as_os_str().to_owned());
        }
        args.extend(["--mode".into(), "rpc".into()]);
        if self.approve {
            args.push("--approve".into());
        }
        if let Some(session_path) = &self.session_path {
            args.push("--session".into());
            args.push(session_path.as_os_str().to_owned());
        }
        let mut environment = BTreeMap::from([
            ("PATH".into(), self.path_env.clone().into()),
            (
                "PI_STUDIO_PI_VERSION".into(),
                self.pi_version.clone().into(),
            ),
        ]);
        if let Some(agent_dir) = crate::pi_agent_dir::agent_dir() {
            environment.insert(
                crate::pi_agent_dir::PI_AGENT_DIR_ENV.into(),
                agent_dir.into_os_string(),
            );
        }
        // Dev-only signal for extensions (e.g. picot-config's model-load
        // perf tracing): only `cargo tauri dev` / debug builds set this, so
        // a release install never writes perf logs to disk.
        if cfg!(debug_assertions) {
            environment.insert("PICOT_DEV".into(), "1".into());
        }
        if self.windows_powershell_fallback {
            environment.insert(
                crate::pi_shell_compat::WINDOWS_POWERSHELL_FALLBACK_ENV.into(),
                "1".into(),
            );
        }
        // A remote workspace opened with an SSH password: hand it to the pi
        // process that will actually run the SSH calls.
        if let Some(password) = crate::remote_workspace::peek_password(&self.cwd) {
            environment.insert("PICOT_SSH_PASSWORD".into(), password.into());
        }
        LaunchDescription {
            program: self.binary.clone(),
            args,
            environment,
        }
    }
}

pub(super) struct ManagedRuntime {
    pub(super) target: Arc<Mutex<RuntimeTarget>>,
    pub(super) bridge: PiRpcBridge,
    pub(super) process: Option<PiRpcProcess>,
}

pub(super) struct NativePiManagerInner {
    pub(super) coordinator: Mutex<RuntimeCoordinator>,
    pub(super) runtimes: Mutex<HashMap<String, ManagedRuntime>>,
    pub(super) events: broadcast::Sender<NativeRuntimeEvent>,
    pub(super) pending_ui: Mutex<HashMap<String, Vec<NativeRuntimeEvent>>>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRuntimeEvent {
    pub target: RuntimeTarget,
    pub sequence: u64,
    pub event: Value,
}

#[derive(Clone)]
pub struct NativePiManager {
    inner: Arc<NativePiManagerInner>,
}

impl NativePiManager {
    pub fn new(idempotency_capacity: usize) -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            inner: Arc::new(NativePiManagerInner {
                coordinator: Mutex::new(RuntimeCoordinator::new(idempotency_capacity)),
                runtimes: Mutex::new(HashMap::new()),
                events,
                pending_ui: Mutex::new(HashMap::new()),
            }),
        }
    }

    #[cfg(test)]
    pub(super) fn in_memory(idempotency_capacity: usize) -> Self {
        Self::new(idempotency_capacity)
    }

    pub fn spawn(&self, target: RuntimeTarget, spec: &NativeLaunchSpec) -> Result<(), String> {
        let launch = spec.command_description();
        let mut command = Command::new(&launch.program);
        crate::windows_child::hide_console(&mut command);
        // Before any of our own env: an AppImage's AppRun points the dynamic
        // loader at the bundle, and `pi` is built against the host system.
        crate::appimage_env::scrub(&mut command);
        command
            .args(&launch.args)
            .envs(&launch.environment)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::pi_tls::apply_runtime_tls_env(&mut command);
        // Own the whole tree, and leave a record of it: `pi` outlives a Picot
        // that dies without running any teardown, and a wedged runtime will not
        // even notice the stdin EOF that normally stops it.
        crate::child_supervision::make_group_leader(&mut command);
        let child = command
            .spawn()
            .map_err(|error| format!("Cannot start embedded Pi native RPC process: {error}"))?;
        crate::child_supervision::record_runtime(child.id());
        let (bridge, process) = PiRpcBridge::attach(child, MAX_RPC_FRAME_BYTES)?;
        let register_result = self
            .inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .register(target.clone(), RuntimeState::Starting);
        if let Err(error) = register_result {
            let _ = process.kill();
            return Err(format!("Cannot register Pi runtime: {error:?}"));
        }
        let instance_id = target.instance_id.clone();
        let target_cell = Arc::new(Mutex::new(target));
        self.inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?
            .insert(
                instance_id.clone(),
                ManagedRuntime {
                    target: Arc::clone(&target_cell),
                    bridge: bridge.clone(),
                    process: Some(process),
                },
            );
        self.start_event_pump(instance_id, target_cell, bridge);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn register_in_memory(
        &self,
        target: RuntimeTarget,
    ) -> Result<InMemoryPiProcess, String> {
        self.register_in_memory_with_state(target, RuntimeState::Ready)
    }

    #[cfg(test)]
    pub(super) fn register_in_memory_with_state(
        &self,
        target: RuntimeTarget,
        initial_state: RuntimeState,
    ) -> Result<InMemoryPiProcess, String> {
        let (bridge, process) = PiRpcBridge::in_memory(1024 * 1024);
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .register(target.clone(), initial_state)
            .map_err(|error| format!("Cannot register test runtime: {error:?}"))?;
        let instance_id = target.instance_id.clone();
        let target_cell = Arc::new(Mutex::new(target));
        self.inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?
            .insert(
                instance_id.clone(),
                ManagedRuntime {
                    target: Arc::clone(&target_cell),
                    bridge: bridge.clone(),
                    process: None,
                },
            );
        self.start_event_pump(instance_id, target_cell, bridge);
        Ok(process)
    }

    fn start_event_pump(
        &self,
        instance_id: String,
        target_cell: Arc<Mutex<RuntimeTarget>>,
        bridge: PiRpcBridge,
    ) {
        let inner = Arc::clone(&self.inner);
        tauri::async_runtime::spawn(async move {
            while let Some(frame) = bridge.next_frame().await {
                let Ok(target) = target_cell.lock().map(|target| target.clone()) else {
                    return;
                };
                let event = match frame {
                    BridgeFrame::Event(event) | BridgeFrame::ExtensionUi(event) => event,
                    BridgeFrame::ProtocolError(message) => {
                        serde_json::json!({ "type": "protocol_error", "message": message })
                    }
                };
                let sequenced = {
                    let Ok(mut coordinator) = inner.coordinator.lock() else {
                        return;
                    };
                    match event.get("type").and_then(Value::as_str) {
                        Some("agent_start") => {
                            let _ = coordinator.set_state(&target, RuntimeState::Working);
                        }
                        Some("agent_settled") => {
                            let _ = coordinator.set_state(&target, RuntimeState::Idle);
                        }
                        _ => {}
                    }
                    coordinator.emit_event(&target, event)
                };
                let Ok(sequenced) = sequenced else {
                    return;
                };
                let runtime_event = NativeRuntimeEvent {
                    target: sequenced.target,
                    sequence: sequenced.sequence,
                    event: sequenced.event,
                };
                if crate::host_server::extension_ui_requires_owner(&runtime_event.event) {
                    if let Ok(mut pending) = inner.pending_ui.lock() {
                        pending
                            .entry(runtime_event.target.instance_id.clone())
                            .or_default()
                            .push(runtime_event.clone());
                    }
                }
                let _ = inner.events.send(runtime_event);
            }
            remove_closed_runtime(&inner, &instance_id);
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<NativeRuntimeEvent> {
        self.inner.events.subscribe()
    }

    pub fn pending_extension_ui(
        &self,
        target: &RuntimeTarget,
    ) -> Result<Vec<NativeRuntimeEvent>, String> {
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .validate(target)
            .map_err(|error| format!("Extension UI lookup rejected: {error:?}"))?;
        Ok(self
            .inner
            .pending_ui
            .lock()
            .map_err(|_| "Pending extension UI lock poisoned".to_string())?
            .get(&target.instance_id)
            .cloned()
            .unwrap_or_default())
    }

    pub async fn request(
        &self,
        target: &RuntimeTarget,
        command: Value,
        idempotency_key: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let mut mutation_key = None;
        {
            let mut coordinator = self
                .inner
                .coordinator
                .lock()
                .map_err(|_| "Runtime coordinator lock poisoned".to_string())?;
            coordinator
                .validate_command(target, &command)
                .map_err(|error| format!("Runtime request rejected: {error:?}"))?;
            if is_mutation(
                command
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ) {
                let key = idempotency_key
                    .ok_or_else(|| "Runtime mutation requires an idempotency key".to_string())?;
                let acceptance = coordinator
                    .accept_mutation(target, key)
                    .map_err(|error| format!("Runtime mutation rejected: {error:?}"))?;
                if acceptance == MutationAcceptance::Duplicate {
                    return coordinator
                        .mutation_result(target, key)
                        .map_err(|error| format!("Cannot read mutation result: {error:?}"))?
                        .ok_or_else(|| {
                            "Runtime mutation was accepted and is still pending".into()
                        });
                }
                mutation_key = Some(key.to_owned());
            }
        }
        let bridge = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?
            .get(&target.instance_id)
            .map(|runtime| runtime.bridge.clone())
            .ok_or_else(|| "Native runtime instance is not running".to_string())?;
        let response = match bridge.request(command, timeout).await {
            Ok(response) => response,
            Err(error) => {
                use std::fmt::Write as _;
                let mut message = format!("Pi RPC request failed: {error:?}");
                if let Some(stderr) = self.drain_diagnostics(&target.instance_id) {
                    let _ = write!(message, "\nPi stderr:\n{stderr}");
                }
                return Err(message);
            }
        };
        if let Ok(mut coordinator) = self.inner.coordinator.lock() {
            if coordinator
                .snapshot(target)
                .is_ok_and(|snapshot| snapshot.state == RuntimeState::Starting)
            {
                let _ = coordinator.set_state(target, RuntimeState::Ready);
            }
            if let Some(key) = mutation_key {
                coordinator
                    .complete_mutation(target, &key, response.clone())
                    .map_err(|error| format!("Cannot cache mutation result: {error:?}"))?;
            }
        } else if mutation_key.is_some() {
            return Err("Runtime coordinator lock poisoned".to_string());
        }
        Ok(response)
    }

    /// Pull whatever `pi` wrote to stderr, so a dead runtime reports why it
    /// died instead of a bare transport error.
    fn drain_diagnostics(&self, instance_id: &str) -> Option<String> {
        self.inner
            .runtimes
            .lock()
            .ok()?
            .get(instance_id)?
            .process
            .as_ref()?
            .drain_diagnostics()
    }

    pub async fn respond_extension_ui(
        &self,
        target: &RuntimeTarget,
        response: Value,
    ) -> Result<(), String> {
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .validate(target)
            .map_err(|error| format!("Extension UI response rejected: {error:?}"))?;
        if response.get("type").and_then(Value::as_str) != Some("extension_ui_response") {
            return Err("Expected extension_ui_response".into());
        }
        let bridge = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?
            .get(&target.instance_id)
            .map(|runtime| runtime.bridge.clone())
            .ok_or_else(|| "Native runtime instance is not running".to_string())?;
        let response_id = response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        bridge
            .send_frame(response)
            .await
            .map_err(|error| format!("Cannot send extension UI response: {error:?}"))?;
        if let Some(response_id) = response_id {
            let mut pending = self
                .inner
                .pending_ui
                .lock()
                .map_err(|_| "Pending extension UI lock poisoned".to_string())?;
            if let Some(events) = pending.get_mut(&target.instance_id) {
                events.retain(|event| {
                    event.event.get("id").and_then(Value::as_str) != Some(response_id.as_str())
                });
            }
        }
        Ok(())
    }
}

fn is_mutation(command_type: &str) -> bool {
    matches!(
        command_type,
        "prompt"
            | "steer"
            | "follow_up"
            | "compact"
            | "bash"
            | "fork"
            | "clone"
            | "navigate_tree"
            | "set_model"
            | "set_thinking_level"
            | "set_auto_compaction"
            | "set_auto_retry"
            | "set_steering_mode"
            | "set_follow_up_mode"
    )
}
