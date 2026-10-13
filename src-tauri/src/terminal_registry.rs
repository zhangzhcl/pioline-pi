// ABOUTME: Owner-scoped terminal ownership: workspace tab quota, global live-PTY
// ABOUTME: quota, generation-checked state transitions, and redacted descriptors.
// ABOUTME: The partition key is (owner, canonical workspace root), never workspace generation.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rand::rngs::OsRng;
use rand::RngCore;
use serde::Serialize;

use crate::window_owner::OwnerId;

#[cfg(test)]
mod tests;

pub const WORKSPACE_TAB_QUOTA: usize = 5;
const TERMINAL_ID_BYTES: usize = 12;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct TerminalKey {
    pub owner: OwnerId,
    pub workspace_root: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TerminalHandle {
    pub terminal_id: String,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalStatus {
    RestoredMetadata,
    Creating,
    Running,
    Exited,
    Failed,
    Closing,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDescriptor {
    pub terminal_id: String,
    pub generation: u64,
    pub status: TerminalStatus,
    pub profile_id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fail_reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalReservation {
    pub terminal_id: String,
    pub generation: u64,
    pub profile_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloseLease {
    pub terminal_id: String,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalError {
    WorkspaceTabQuota,
    GlobalProcessQuota,
    UnknownTerminal,
    StaleGeneration,
    NotCreating,
    NotRunning,
    AlreadyClosing,
    InvalidTabOrder,
}

pub fn err_str(err: TerminalError) -> &'static str {
    match err {
        TerminalError::WorkspaceTabQuota => "workspace terminal tab quota reached",
        TerminalError::GlobalProcessQuota => "global live terminal quota reached",
        TerminalError::UnknownTerminal => "unknown terminal",
        TerminalError::StaleGeneration => "stale terminal generation",
        TerminalError::NotCreating => "terminal is not creating",
        TerminalError::NotRunning => "terminal is not running",
        TerminalError::AlreadyClosing => "terminal is already closing",
        TerminalError::InvalidTabOrder => "terminal tab order is invalid",
    }
}

#[derive(Clone, Default)]
pub struct TerminalRegistry {
    inner: Arc<Mutex<RegistryState>>,
    global_process_quota: usize,
}

#[derive(Default)]
struct RegistryState {
    partitions: HashMap<TerminalKey, Partition>,
}

impl RegistryState {
    fn record_mut(
        &mut self,
        key: &TerminalKey,
        terminal_id: &str,
        generation: u64,
    ) -> Result<&mut Record, TerminalError> {
        self.partitions
            .get_mut(key)
            .and_then(|partition| partition.find_mut(terminal_id, generation))
            .ok_or(TerminalError::UnknownTerminal)
    }
}

#[derive(Default)]
struct Partition {
    records: Vec<Record>,
    next_generation: u64,
}

impl Partition {
    fn allocate_generation(&mut self) -> u64 {
        self.next_generation += 1;
        self.next_generation
    }

    fn find_mut(&mut self, terminal_id: &str, generation: u64) -> Option<&mut Record> {
        self.records
            .iter_mut()
            .find(|r| r.terminal_id == terminal_id && r.generation == generation)
    }

    fn non_closing_count(&self) -> usize {
        self.records
            .iter()
            .filter(|r| r.status != TerminalStatus::Closing)
            .count()
    }
}

struct Record {
    terminal_id: String,
    generation: u64,
    status: TerminalStatus,
    profile_id: String,
    label: String,
    exit_code: Option<i32>,
    fail_reason: Option<String>,
}

impl Record {
    fn descriptor(&self) -> TerminalDescriptor {
        TerminalDescriptor {
            terminal_id: self.terminal_id.clone(),
            generation: self.generation,
            status: self.status,
            profile_id: self.profile_id.clone(),
            label: self.label.clone(),
            exit_code: self.exit_code,
            fail_reason: self.fail_reason.clone(),
        }
    }
}

impl TerminalRegistry {
    pub fn new(global_process_quota: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryState::default())),
            global_process_quota,
        }
    }

    #[cfg(test)]
    pub fn live_reservations(&self) -> usize {
        let state = self.inner.lock().expect("terminal registry lock poisoned");
        self.live_reservations_locked(&state)
    }

    #[cfg(test)]
    pub fn reserve_tab(&self, key: &TerminalKey) -> Result<TerminalReservation, TerminalError> {
        self.reserve_tab_with_profile(key, "default", "Terminal".to_string())
    }

    pub fn reserve_tab_with_profile(
        &self,
        key: &TerminalKey,
        profile_id: &str,
        label: String,
    ) -> Result<TerminalReservation, TerminalError> {
        let mut state = self.inner.lock().expect("terminal registry lock poisoned");
        if self.live_reservations_locked(&state) >= self.global_process_quota {
            return Err(TerminalError::GlobalProcessQuota);
        }
        let partition = state.partitions.entry(key.clone()).or_default();
        if partition.non_closing_count() >= WORKSPACE_TAB_QUOTA {
            return Err(TerminalError::WorkspaceTabQuota);
        }
        let terminal_id = fresh_terminal_id();
        let generation = partition.allocate_generation();
        partition.records.push(Record {
            terminal_id: terminal_id.clone(),
            generation,
            status: TerminalStatus::Creating,
            profile_id: profile_id.to_string(),
            label,
            exit_code: None,
            fail_reason: None,
        });
        Ok(TerminalReservation {
            terminal_id,
            generation,
            profile_id: profile_id.to_string(),
        })
    }

    pub fn commit_running(
        &self,
        key: &TerminalKey,
        terminal_id: &str,
        generation: u64,
    ) -> Result<TerminalHandle, TerminalError> {
        let mut state = self.inner.lock().expect("terminal registry lock poisoned");
        let record = state.record_mut(key, terminal_id, generation)?;
        if record.status != TerminalStatus::Creating {
            return Err(TerminalError::NotCreating);
        }
        record.status = TerminalStatus::Running;
        drop(state);
        Ok(TerminalHandle {
            terminal_id: terminal_id.to_string(),
            generation,
        })
    }

    pub fn mark_failed(
        &self,
        key: &TerminalKey,
        terminal_id: &str,
        generation: u64,
        reason: String,
    ) -> Result<(), TerminalError> {
        let mut state = self.inner.lock().expect("terminal registry lock poisoned");
        let record = state.record_mut(key, terminal_id, generation)?;
        record.status = TerminalStatus::Failed;
        record.fail_reason = Some(reason);
        Ok(())
    }

    pub fn mark_exited(
        &self,
        key: &TerminalKey,
        terminal_id: &str,
        generation: u64,
        exit_code: Option<i32>,
    ) -> Result<(), TerminalError> {
        let mut state = self.inner.lock().expect("terminal registry lock poisoned");
        let record = state.record_mut(key, terminal_id, generation)?;
        if record.status != TerminalStatus::Running {
            return Err(TerminalError::NotRunning);
        }
        record.status = TerminalStatus::Exited;
        record.exit_code = exit_code;
        Ok(())
    }

    pub fn restart(
        &self,
        key: &TerminalKey,
        terminal_id: &str,
        generation: u64,
        profile_id: &str,
        label: String,
    ) -> Result<TerminalHandle, TerminalError> {
        let mut state = self.inner.lock().expect("terminal registry lock poisoned");
        let live_count = self.live_reservations_locked(&state);
        let partition = state
            .partitions
            .get_mut(key)
            .ok_or(TerminalError::UnknownTerminal)?;
        let idx = partition
            .records
            .iter()
            .position(|r| r.terminal_id == terminal_id && r.generation == generation)
            .ok_or(TerminalError::UnknownTerminal)?;
        let old_status = partition.records[idx].status;
        if old_status == TerminalStatus::Closing {
            return Err(TerminalError::AlreadyClosing);
        }
        let is_live = matches!(
            old_status,
            TerminalStatus::Creating | TerminalStatus::Running
        );
        if !is_live && live_count >= self.global_process_quota {
            return Err(TerminalError::GlobalProcessQuota);
        }
        let new_generation = partition.allocate_generation();
        let record = &mut partition.records[idx];
        record.generation = new_generation;
        record.status = TerminalStatus::Creating;
        record.profile_id = profile_id.to_string();
        record.label = label;
        record.exit_code = None;
        record.fail_reason = None;
        drop(state);
        Ok(TerminalHandle {
            terminal_id: terminal_id.to_string(),
            generation: new_generation,
        })
    }

    pub fn reorder(
        &self,
        key: &TerminalKey,
        ordered_terminal_ids: &[String],
    ) -> Result<(), TerminalError> {
        let mut state = self.inner.lock().expect("terminal registry lock poisoned");
        let partition = state
            .partitions
            .get_mut(key)
            .ok_or(TerminalError::UnknownTerminal)?;
        if ordered_terminal_ids.len() != partition.records.len() {
            return Err(TerminalError::InvalidTabOrder);
        }
        let mut records = std::mem::take(&mut partition.records);
        let mut ordered = Vec::with_capacity(records.len());
        for terminal_id in ordered_terminal_ids {
            let Some(idx) = records.iter().position(|r| r.terminal_id == *terminal_id) else {
                records.extend(ordered);
                partition.records = records;
                return Err(TerminalError::InvalidTabOrder);
            };
            ordered.push(records.remove(idx));
        }
        partition.records = ordered;
        Ok(())
    }

    pub fn require_running(
        &self,
        key: &TerminalKey,
        terminal_id: &str,
        generation: u64,
    ) -> Result<TerminalHandle, TerminalError> {
        let state = self.inner.lock().expect("terminal registry lock poisoned");
        let partition = state
            .partitions
            .get(key)
            .ok_or(TerminalError::UnknownTerminal)?;
        let record = partition
            .records
            .iter()
            .find(|r| r.terminal_id == terminal_id)
            .ok_or(TerminalError::UnknownTerminal)?;
        if record.generation != generation {
            return Err(TerminalError::StaleGeneration);
        }
        if record.status != TerminalStatus::Running {
            return Err(TerminalError::NotRunning);
        }
        drop(state);
        Ok(TerminalHandle {
            terminal_id: terminal_id.to_string(),
            generation,
        })
    }

    pub fn begin_close(
        &self,
        key: &TerminalKey,
        terminal_id: &str,
        generation: u64,
    ) -> Result<CloseLease, TerminalError> {
        let mut state = self.inner.lock().expect("terminal registry lock poisoned");
        let record = state.record_mut(key, terminal_id, generation)?;
        if record.status == TerminalStatus::Closing {
            return Err(TerminalError::AlreadyClosing);
        }
        record.status = TerminalStatus::Closing;
        drop(state);
        Ok(CloseLease {
            terminal_id: terminal_id.to_string(),
            generation,
        })
    }

    pub fn finish_close(
        &self,
        key: &TerminalKey,
        terminal_id: &str,
        generation: u64,
    ) -> Result<(), TerminalError> {
        let mut state = self.inner.lock().expect("terminal registry lock poisoned");
        let Some(partition) = state.partitions.get_mut(key) else {
            return Ok(());
        };
        if let Some(idx) = partition
            .records
            .iter()
            .position(|r| r.terminal_id == terminal_id && r.generation == generation)
        {
            partition.records.remove(idx);
        }
        Ok(())
    }

    pub fn descriptors(&self, key: &TerminalKey) -> Vec<TerminalDescriptor> {
        let state = self.inner.lock().expect("terminal registry lock poisoned");
        let Some(partition) = state.partitions.get(key) else {
            return Vec::new();
        };
        let descriptors = partition.records.iter().map(Record::descriptor).collect();
        drop(state);
        descriptors
    }

    #[cfg(test)]
    pub fn cleanup_owner(&self, owner: &OwnerId) -> Vec<(TerminalKey, CloseLease)> {
        self.cleanup_matching(|key| &key.owner == owner)
    }

    pub fn cleanup_workspace(&self, workspace_root: &Path) -> Vec<(TerminalKey, CloseLease)> {
        self.cleanup_matching(|key| key.workspace_root == workspace_root)
    }

    fn cleanup_matching(
        &self,
        predicate: impl Fn(&TerminalKey) -> bool,
    ) -> Vec<(TerminalKey, CloseLease)> {
        let mut state = self.inner.lock().expect("terminal registry lock poisoned");
        let mut leases = Vec::new();
        for (key, partition) in &mut state.partitions {
            if !predicate(key) {
                continue;
            }
            for record in &mut partition.records {
                if record.status == TerminalStatus::Closing {
                    continue;
                }
                record.status = TerminalStatus::Closing;
                leases.push((
                    key.clone(),
                    CloseLease {
                        terminal_id: record.terminal_id.clone(),
                        generation: record.generation,
                    },
                ));
            }
        }
        drop(state);
        leases
    }

    fn live_reservations_locked(&self, state: &RegistryState) -> usize {
        state
            .partitions
            .values()
            .flat_map(|p| p.records.iter())
            .filter(|r| {
                matches!(
                    r.status,
                    TerminalStatus::Creating | TerminalStatus::Running | TerminalStatus::Closing
                )
            })
            .count()
    }
}

fn fresh_terminal_id() -> String {
    use std::fmt::Write as _;
    let mut bytes = [0u8; TERMINAL_ID_BYTES];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().fold(
        String::with_capacity(TERMINAL_ID_BYTES * 2),
        |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        },
    )
}
