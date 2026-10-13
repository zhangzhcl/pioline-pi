// ABOUTME: Implements terminal command handlers (list, create, input, resize,
// ABOUTME: checkpoint, ack, close, restart) on TerminalManager.

use std::io::Write;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::PtySize;
use serde_json::{json, Value};

use crate::terminal_output::{TerminalLimits, TerminalOutputStore};
use crate::terminal_registry::{TerminalDescriptor, TerminalError, TerminalStatus};
use crate::terminal_state_store::WorkspaceTerminalMetadata;
use crate::window_owner::OwnerId;

use super::{
    decode_target_bytes, err_str_owned, label_for_profile, TerminalManager, CHECKPOINT_MAX_BYTES,
    INPUT_MAX_BYTES,
};

impl TerminalManager {
    pub(super) fn list(&self, owner: &OwnerId, workspace_root: &Path) -> Result<Value, String> {
        let key = self.key(owner, workspace_root);
        let descriptors = self.inner.registry.descriptors(&key);
        let persisted = self
            .inner
            .state_store
            .load_for_workspace(workspace_root)
            .ok()
            .flatten();
        let tabs: Vec<Value> = if descriptors.is_empty() {
            // Fresh owner/partition (new app run): surface persisted tab metadata
            // so the panel can re-create fresh shells. Live PTYs are never restored.
            self.restored_metadata(persisted.as_ref())
        } else {
            self.live_tab_descriptors(&descriptors)
        };
        Ok(json!({
            "type": "terminal_listed",
            "tabs": tabs,
            "panelHeightPx": persisted.as_ref().and_then(|meta| meta.panel_height_px),
            "activeIndex": persisted.as_ref().and_then(|meta| meta.active_index),
        }))
    }

    /// Surface persisted tab metadata (label/profile) for a fresh app run so the
    /// panel can re-create fresh shells. Live PTYs/checkpoints are never restored.
    fn restored_metadata(&self, metadata: Option<&WorkspaceTerminalMetadata>) -> Vec<Value> {
        metadata
            .into_iter()
            .flat_map(|meta| meta.tabs.iter().enumerate())
            .map(|(index, t)| {
                json!({
                    "terminalId": format!("restored-{index}"),
                    "generation": 0,
                    "status": TerminalStatus::RestoredMetadata,
                    "profileId": t.profile_id,
                    "label": t.label,
                })
            })
            .collect()
    }

    fn live_tab_descriptors(&self, descriptors: &[TerminalDescriptor]) -> Vec<Value> {
        let outputs = self.inner.outputs.lock().expect("outputs lock");
        descriptors
            .iter()
            .map(|d| {
                let output = outputs.get(&d.terminal_id);
                json!({
                    "terminalId": d.terminal_id,
                    "generation": d.generation,
                    "status": d.status,
                    "profileId": d.profile_id,
                    "label": d.label,
                    "exitCode": d.exit_code,
                    "failReason": d.fail_reason,
                    "checkpoint": output.and_then(|o| o.checkpoint()).map(|b| BASE64.encode(b)),
                    "checkpointWatermark": output.map_or(0, TerminalOutputStore::checkpoint_watermark),
                    "historyGap": output.is_some_and(TerminalOutputStore::history_gap),
                    "journal": output.and_then(|o| {
                        let wm = o.checkpoint_watermark();
                        o.journal_from(wm).map(|batch| json!({
                            "firstSequence": batch.first_sequence,
                            "lastSequence": batch.last_sequence,
                            "dataBase64": BASE64.encode(&batch.bytes),
                        }))
                    }),
                })
            })
            .collect()
    }

    pub(super) fn create(
        &self,
        owner: &OwnerId,
        workspace_root: &Path,
        payload: &Value,
    ) -> Result<Value, String> {
        let profile_id = payload
            .get("profileId")
            .and_then(Value::as_str)
            .unwrap_or("default");
        let key = self.key(owner, workspace_root);
        let label = label_for_profile(profile_id);
        let reservation = self
            .inner
            .registry
            .reserve_tab_with_profile(&key, profile_id, label)
            .map_err(err_str_owned)?;

        let shell = match self.resolve_shell(profile_id) {
            Ok(shell) => shell,
            Err(reason) => {
                let _ = self.inner.registry.mark_failed(
                    &key,
                    &reservation.terminal_id,
                    reservation.generation,
                    reason.clone(),
                );
                return Err(reason);
            }
        };

        let spawned = match self.spawn_pty_for_profile(profile_id, &shell, workspace_root) {
            Ok(s) => s,
            Err(reason) => {
                let _ = self.inner.registry.mark_failed(
                    &key,
                    &reservation.terminal_id,
                    reservation.generation,
                    reason.clone(),
                );
                return Err(reason);
            }
        };

        if let Err(err) = self.inner.registry.commit_running(
            &key,
            &reservation.terminal_id,
            reservation.generation,
        ) {
            let reason = err_str_owned(err);
            let _ = self.inner.registry.mark_failed(
                &key,
                &reservation.terminal_id,
                reservation.generation,
                reason.clone(),
            );
            // The spawned PTY must not leak when commit fails (e.g. global quota).
            self.detach_spawned(spawned);
            return Err(reason);
        }

        self.attach_spawned(
            owner.clone(),
            workspace_root.to_path_buf(),
            reservation.terminal_id.clone(),
            reservation.generation,
            profile_id.to_string(),
            spawned,
        );
        self.persist(owner, workspace_root);
        Ok(json!({
            "type": "terminal_created",
            "terminalId": reservation.terminal_id,
            "generation": reservation.generation,
        }))
    }

