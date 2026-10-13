// ABOUTME: Owns every terminal PTY: spawn, input, resize, batched output delivery,
// ABOUTME: generation-checked lifecycle, and process-tree cleanup. The only module
// ABOUTME: allowed to touch portable-pty; never parses ANSI output or infers cwd.

mod commands;
mod pty_lifecycle;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::MasterPty;
use serde_json::{json, Value};

use crate::terminal_output::TerminalOutputStore;
use crate::terminal_profiles::{ShellProbe, SystemShellProbe};
use crate::terminal_registry::{err_str, TerminalError, TerminalKey, TerminalRegistry};
use crate::terminal_state_store::{
    PersistedTabDescriptor, TerminalStateStore, WorkspaceTerminalMetadata,
};
use crate::window_owner::OwnerId;

use self::pty_lifecycle::kill_live_terminal;
#[cfg(windows)]
use crate::windows_child::windows_job;

const INITIAL_COLS: u16 = 80;
const INITIAL_ROWS: u16 = 24;
const READ_BUF_BYTES: usize = 8 * 1024;
const CHECKPOINT_MAX_BYTES: usize = 2 * 1024 * 1024;
const INPUT_MAX_BYTES: usize = 64 * 1024;

/// Delivers a `terminal_event` frame to the current authenticated owner client.
/// In production this wraps `BrokerWs::send_owner_event`.
pub type EventSink = Arc<dyn Fn(&OwnerId, Value) + Send + Sync>;

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<ManagerInner>,
}

struct ManagerInner {
    registry: TerminalRegistry,
    probe: Box<dyn ShellProbe>,
    live: Mutex<HashMap<String, LiveTerminal>>,
    outputs: Mutex<HashMap<String, TerminalOutputStore>>,
    event_sink: Mutex<Option<EventSink>>,
    state_store: TerminalStateStore,
}

struct LiveTerminal {
    owner: OwnerId,
    workspace_root: PathBuf,
    generation: u64,
    profile_id: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    #[cfg(windows)]
    job: Option<windows_job::JobHandle>,
}

impl TerminalManager {
    pub fn new(registry: TerminalRegistry, state_store: TerminalStateStore) -> Self {
        Self::with_probe(registry, state_store, Box::new(SystemShellProbe))
    }

    pub fn with_probe(
        registry: TerminalRegistry,
        state_store: TerminalStateStore,
        probe: Box<dyn ShellProbe>,
    ) -> Self {
        Self {
            inner: Arc::new(ManagerInner {
                registry,
                probe,
                live: Mutex::new(HashMap::new()),
                outputs: Mutex::new(HashMap::new()),
                event_sink: Mutex::new(None),
                state_store,
            }),
        }
    }

    /// Install the owner-scoped event forwarder. Called once from main.rs after
    /// the broker exists; the closure typically wraps `send_owner_event`.
    pub fn set_event_sink(&self, sink: EventSink) {
        *self
            .inner
            .event_sink
            .lock()
            .expect("terminal event sink lock") = Some(sink);
    }

