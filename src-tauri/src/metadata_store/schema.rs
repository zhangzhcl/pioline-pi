// MetadataStore 数据库连接打开、Schema 迁移、历史运行事件归一化、设备配对与偏好设置读写。

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;
use uuid::Uuid;

use super::runs::serialize_workflow_run_without_events;
use super::{MetadataStore, SCHEMA_VERSION};

impl MetadataStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Cannot create Pipline metadata directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        let connection = Connection::open(path).map_err(|error| {
            format!(
                "Cannot open Pipline metadata database {}: {error}",
                path.display()
            )
        })?;
        let mut store = Self {
            connection,
            #[cfg(unix)]
            path: path.to_path_buf(),
        };
        store.migrate()?;
        store.normalize_legacy_workflow_run_events()?;
        store.mark_inflight_workflow_runs_interrupted()?;
        store.restrict_permissions()?;
        Ok(store)
    }

    pub(super) fn migrate(&mut self) -> Result<(), String> {
        let current: i64 = self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|error| format!("Cannot read Pipline metadata schema version: {error}"))?;
        if current > SCHEMA_VERSION {
            return Err(format!(
                "Pipline metadata schema {current} is newer than supported schema {SCHEMA_VERSION}"
            ));
        }
        if current == SCHEMA_VERSION {
            return Ok(());
        }
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Cannot start Pipline metadata migration: {error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS workspaces (
                    workspace_id TEXT PRIMARY KEY,
                    canonical_path TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL DEFAULT (unixepoch())
                );
                CREATE TABLE IF NOT EXISTS paired_devices (
                    device_id TEXT PRIMARY KEY,
                    token_hash BLOB NOT NULL UNIQUE,
                    paired_at INTEGER NOT NULL DEFAULT (unixepoch()),
                    revoked_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS preferences (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workflows (
                    workflow_id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL DEFAULT '',
                    revision INTEGER NOT NULL CHECK (revision >= 0),
                    workflow_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workflow_events (
                    workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL CHECK (revision > 0),
                    actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
                    idempotency_key TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    event_json TEXT NOT NULL,
                    PRIMARY KEY (workflow_id, revision),
                    UNIQUE (workflow_id, idempotency_key)
                );
                CREATE TABLE IF NOT EXISTS workflow_runs (
                    run_id TEXT PRIMARY KEY,
                    workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
                    workspace_id TEXT NOT NULL,
                    workflow_revision INTEGER NOT NULL CHECK (workflow_revision >= 0),
                    event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
                    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'error', 'cancelled', 'interrupted')),
                    run_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS workflow_runs_by_workflow ON workflow_runs(workflow_id, updated_at);
                CREATE TABLE IF NOT EXISTS workflow_run_events (
                    run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
                    sequence INTEGER NOT NULL CHECK (sequence > 0),
                    event_json TEXT NOT NULL,
                    PRIMARY KEY (run_id, sequence)
                );
                CREATE TABLE IF NOT EXISTS workflow_node_templates (
                    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
                    meta_id TEXT NOT NULL,
                    version TEXT NOT NULL,
                    meta_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (workspace_id, meta_id, version)
                );
                CREATE INDEX IF NOT EXISTS workflow_node_templates_by_workspace
                    ON workflow_node_templates(workspace_id, created_at);
                ",
            )
            .map_err(|error| format!("Cannot migrate Pipline metadata schema: {error}"))?;
        let has_workspace_column: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('workflows') WHERE name = 'workspace_id')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("Cannot inspect workflow schema: {error}"))?;
        if !has_workspace_column {
            transaction
                .execute(
                    "ALTER TABLE workflows ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''",
                    [],
                )
                .map_err(|error| format!("Cannot migrate workflow workspace ownership: {error}"))?;
        }
        transaction
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|error| format!("Cannot update Pipline metadata schema version: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit Pipline metadata migration: {error}"))
    }

    pub(super) fn normalize_legacy_workflow_run_events(&mut self) -> Result<(), String> {
        let mut statement = self
            .connection
            .prepare("SELECT run_id, run_json, event_sequence FROM workflow_runs")
            .map_err(|error| format!("Cannot prepare legacy workflow event query: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|error| format!("Cannot query legacy workflow events: {error}"))?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err(|error| format!("Cannot read legacy workflow run: {error}"))?);
        }
        drop(statement);

        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Cannot start legacy workflow event migration: {error}"))?;
        for (run_id, raw, event_sequence) in records {
            let mut run: Value = serde_json::from_str(&raw)
                .map_err(|error| format!("Stored workflow run JSON is invalid: {error}"))?;
            let Some(object) = run.as_object_mut() else {
                return Err("Stored workflow run must be an object".into());
            };
            let Some(legacy_events) = object.remove("events") else {
                continue;
            };
            let legacy_events = legacy_events
                .as_array()
                .ok_or("Stored workflow run events must be an array")?;
            let mut max_sequence = event_sequence;
            let mut seen_sequences = std::collections::HashSet::new();
            for event in legacy_events {
                let sequence = event
                    .get("sequence")
                    .and_then(Value::as_i64)
                    .filter(|sequence| *sequence > 0)
                    .ok_or("Stored workflow run event sequence is invalid")?;
                if event.get("runId").and_then(Value::as_str) != Some(run_id.as_str())
                    || !seen_sequences.insert(sequence)
                {
                    return Err("Stored workflow run event identity is invalid".into());
                }
                let event_raw = serde_json::to_string(event)
                    .map_err(|error| format!("Cannot encode legacy workflow event: {error}"))?;
                let stored_event: Option<String> = transaction
                    .query_row(
                        "SELECT event_json FROM workflow_run_events WHERE run_id = ?1 AND sequence = ?2",
                        params![run_id, sequence],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| format!("Cannot inspect existing workflow event: {error}"))?;
                if let Some(stored_event) = stored_event {
                    let stored_event: Value =
                        serde_json::from_str(&stored_event).map_err(|error| {
                            format!("Stored workflow run event JSON is invalid: {error}")
                        })?;
                    if stored_event != *event {
                        return Err(format!(
                            "Conflicting workflow run event at sequence {sequence}: {run_id}"
                        ));
                    }
                } else {
                    transaction
                        .execute(
                            "INSERT INTO workflow_run_events (run_id, sequence, event_json) VALUES (?1, ?2, ?3)",
                            params![run_id, sequence, event_raw],
                        )
                        .map_err(|error| format!("Cannot migrate legacy workflow event: {error}"))?;
                }
                max_sequence = max_sequence.max(sequence);
            }
            let normalized = serde_json::to_string(&run)
                .map_err(|error| format!("Cannot encode normalized workflow run: {error}"))?;
            transaction
                .execute(
                    "UPDATE workflow_runs SET event_sequence = ?1, run_json = ?2 WHERE run_id = ?3",
                    params![max_sequence, normalized, run_id],
                )
                .map_err(|error| format!("Cannot normalize workflow run events: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit legacy workflow event migration: {error}"))
    }

    pub(super) fn mark_inflight_workflow_runs_interrupted(&mut self) -> Result<(), String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT run_id, workflow_id, workspace_id, workflow_revision, event_sequence, run_json
                 FROM workflow_runs WHERE status IN ('queued', 'running')",
            )
            .map_err(|error| format!("Cannot prepare workflow recovery query: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|error| format!("Cannot query workflow recovery records: {error}"))?;
        let mut inflight = Vec::new();
        for row in rows {
            inflight.push(
                row.map_err(|error| format!("Cannot read workflow recovery record: {error}"))?,
            );
        }
        drop(statement);

        for (run_id, workflow_id, workspace_id, revision, sequence, raw) in inflight {
            let mut run: Value = serde_json::from_str(&raw)
                .map_err(|error| format!("Stored workflow run JSON is invalid: {error}"))?;
            let error = "Application exited while the workflow run was active.";
            let timestamp: String = self
                .connection
                .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
                    row.get(0)
                })
                .map_err(|error| format!("Cannot timestamp workflow run recovery: {error}"))?;
            run["status"] = Value::from("interrupted");
            run["error"] = Value::from(error);
            run["updatedAt"] = Value::from(timestamp.clone());
            if let Some(states) = run.get_mut("nodeStates").and_then(Value::as_object_mut) {
                for state in states.values_mut() {
                    if state.get("status").and_then(Value::as_str) == Some("running") {
                        state["status"] = Value::from("interrupted");
                        state["error"] = Value::from(error);
                    }
                }
            }
            let next_sequence = sequence
                .checked_add(1)
                .ok_or("Workflow run event sequence is exhausted")?;
            let event = serde_json::json!({
                "id": format!("{run_id}:{next_sequence}"),
                "runId": run_id,
                "workflowId": workflow_id,
                "revision": revision,
                "type": "run_interrupted",
                "timestamp": timestamp,
                "sequence": next_sequence,
                "error": error,
                "skippedNodeIds": []
            });
            let run_raw = serialize_workflow_run_without_events(&run)?;
            let event_raw = serde_json::to_string(&event)
                .map_err(|error| format!("Cannot encode workflow recovery event: {error}"))?;
            let transaction = self
                .connection
                .transaction()
                .map_err(|error| format!("Cannot start workflow run recovery: {error}"))?;
            let updated = transaction
                .execute(
                    "UPDATE workflow_runs SET event_sequence = ?1, status = 'interrupted', run_json = ?2, updated_at = ?3
                     WHERE run_id = ?4 AND workspace_id = ?5 AND event_sequence = ?6
                       AND status IN ('queued', 'running')",
                    params![next_sequence, run_raw, timestamp, run_id, workspace_id, sequence],
                )
                .map_err(|error| format!("Cannot mark workflow run interrupted: {error}"))?;
            if updated != 1 {
                transaction.rollback().map_err(|error| {
                    format!("Cannot roll back stale workflow run recovery: {error}")
                })?;
                return Err(format!("Workflow run recovery lost its revision: {run_id}"));
            }
            transaction
                .execute(
                    "INSERT INTO workflow_run_events (run_id, sequence, event_json) VALUES (?1, ?2, ?3)",
                    params![run_id, next_sequence, event_raw],
                )
                .map_err(|error| format!("Cannot append workflow recovery event: {error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("Cannot commit workflow run recovery: {error}"))?;
        }
        Ok(())
    }

    #[cfg(unix)]
    pub(super) fn restrict_permissions(&self) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| {
                format!(
                    "Cannot restrict metadata permissions {}: {error}",
                    self.path.display()
                )
            },
        )
    }

    #[cfg(not(unix))]
    pub(super) fn restrict_permissions(&self) -> Result<(), String> {
        Ok(())
    }

    #[cfg(test)]
    pub fn schema_version(&self) -> Result<i64, String> {
        self.connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|error| format!("Cannot read Pipline metadata schema version: {error}"))
    }

    pub fn workspace_id_for_path(&self, workspace: &Path) -> Result<String, String> {
        let canonical = workspace.canonicalize().map_err(|error| {
            format!("Cannot resolve workspace {}: {error}", workspace.display())
        })?;
        let canonical = canonical.to_string_lossy();
        if let Some(id) = self
            .connection
            .query_row(
                "SELECT workspace_id FROM workspaces WHERE canonical_path = ?1",
                [canonical.as_ref()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Cannot query workspace metadata: {error}"))?
        {
            return Ok(id);
        }
        let id = Uuid::new_v4().to_string();
        self.connection
            .execute(
                "INSERT INTO workspaces (workspace_id, canonical_path) VALUES (?1, ?2)",
                params![id, canonical.as_ref()],
            )
            .map_err(|error| format!("Cannot store workspace metadata: {error}"))?;
        Ok(id)
    }

    pub fn store_device_token(&self, device_id: &str, token: &str) -> Result<(), String> {
        let token_hash = token_hash(token);
        self.connection
            .execute(
                "INSERT INTO paired_devices (device_id, token_hash, revoked_at)
                 VALUES (?1, ?2, NULL)
                 ON CONFLICT(device_id) DO UPDATE SET
                   token_hash = excluded.token_hash,
                   paired_at = unixepoch(),
                   revoked_at = NULL",
                params![device_id, token_hash],
            )
            .map_err(|error| format!("Cannot store paired device: {error}"))?;
        Ok(())
    }

    pub fn verify_device_token(&self, token: &str) -> Result<bool, String> {
        let token_hash = token_hash(token);
        self.connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM paired_devices WHERE token_hash = ?1 AND revoked_at IS NULL
                )",
                [token_hash],
                |row| row.get(0),
            )
            .map_err(|error| format!("Cannot verify paired device: {error}"))
    }

    #[cfg(test)]
    pub fn revoke_device(&self, device_id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE paired_devices SET revoked_at = unixepoch() WHERE device_id = ?1",
                [device_id],
            )
            .map_err(|error| format!("Cannot revoke paired device: {error}"))?;
        Ok(())
    }

    #[cfg(test)]
    pub fn reset(&mut self) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Cannot start metadata reset: {error}"))?;
        transaction
            .execute_batch(
                "DELETE FROM workflow_events; DELETE FROM workflows; DELETE FROM workspaces;
                 DELETE FROM paired_devices; DELETE FROM preferences;",
            )
            .map_err(|error| format!("Cannot reset Pipline metadata: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit Pipline metadata reset: {error}"))
    }

    pub fn preference_get(&self, key: &str) -> Result<Option<Value>, String> {
        let raw: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM preferences WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Cannot read preference: {error}"))?;
        raw.map(|raw| {
            serde_json::from_str(&raw)
                .map_err(|error| format!("Invalid stored preference: {error}"))
        })
        .transpose()
    }

    pub fn preference_set(&self, key: &str, value: &Value) -> Result<(), String> {
        let raw = serde_json::to_string(value)
            .map_err(|error| format!("Cannot encode preference: {error}"))?;
        self.connection
            .execute(
                "INSERT INTO preferences (key, value_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
                params![key, raw],
            )
            .map_err(|error| format!("Cannot save preference: {error}"))?;
        Ok(())
    }

    pub fn preference_remove(&self, key: &str) -> Result<bool, String> {
        let removed = self
            .connection
            .execute("DELETE FROM preferences WHERE key = ?1", [key])
            .map_err(|error| format!("Cannot remove preference: {error}"))?;
        Ok(removed > 0)
    }
}

fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}