    pub(super) fn create_input(
        &self,
        owner: &OwnerId,
        workspace_root: &Path,
        payload: &Value,
    ) -> Result<Value, String> {
        let (terminal_id, generation, bytes) = decode_target_bytes(payload, INPUT_MAX_BYTES)?;
        let key = self.key(owner, workspace_root);
        self.inner
            .registry
            .require_running(&key, &terminal_id, generation)
            .map_err(err_str_owned)?;
        {
            let mut live = self.inner.live.lock().expect("live lock");
            let lt = live
                .get_mut(&terminal_id)
                .ok_or_else(|| "terminal is not running".to_string())?;
            if lt.generation != generation {
                return Err(err_str_owned(TerminalError::StaleGeneration));
            }
            lt.writer
                .write_all(&bytes)
                .map_err(|e| format!("terminal write failed: {e}"))?;
            lt.writer
                .flush()
                .map_err(|e| format!("terminal flush failed: {e}"))?;
        }
        Ok(json!({ "type": "terminal_input_acked", "terminalId": terminal_id }))
    }

    pub(super) fn resize(
        &self,
        owner: &OwnerId,
        workspace_root: &Path,
        payload: &Value,
    ) -> Result<Value, String> {
        let terminal_id = payload
            .get("terminalId")
            .and_then(Value::as_str)
            .ok_or_else(|| "terminalId is required".to_string())?
            .to_string();
        let generation = payload
            .get("generation")
            .and_then(Value::as_u64)
            .ok_or_else(|| "generation is required".to_string())?;
        let cols_raw = payload
            .get("cols")
            .and_then(Value::as_u64)
            .ok_or_else(|| "cols is required".to_string())?;
        let rows_raw = payload
            .get("rows")
            .and_then(Value::as_u64)
            .ok_or_else(|| "rows is required".to_string())?;
        // Validate the full range before truncating to u16: `as u16` would
        // silently wrap oversized values (e.g. 65536 -> 0).
        if cols_raw == 0
            || rows_raw == 0
            || cols_raw > u16::MAX as u64
            || rows_raw > u16::MAX as u64
        {
            return Err("terminal dimensions out of range".to_string());
        }
        let cols = cols_raw as u16;
        let rows = rows_raw as u16;
        let key = self.key(owner, workspace_root);
        self.inner
            .registry
            .require_running(&key, &terminal_id, generation)
            .map_err(err_str_owned)?;
        {
            let mut live = self.inner.live.lock().expect("live lock");
            let lt = live
                .get_mut(&terminal_id)
                .ok_or_else(|| "terminal is not running".to_string())?;
            if lt.generation != generation {
                return Err(err_str_owned(TerminalError::StaleGeneration));
            }
            lt.master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("terminal resize failed: {e}"))?;
        }
        Ok(json!({ "type": "terminal_resized", "terminalId": terminal_id }))
    }

    pub(super) fn checkpoint(
        &self,
        owner: &OwnerId,
        workspace_root: &Path,
        payload: &Value,
    ) -> Result<Value, String> {
        let (terminal_id, generation, snapshot) =
            decode_target_bytes(payload, CHECKPOINT_MAX_BYTES)?;
        let watermark = payload
            .get("watermark")
            .and_then(Value::as_u64)
            .ok_or_else(|| "watermark is required".to_string())?;
        let key = self.key(owner, workspace_root);
        self.inner
            .registry
            .require_running(&key, &terminal_id, generation)
            .map_err(err_str_owned)?;
        {
            let mut outputs = self.inner.outputs.lock().expect("outputs lock");
            let output = outputs
                .entry(terminal_id.clone())
                .or_insert_with(|| TerminalOutputStore::new(TerminalLimits::default()));
            output
                .accept_checkpoint(watermark, snapshot)
                .map_err(|e| format!("checkpoint rejected: {e:?}"))?;
        }
        Ok(json!({ "type": "terminal_checkpoint_acked", "terminalId": terminal_id }))
    }

    pub(super) fn ack(
        &self,
        owner: &OwnerId,
        workspace_root: &Path,
        payload: &Value,
    ) -> Result<Value, String> {
        let terminal_id = payload
            .get("terminalId")
            .and_then(Value::as_str)
            .ok_or_else(|| "terminalId is required".to_string())?
            .to_string();
        let generation = payload
            .get("generation")
            .and_then(Value::as_u64)
            .ok_or_else(|| "generation is required".to_string())?;
        let sequence = payload
            .get("sequence")
            .and_then(Value::as_u64)
            .ok_or_else(|| "sequence is required".to_string())?;
        let key = self.key(owner, workspace_root);
        self.inner
            .registry
            .require_running(&key, &terminal_id, generation)
            .map_err(err_str_owned)?;
        {
            let mut outputs = self.inner.outputs.lock().expect("outputs lock");
            if let Some(output) = outputs.get_mut(&terminal_id) {
                output.ack(sequence);
            }
        }
        Ok(json!({ "type": "terminal_ack_acked", "terminalId": terminal_id }))
    }

    pub(super) fn close(
        &self,
        owner: &OwnerId,
        workspace_root: &Path,
        payload: &Value,
    ) -> Result<Value, String> {
        let terminal_id = payload
            .get("terminalId")
            .and_then(Value::as_str)
            .ok_or_else(|| "terminalId is required".to_string())?
            .to_string();
        let generation = payload
            .get("generation")
            .and_then(Value::as_u64)
            .ok_or_else(|| "generation is required".to_string())?;
        let key = self.key(owner, workspace_root);
        let lease = self
            .inner
            .registry
            .begin_close(&key, &terminal_id, generation)
            .map_err(err_str_owned)?;
        self.terminate_and_finish(&key, &lease);
        self.persist(owner, workspace_root);
        Ok(json!({ "type": "terminal_closed", "terminalId": terminal_id }))
    }

    pub(super) fn restart(
        &self,
        owner: &OwnerId,
        workspace_root: &Path,
        payload: &Value,
    ) -> Result<Value, String> {
        let terminal_id = payload
            .get("terminalId")
            .and_then(Value::as_str)
            .ok_or_else(|| "terminalId is required".to_string())?
            .to_string();
        let generation = payload
            .get("generation")
            .and_then(Value::as_u64)
            .ok_or_else(|| "generation is required".to_string())?;
        let requested_profile = payload
            .get("profileId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let key = self.key(owner, workspace_root);
        let previous_profile = self
            .inner
            .live
            .lock()
            .expect("live lock")
            .get(&terminal_id)
            .filter(|live| live.generation == generation)
            .map(|live| live.profile_id.clone());
        let profile_id = requested_profile
            .or(previous_profile)
            .unwrap_or_else(|| "default".to_string());
        // Validate the requested profile before transitioning the existing tab.
        let shell = self.resolve_shell(&profile_id)?;
        let handle = self
            .inner
            .registry
            .restart(
                &key,
                &terminal_id,
                generation,
                &profile_id,
                label_for_profile(&profile_id),
            )
            .map_err(err_str_owned)?;

        self.replace_generation(&terminal_id, generation);
        let spawned = self
            .spawn_pty_for_profile(&profile_id, &shell, workspace_root)
            .inspect_err(|reason| {
                let _ = self.inner.registry.mark_failed(
                    &key,
                    &terminal_id,
                    handle.generation,
                    reason.clone(),
                );
            })?;
        if let Err(error) =
            self.inner
                .registry
                .commit_running(&key, &terminal_id, handle.generation)
        {
            self.detach_spawned(spawned);
            let reason = err_str_owned(error);
            if !matches!(error, TerminalError::NotCreating) {
                let _ = self.inner.registry.mark_failed(
                    &key,
                    &terminal_id,
                    handle.generation,
                    reason.clone(),
                );
            }
            return Err(reason);
        }
        self.attach_spawned(
            owner.clone(),
            workspace_root.to_path_buf(),
            terminal_id.clone(),
            handle.generation,
            profile_id,
            spawned,
        );
        self.persist(owner, workspace_root);
        Ok(json!({
            "type": "terminal_restarted",
            "terminalId": terminal_id,
            "generation": handle.generation,
        }))
    }
}