    /// Dispatch a verified terminal command. `owner` and `workspace_root` are
    /// derived from the authenticated broker context, never from the payload.
    /// Returns a synchronous response value, or an error string surfaced to the
    /// sender as `terminal_command_failed`.
    pub fn dispatch(
        &self,
        owner: &OwnerId,
        workspace_root: &Path,
        payload: &Value,
    ) -> Result<Value, String> {
        let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "terminal_list" => self.list(owner, workspace_root),
            "terminal_create" => self.create(owner, workspace_root, payload),
            "terminal_input" => self.create_input(owner, workspace_root, payload),
            "terminal_resize" => self.resize(owner, workspace_root, payload),
            "terminal_checkpoint" => self.checkpoint(owner, workspace_root, payload),
            "terminal_ack" => self.ack(owner, workspace_root, payload),
            "terminal_close" => self.close(owner, workspace_root, payload),
            "terminal_restart" => self.restart(owner, workspace_root, payload),
            "terminal_activate" => self.activate(owner, workspace_root, payload),
            "terminal_reorder" => self.reorder(owner, workspace_root, payload),
            "terminal_set_panel_height" => {
                let height = payload
                    .get("heightPx")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "heightPx is required".to_string())?;
                let height =
                    u32::try_from(height).map_err(|_| "heightPx is out of range".to_string())?;
                self.set_panel_height(owner, workspace_root, height);
                Ok(json!({ "type": "terminal_command_acked" }))
            }
            other => Err(format!("unknown terminal command: {other}")),
        }
    }

    /// Terminate every live PTY owned by `owner` across all workspace roots.
    /// Called by the host when a native window is destroyed, before revoking
    /// the owner. Idempotent.
    #[cfg(test)]
    pub fn kill_owner(&self, owner: &OwnerId) {
        let leases = self.inner.registry.cleanup_owner(owner);
        for (key, lease) in leases {
            self.terminate_and_finish(&key, &lease);
        }
    }

    /// Terminate every live PTY bound to `workspace_root` across all owners.
    /// Called when a workspace window closes so its shell subprocesses are
    /// reaped alongside Pi and ACP agents. Idempotent.
    pub fn kill_workspace(&self, workspace_root: &Path) {
        let leases = self.inner.registry.cleanup_workspace(workspace_root);
        for (key, lease) in leases {
            self.terminate_and_finish(&key, &lease);
        }
    }

    /// Terminate every live PTY in every owner partition. Called on application
    /// exit. Idempotent.
    pub fn kill_all(&self) {
        let live: Vec<(String, LiveTerminal)> = {
            let mut live = self.inner.live.lock().expect("live lock");
            self.inner.outputs.lock().expect("outputs lock").clear();
            live.drain().collect()
        };
        for (terminal_id, lt) in live {
            let key = self.key(&lt.owner, &lt.workspace_root);
            let generation = lt.generation;
            kill_live_terminal(lt);
            let _ = self
                .inner
                .registry
                .finish_close(&key, &terminal_id, generation);
        }
    }

    fn key(&self, owner: &OwnerId, workspace_root: &Path) -> TerminalKey {
        TerminalKey {
            owner: owner.clone(),
            workspace_root: workspace_root.to_path_buf(),
        }
    }

    fn activate(
        &self,
        owner: &OwnerId,
        workspace_root: &Path,
        payload: &Value,
    ) -> Result<Value, String> {
        let terminal_id = payload
            .get("terminalId")
            .and_then(Value::as_str)
            .ok_or_else(|| "terminalId is required".to_string())?;
        let generation = payload
            .get("generation")
            .and_then(Value::as_u64)
            .ok_or_else(|| "generation is required".to_string())?;
        let descriptors = self
            .inner
            .registry
            .descriptors(&self.key(owner, workspace_root));
        let active_index = descriptors
            .iter()
            .position(|descriptor| {
                descriptor.terminal_id == terminal_id && descriptor.generation == generation
            })
            .ok_or_else(|| err_str_owned(TerminalError::UnknownTerminal))?;
        self.persist_with_active_index(owner, workspace_root, Some(active_index));
        Ok(json!({ "type": "terminal_command_acked" }))
    }

    fn reorder(
        &self,
        owner: &OwnerId,
        workspace_root: &Path,
        payload: &Value,
    ) -> Result<Value, String> {
        let ordered_terminal_ids = payload
            .get("orderedTerminalIds")
            .and_then(Value::as_array)
            .ok_or_else(|| "orderedTerminalIds is required".to_string())?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "orderedTerminalIds must contain strings".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let key = self.key(owner, workspace_root);
        let before = self.inner.registry.descriptors(&key);
        let previous = self
            .inner
            .state_store
            .load_for_workspace(workspace_root)
            .ok()
            .flatten();
        let active_terminal_id = previous
            .as_ref()
            .and_then(|metadata| metadata.active_index)
            .and_then(|index| before.get(index))
            .map(|descriptor| descriptor.terminal_id.clone());
        let panel_height_px = previous.and_then(|metadata| metadata.panel_height_px);
        self.inner
            .registry
            .reorder(&key, &ordered_terminal_ids)
            .map_err(err_str_owned)?;
        let active_index = active_terminal_id.and_then(|terminal_id| {
            self.inner
                .registry
                .descriptors(&key)
                .iter()
                .position(|descriptor| descriptor.terminal_id == terminal_id)
        });
        self.persist_with_metadata(owner, workspace_root, active_index, panel_height_px);
        Ok(json!({ "type": "terminal_command_acked" }))
    }

    fn persist(&self, owner: &OwnerId, workspace_root: &Path) {
        let previous = self
            .inner
            .state_store
            .load_for_workspace(workspace_root)
            .ok()
            .flatten();
        let active_index = previous.as_ref().and_then(|metadata| metadata.active_index);
        let panel_height_px = previous.and_then(|metadata| metadata.panel_height_px);
        self.persist_with_metadata(owner, workspace_root, active_index, panel_height_px);
    }

    fn persist_with_active_index(
        &self,
        owner: &OwnerId,
        workspace_root: &Path,
        active_index: Option<usize>,
    ) {
        let panel_height_px = self
            .inner
            .state_store
            .load_for_workspace(workspace_root)
            .ok()
            .flatten()
            .and_then(|value| value.panel_height_px);
        self.persist_with_metadata(owner, workspace_root, active_index, panel_height_px);
    }

    fn persist_with_metadata(
        &self,
        owner: &OwnerId,
        workspace_root: &Path,
        active_index: Option<usize>,
        panel_height_px: Option<u32>,
    ) {
        let key = self.key(owner, workspace_root);
        let descriptors = self.inner.registry.descriptors(&key);
        let default_profile = descriptors
            .first()
            .map_or_else(|| "default".to_string(), |d| d.profile_id.clone());
        let mut metadata = WorkspaceTerminalMetadata::new(&default_profile);
        metadata.tabs = descriptors
            .iter()
            .map(|d| PersistedTabDescriptor {
                label: d.label.clone(),
                profile_id: d.profile_id.clone(),
            })
            .collect();
        metadata.panel_height_px = panel_height_px;
        metadata.active_index = active_index.filter(|index| *index < metadata.tabs.len());
        if let Err(err) = self
            .inner
            .state_store
            .save_for_workspace(workspace_root, &metadata)
        {
            log::warn!("[terminal] failed to persist terminal state: {err:?}");
        }
    }

    /// Persist the panel height (terminal_set_panel_height command).
    fn set_panel_height(&self, owner: &OwnerId, workspace_root: &Path, height: u32) {
        let key = self.key(owner, workspace_root);
        let descriptors = self.inner.registry.descriptors(&key);
        let mut metadata = self
            .inner
            .state_store
            .load_for_workspace(workspace_root)
            .ok()
            .flatten()
            .unwrap_or_else(|| WorkspaceTerminalMetadata::new("default"));
        if !descriptors.is_empty() {
            metadata.default_profile_id = descriptors
                .first()
                .map_or_else(|| "default".to_string(), |d| d.profile_id.clone());
            metadata.tabs = descriptors
                .iter()
                .map(|d| PersistedTabDescriptor {
                    label: d.label.clone(),
                    profile_id: d.profile_id.clone(),
                })
                .collect();
        }
        metadata.panel_height_px = Some(height);
        if let Err(err) = self
            .inner
            .state_store
            .save_for_workspace(workspace_root, &metadata)
        {
            log::warn!("[terminal] failed to persist panel height: {err:?}");
        }
    }

    fn emit(&self, owner: &OwnerId, value: Value) {
        if let Some(sink) = self.inner.event_sink.lock().expect("sink lock").as_ref() {
            sink(owner, value);
        }
    }
}

fn err_str_owned(err: TerminalError) -> String {
    err_str(err).to_string()
}

fn label_for_profile(profile_id: &str) -> String {
    match profile_id {
        "git-bash" => "Git Bash".to_string(),
        "powershell" => "PowerShell".to_string(),
        "command-prompt" => "Command Prompt".to_string(),
        _ => "Terminal".to_string(),
    }
}

fn default_preferred_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| String::new())
}

fn decode_target_bytes(
    payload: &Value,
    max_bytes: usize,
) -> Result<(String, u64, Vec<u8>), String> {
    let terminal_id = payload
        .get("terminalId")
        .and_then(Value::as_str)
        .ok_or_else(|| "terminalId is required".to_string())?
        .to_string();
    let generation = payload
        .get("generation")
        .and_then(Value::as_u64)
        .ok_or_else(|| "generation is required".to_string())?;
    let data_b64 = payload
        .get("dataBase64")
        .and_then(Value::as_str)
        .ok_or_else(|| "dataBase64 is required".to_string())?;
    let bytes = BASE64
        .decode(data_b64)
        .map_err(|e| format!("invalid base64: {e}"))?;
    if bytes.len() > max_bytes {
        return Err(format!("payload exceeds {max_bytes} bytes"));
    }
    Ok((terminal_id, generation, bytes))
}
