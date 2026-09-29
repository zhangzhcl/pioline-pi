#![cfg_attr(not(test), allow(dead_code))]

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
use uuid::Uuid;

#[path = "metadata_store/workflow_edge_validation.rs"]
mod workflow_edge_validation;
#[path = "metadata_store/workflow_run_read_validation.rs"]
mod workflow_run_read_validation;
#[path = "metadata_store/workflow_snapshot_validation.rs"]
mod workflow_snapshot_validation;
#[path = "metadata_store/workflow_validation.rs"]
mod workflow_validation;
use workflow_validation::{
    builtin_node_metas, validate_custom_node_contracts, validate_workflow_structure,
};

const SCHEMA_VERSION: i64 = 5;
const MAX_WORKFLOW_RUN_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_WORKFLOW_RUN_EVENT_JSON_BYTES: usize = 1024 * 1024;
const MAX_WORKFLOW_NODE_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_WORKFLOW_RUN_EVENT_COUNT: i64 = 10_000;
const TERMINAL_WORKFLOW_RUN_EVENT_RESERVE: i64 = 8;
const MAX_WORKFLOW_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_WORKFLOW_EVENT_JSON_BYTES: usize = 1024 * 1024;

pub struct MetadataStore {
    connection: Connection,
    #[cfg(unix)]
    path: PathBuf,
}

impl MetadataStore {
    fn validate_workflow_node_contracts(
        &self,
        workspace_id: &str,
        workflow: &Value,
    ) -> Result<(), String> {
        let mut templates = builtin_node_metas();
        for node in workflow
            .get("nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = node.pointer("/meta/id").and_then(Value::as_str) else {
                continue;
            };
            if !id.starts_with("custom.") {
                continue;
            }
            let version = node
                .pointer("/meta/version")
                .and_then(Value::as_str)
                .ok_or("Workflow custom node version is invalid")?;
            let key = format!("{id}@{version}");
            if templates.contains_key(&key) {
                continue;
            }
            let raw: Option<String> = self
                .connection
                .query_row(
                    "SELECT meta_json FROM workflow_node_templates WHERE workspace_id = ?1 AND meta_id = ?2 AND version = ?3",
                    params![workspace_id, id, version],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("Cannot load workflow NodeMeta {key}: {error}"))?;
            if let Some(raw) = raw {
                let meta = serde_json::from_str(&raw).map_err(|error| {
                    format!("Stored workflow NodeMeta {key} is invalid: {error}")
                })?;
                templates.insert(key, meta);
            }
        }
        validate_custom_node_contracts(workflow, &templates)
    }

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

    fn migrate(&mut self) -> Result<(), String> {
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

    fn normalize_legacy_workflow_run_events(&mut self) -> Result<(), String> {
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

    #[cfg(unix)]
    fn restrict_permissions(&self) -> Result<(), String> {
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
    fn restrict_permissions(&self) -> Result<(), String> {
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64, String> {
        self.connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|error| format!("Cannot read Pipline metadata schema version: {error}"))
    }

    pub fn workspace_id_for_path(&mut self, workspace: &Path) -> Result<String, String> {
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

    pub fn store_device_token(&mut self, device_id: &str, token: &str) -> Result<(), String> {
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

    pub fn revoke_device(&mut self, device_id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE paired_devices SET revoked_at = unixepoch() WHERE device_id = ?1",
                [device_id],
            )
            .map_err(|error| format!("Cannot revoke paired device: {error}"))?;
        Ok(())
    }

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

    /// Read one JSON preference value. Corrupt stored JSON surfaces as an
    /// error instead of silently falling back to a default.
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

    /// Upsert one JSON preference value.
    pub fn preference_set(&mut self, key: &str, value: &Value) -> Result<(), String> {
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

    /// Delete one preference. Returns whether a row was removed.
    pub fn preference_remove(&mut self, key: &str) -> Result<bool, String> {
        let removed = self
            .connection
            .execute("DELETE FROM preferences WHERE key = ?1", [key])
            .map_err(|error| format!("Cannot remove preference: {error}"))?;
        Ok(removed > 0)
    }

    pub fn workflow_load(
        &self,
        workflow_id: &str,
        workspace_id: &str,
    ) -> Result<Option<Value>, String> {
        let workflow_json: Option<String> = self
            .connection
            .query_row(
                "SELECT workflow_json FROM workflows WHERE workflow_id = ?1 AND workspace_id = ?2",
                params![workflow_id, workspace_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Cannot read workflow: {error}"))?;
        let Some(workflow_json) = workflow_json else {
            return Ok(None);
        };
        let workflow: Value = serde_json::from_str(&workflow_json)
            .map_err(|error| format!("Stored workflow JSON is invalid: {error}"))?;
        let mut statement = self
            .connection
            .prepare(
                "SELECT event_json FROM workflow_events WHERE workflow_id = ?1 ORDER BY revision",
            )
            .map_err(|error| format!("Cannot read workflow events: {error}"))?;
        let rows = statement
            .query_map([workflow_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Cannot query workflow events: {error}"))?;
        let mut events: Vec<Value> = Vec::new();
        for row in rows {
            let raw = row.map_err(|error| format!("Cannot read workflow event: {error}"))?;
            events.push(
                serde_json::from_str(&raw)
                    .map_err(|error| format!("Stored workflow event JSON is invalid: {error}"))?,
            );
        }
        Ok(Some(
            serde_json::json!({ "workflow": workflow, "events": events }),
        ))
    }

    pub fn workflow_node_templates_list(&self, workspace_id: &str) -> Result<Vec<Value>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT meta_json FROM workflow_node_templates WHERE workspace_id = ?1 ORDER BY created_at, meta_id, version")
            .map_err(|error| format!("Cannot prepare workflow template query: {error}"))?;
        let rows = statement
            .query_map([workspace_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Cannot query workflow templates: {error}"))?;
        rows.map(|row| {
            let raw = row.map_err(|error| format!("Cannot read workflow template: {error}"))?;
            serde_json::from_str(&raw)
                .map_err(|error| format!("Stored workflow template is invalid: {error}"))
        })
        .collect()
    }

    pub fn workflow_node_template_catalog_revision(
        &self,
        workspace_id: &str,
    ) -> Result<String, String> {
        let mut statement = self
            .connection
            .prepare("SELECT meta_id, version FROM workflow_node_templates WHERE workspace_id = ?1 ORDER BY meta_id, version")
            .map_err(|error| format!("Cannot prepare workflow catalog revision query: {error}"))?;
        let rows = statement
            .query_map([workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("Cannot query workflow catalog revision: {error}"))?;
        let mut hash = 0xcbf29ce484222325_u64;
        for row in rows {
            let (id, version) =
                row.map_err(|error| format!("Cannot read workflow catalog revision: {error}"))?;
            for value in [id, version] {
                for byte in (value.len() as u64)
                    .to_le_bytes()
                    .into_iter()
                    .chain(value.bytes())
                {
                    hash ^= u64::from(byte);
                    hash = hash.wrapping_mul(0x100000001b3);
                }
            }
        }
        Ok(format!("catalog-v1-{hash:016x}"))
    }

    pub fn workflow_node_template_create(
        &mut self,
        workspace_id: &str,
        meta: &Value,
    ) -> Result<bool, String> {
        let meta_id = meta
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Workflow template id is required")?;
        let version = meta
            .get("version")
            .and_then(Value::as_str)
            .ok_or("Workflow template version is required")?;
        let valid_ports =
            |field: &str| -> bool {
                meta.get(field)
                    .and_then(Value::as_array)
                    .is_some_and(|ports| {
                        ports.len() <= 256
                            && ports.iter().all(|port| {
                                port.is_object()
                                    && port.get("name").and_then(Value::as_str).is_some_and(
                                        |name| {
                                            !name.trim().is_empty() && name.chars().count() <= 128
                                        },
                                    )
                                    && port.get("label").and_then(Value::as_str).is_some_and(
                                        |label| {
                                            !label.trim().is_empty() && label.chars().count() <= 256
                                        },
                                    )
                                    && port.get("required").and_then(Value::as_bool).is_some()
                                    && port
                                        .get("allowStaticValue")
                                        .and_then(Value::as_bool)
                                        .is_some()
                                    && port.get("multi").is_none_or(Value::is_boolean)
                                    && port.get("type").is_some_and(|value_type| {
                                        valid_workflow_value_type(value_type, 0)
                                            && (!port
                                                .get("multi")
                                                .and_then(Value::as_bool)
                                                .unwrap_or(false)
                                                || value_type.get("kind").and_then(Value::as_str)
                                                    == Some("array"))
                                    })
                            })
                            && workflow_node_names_are_unique(ports)
                    })
            };
        let valid_params = meta
            .get("params")
            .and_then(Value::as_array)
            .is_some_and(|params| {
                params.len() <= 256
                    && params.iter().all(valid_workflow_node_param)
                    && workflow_node_names_are_unique(params)
            });
        if workspace_id.is_empty()
            || workspace_id.len() > 128
            || meta_id.len() > 128
            || !valid_custom_node_id(meta_id)
            || version.len() > 32
            || version.trim().is_empty()
            || meta.get("schemaVersion").and_then(Value::as_i64) != Some(1)
            || meta.get("type").and_then(Value::as_str) != Some("custom")
            || meta
                .get("label")
                .and_then(Value::as_str)
                .is_none_or(|label| label.trim().is_empty() || label.chars().count() > 256)
            || meta
                .get("description")
                .and_then(Value::as_str)
                .is_none_or(|description| description.chars().count() > 4_000)
            || !valid_ports("inputs")
            || !valid_ports("outputs")
            || !valid_params
            || !valid_workflow_node_meta_i18n(meta)
            || meta.pointer("/execution/kind").and_then(Value::as_str) != Some("user-code")
            || meta
                .pointer("/permissions/filesystem")
                .and_then(Value::as_str)
                != Some("none")
            || meta.pointer("/permissions/network").and_then(Value::as_str) != Some("none")
            || meta.pointer("/permissions/shell").and_then(Value::as_str) != Some("none")
        {
            return Err("Workflow NodeMeta candidate violates the storage contract".into());
        }
        let raw = serde_json::to_string(meta)
            .map_err(|error| format!("Cannot encode workflow NodeMeta: {error}"))?;
        if raw.len() > 180_000 {
            return Err("Workflow NodeMeta exceeds the 180 KB storage limit".into());
        }
        if let Some(draft) = meta.get("implementationDraft") {
            if draft.get("language").and_then(Value::as_str) != Some("typescript")
                || draft
                    .get("source")
                    .and_then(Value::as_str)
                    .is_none_or(|source| source.len() > 50_000)
                || draft
                    .get("entryFn")
                    .and_then(Value::as_str)
                    .is_none_or(|name| {
                        name.is_empty()
                            || !name.chars().enumerate().all(|(i, c)| {
                                c == '_'
                                    || c == '$'
                                    || c.is_ascii_alphabetic()
                                    || (i > 0 && c.is_ascii_digit())
                            })
                    })
            {
                return Err("Workflow NodeMeta implementationDraft is invalid".into());
            }
            let has_compiler_version = draft.get("compilerVersion").is_some();
            let has_compiled_source = draft.get("compiledSource").is_some();
            if has_compiler_version != has_compiled_source
                || (has_compiler_version
                    && (draft.get("compilerVersion").and_then(Value::as_str)
                        != Some("esbuild-wasm@0.28.0")
                        || draft
                            .get("compiledSource")
                            .and_then(Value::as_str)
                            .is_none_or(|source| source.is_empty() || source.len() > 50_000)))
            {
                return Err("Workflow NodeMeta compiled implementation is invalid".into());
            }
        }
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| format!("Cannot read system clock: {error}"))?
            .as_secs()
            .to_string();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot start workflow template transaction: {error}"))?;
        let active_run_exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workflow_runs WHERE workspace_id = ?1 AND status IN ('queued', 'running'))",
                [workspace_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Cannot check active workflow Runs: {error}"))?;
        if active_run_exists {
            return Err("Workflow node catalog is read-only while a Run is active".into());
        }
        let changed = transaction.execute(
            "INSERT OR IGNORE INTO workflow_node_templates (workspace_id, meta_id, version, meta_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![workspace_id, meta_id, version, raw, created_at],
        ).map_err(|error| format!("Cannot save workflow NodeMeta: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit workflow NodeMeta: {error}"))?;
        Ok(changed == 1)
    }

    pub fn workflow_create(
        &mut self,
        workspace_id: &str,
        workflow: &Value,
    ) -> Result<bool, String> {
        let workflow_id = workflow
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Workflow id is required".to_string())?;
        if workflow_id.len() > 128
            || !workflow_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err("Workflow id contains unsupported characters".into());
        }
        if workflow.get("schemaVersion").and_then(Value::as_i64) != Some(1)
            || !workflow.get("nodes").is_some_and(Value::is_array)
            || !workflow.get("edges").is_some_and(Value::is_array)
            || workflow.get("workspaceId").and_then(Value::as_str) != Some(workspace_id)
        {
            return Err("Workflow schema is invalid".into());
        }
        if workflow.get("revision").and_then(Value::as_i64) != Some(0) {
            return Err("A new workflow must start at revision 0".into());
        }
        validate_workflow_structure(workflow)?;
        self.validate_workflow_node_contracts(workspace_id, workflow)?;
        let raw = serde_json::to_string(workflow)
            .map_err(|error| format!("Cannot encode workflow: {error}"))?;
        if raw.len() > MAX_WORKFLOW_JSON_BYTES {
            return Err("Workflow exceeds the 8 MB storage limit".into());
        }
        let updated_at = workflow
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("");
        let inserted = self
            .connection
            .execute(
                "INSERT OR IGNORE INTO workflows (workflow_id, workspace_id, revision, workflow_json, updated_at)
             VALUES (?1, ?2, 0, ?3, ?4)",
                params![workflow_id, workspace_id, raw, updated_at],
            )
            .map_err(|error| format!("Cannot create workflow: {error}"))?;
        Ok(inserted == 1)
    }

    pub fn workflow_compare_and_swap(
        &mut self,
        workflow_id: &str,
        workspace_id: &str,
        expected_revision: i64,
        workflow: &Value,
        event: &Value,
    ) -> Result<bool, String> {
        if expected_revision < 0
            || workflow.get("id").and_then(Value::as_str) != Some(workflow_id)
            || workflow.get("revision").and_then(Value::as_i64) != Some(expected_revision + 1)
            || workflow.get("schemaVersion").and_then(Value::as_i64) != Some(1)
            || workflow.get("workspaceId").and_then(Value::as_str) != Some(workspace_id)
            || !workflow.get("nodes").is_some_and(Value::is_array)
            || !workflow.get("edges").is_some_and(Value::is_array)
            || event.get("workflowId").and_then(Value::as_str) != Some(workflow_id)
            || event.get("workspaceId").and_then(Value::as_str) != Some(workspace_id)
            || event.get("revision").and_then(Value::as_i64) != Some(expected_revision + 1)
            || event.get("schemaVersion").and_then(Value::as_i64) != Some(1)
        {
            return Err(
                "Workflow and event revisions do not match the compare-and-swap request".into(),
            );
        }
        validate_workflow_structure(workflow)?;
        self.validate_workflow_node_contracts(workspace_id, workflow)?;
        let actor = event
            .get("actor")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "user" | "agent" | "system"))
            .ok_or_else(|| "Workflow event actor is invalid".to_string())?;
        let idempotency_key = event
            .pointer("/command/idempotencyKey")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Workflow event idempotencyKey is required".to_string())?;
        let timestamp = event.get("timestamp").and_then(Value::as_str).unwrap_or("");
        let workflow_raw = serde_json::to_string(workflow)
            .map_err(|error| format!("Cannot encode workflow: {error}"))?;
        let event_raw = serde_json::to_string(event)
            .map_err(|error| format!("Cannot encode workflow event: {error}"))?;
        if workflow_raw.len() > MAX_WORKFLOW_JSON_BYTES {
            return Err("Workflow exceeds the 8 MB storage limit".into());
        }
        if event_raw.len() > MAX_WORKFLOW_EVENT_JSON_BYTES {
            return Err("Workflow event exceeds the 1 MB storage limit".into());
        }
        let previous_event: Option<String> = self.connection.query_row(
            "SELECT event_json FROM workflow_events WHERE workflow_id = ?1 AND idempotency_key = ?2",
            params![workflow_id, idempotency_key],
            |row| row.get(0),
        ).optional().map_err(|error| format!("Cannot check workflow command idempotency: {error}"))?;
        if let Some(previous_event) = previous_event {
            return if previous_event == event_raw {
                Ok(true)
            } else {
                Err("Workflow idempotencyKey was already used for a different command".into())
            };
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot start workflow update: {error}"))?;
        let active_run_exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workflow_runs WHERE workflow_id = ?1 AND workspace_id = ?2 AND status IN ('queued', 'running'))",
                params![workflow_id, workspace_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Cannot check active workflow Runs: {error}"))?;
        if active_run_exists {
            return Err("Workflow graph is read-only while a Run is active".into());
        }
        let updated = transaction
            .execute(
                "UPDATE workflows SET revision = ?1, workflow_json = ?2, updated_at = ?3
             WHERE workflow_id = ?4 AND workspace_id = ?5 AND revision = ?6",
                params![
                    expected_revision + 1,
                    workflow_raw,
                    timestamp,
                    workflow_id,
                    workspace_id,
                    expected_revision
                ],
            )
            .map_err(|error| format!("Cannot update workflow: {error}"))?;
        if updated == 0 {
            transaction
                .rollback()
                .map_err(|error| format!("Cannot roll back stale workflow update: {error}"))?;
            return Ok(false);
        }
        transaction.execute(
            "INSERT INTO workflow_events (workflow_id, revision, actor, idempotency_key, timestamp, event_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![workflow_id, expected_revision + 1, actor, idempotency_key, timestamp, event_raw],
        ).map_err(|error| format!("Cannot append workflow event: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit workflow update: {error}"))?;
        Ok(true)
    }

    pub fn workflow_run_create(&mut self, workspace_id: &str, run: &Value) -> Result<bool, String> {
        let run_id = run
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_id(id))
            .ok_or("Workflow run id is invalid")?;
        let workflow_id = run
            .get("workflowId")
            .and_then(Value::as_str)
            .filter(|id| valid_id(id))
            .ok_or("Workflow run workflowId is invalid")?;
        let workflow_revision = run
            .get("workflowRevision")
            .and_then(Value::as_i64)
            .filter(|revision| *revision >= 0)
            .ok_or("Workflow run revision is invalid")?;
        if run.get("schemaVersion").and_then(Value::as_i64) != Some(1)
            || run.get("workspaceId").and_then(Value::as_str) != Some(workspace_id)
            || run.get("status").and_then(Value::as_str) != Some("queued")
            || run.pointer("/snapshot/id").and_then(Value::as_str) != Some(workflow_id)
            || run.pointer("/snapshot/revision").and_then(Value::as_i64) != Some(workflow_revision)
        {
            return Err("Workflow run snapshot is invalid".into());
        }
        if run.get("result") != Some(&Value::Null)
            || run.get("error") != Some(&Value::Null)
            || run
                .get("nodeStates")
                .and_then(Value::as_object)
                .is_none_or(|states| {
                    states
                        .values()
                        .any(|state| state.get("status").and_then(Value::as_str) != Some("idle"))
                })
        {
            return Err("New workflow run must start with empty results and idle nodes".into());
        }
        validate_workflow_run_max_concurrency(run)?;
        validate_workflow_run_node_states(run)?;
        validate_workflow_run_output_sizes(run)?;
        validate_workflow_run_node_meta_snapshot(run)?;
        let raw = serialize_workflow_run_without_events(run)?;
        if raw.len() > MAX_WORKFLOW_RUN_JSON_BYTES {
            return Err("Workflow run snapshot exceeds the 8 MB storage limit".into());
        }
        let updated_at = run.get("updatedAt").and_then(Value::as_str).unwrap_or("");
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Cannot start workflow run creation: {error}"))?;
        let saved_workflow: Option<(i64, String)> = transaction
            .query_row(
                "SELECT revision, workflow_json FROM workflows WHERE workflow_id = ?1 AND workspace_id = ?2",
                params![workflow_id, workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("Cannot validate workflow run owner: {error}"))?;
        let Some((saved_revision, saved_workflow)) = saved_workflow else {
            return Err("Workflow run references an unavailable workflow".into());
        };
        if saved_revision != workflow_revision {
            return Err("Workflow changed after this Run snapshot was prepared".into());
        }
        let saved_workflow: Value = serde_json::from_str(&saved_workflow)
            .map_err(|error| format!("Stored workflow JSON is invalid: {error}"))?;
        let snapshot = run
            .get("snapshot")
            .ok_or("Workflow run graph snapshot is missing")?;
        if !workflow_snapshot_validation::matches_saved_workflow(&saved_workflow, snapshot) {
            return Err("Run snapshot does not match the saved workflow revision".into());
        }
        let active_run_exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workflow_runs WHERE workflow_id = ?1 AND workspace_id = ?2 AND status IN ('queued', 'running'))",
                params![workflow_id, workspace_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Cannot check active workflow runs: {error}"))?;
        if active_run_exists {
            return Ok(false);
        }
        let inserted = transaction.execute(
            "INSERT OR IGNORE INTO workflow_runs (run_id, workflow_id, workspace_id, workflow_revision, event_sequence, status, run_json, updated_at) VALUES (?1, ?2, ?3, ?4, 0, 'queued', ?5, ?6)",
            params![run_id, workflow_id, workspace_id, workflow_revision, raw, updated_at],
        ).map_err(|error| format!("Cannot create workflow run: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit workflow run creation: {error}"))?;
        Ok(inserted == 1)
    }

    fn mark_inflight_workflow_runs_interrupted(&mut self) -> Result<(), String> {
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

    pub fn workflow_run_load(
        &self,
        run_id: &str,
        workspace_id: &str,
    ) -> Result<Option<Value>, String> {
        let stored: Option<(String, String, i64, i64, String, String)> = self
            .connection
            .query_row(
                "SELECT status, workflow_id, workflow_revision, event_sequence, updated_at, run_json
                 FROM workflow_runs WHERE run_id = ?1 AND workspace_id = ?2",
                params![run_id, workspace_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Cannot load workflow run: {error}"))?;
        let Some((status, workflow_id, workflow_revision, event_sequence, updated_at, raw)) =
            stored
        else {
            return Ok(None);
        };
        let run: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("Stored workflow run JSON is invalid: {error}"))?;
        let mut statement = self
            .connection
            .prepare(
                "SELECT sequence, event_json FROM workflow_run_events WHERE run_id = ?1 ORDER BY sequence",
            )
            .map_err(|error| format!("Cannot prepare workflow run event query: {error}"))?;
        let rows = statement
            .query_map([run_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("Cannot query workflow run events: {error}"))?;
        let mut events: Vec<(i64, Value)> = Vec::new();
        for row in rows {
            let (sequence, event) =
                row.map_err(|error| format!("Cannot read workflow run event: {error}"))?;
            let event: Value = serde_json::from_str(&event)
                .map_err(|error| format!("Stored workflow run event JSON is invalid: {error}"))?;
            events.push((sequence, event));
        }
        workflow_run_read_validation::validate(
            &run,
            &workflow_run_read_validation::RunIndex {
                run_id,
                workspace_id,
                status: &status,
                workflow_id: &workflow_id,
                workflow_revision,
                event_sequence,
                updated_at: &updated_at,
            },
            &events,
        )?;
        Ok(Some(serde_json::json!({
            "run": run,
            "events": events.into_iter().map(|(_, event)| event).collect::<Vec<_>>()
        })))
    }

    pub fn workflow_run_list(
        &self,
        workflow_id: &str,
        workspace_id: &str,
        limit: i64,
    ) -> Result<Vec<Value>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT run_id, status, workflow_revision, updated_at, run_json FROM workflow_runs
                 WHERE workflow_id = ?1 AND workspace_id = ?2
                 ORDER BY updated_at DESC, run_id DESC LIMIT ?3",
            )
            .map_err(|error| format!("Cannot prepare workflow run list: {error}"))?;
        let rows = statement
            .query_map(
                params![workflow_id, workspace_id, limit.clamp(1, 100)],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .map_err(|error| format!("Cannot query workflow runs: {error}"))?;
        let summaries = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot read workflow run list: {error}"))?;
        drop(statement);
        let mut validated_summaries = Vec::with_capacity(summaries.len());
        for (run_id, status, workflow_revision, updated_at, raw) in summaries {
            let run: Value = serde_json::from_str(&raw)
                .map_err(|error| format!("Stored workflow run JSON is invalid: {error}"))?;
            workflow_run_read_validation::validate_summary(
                &run,
                &workflow_run_read_validation::RunIndex {
                    run_id: &run_id,
                    workspace_id,
                    status: &status,
                    workflow_id,
                    workflow_revision,
                    event_sequence: 0,
                    updated_at: &updated_at,
                },
            )?;
            validated_summaries.push(serde_json::json!({
                "id": run_id,
                "status": status,
                "workflowRevision": workflow_revision,
                "updatedAt": updated_at,
            }));
        }
        Ok(validated_summaries)
    }

    pub fn workflow_run_append_event(
        &mut self,
        run_id: &str,
        workspace_id: &str,
        expected_sequence: i64,
        run: &Value,
        event: &Value,
    ) -> Result<bool, String> {
        let workflow_id = run
            .get("workflowId")
            .and_then(Value::as_str)
            .ok_or("Workflow run workflowId is required")?;
        let sequence = expected_sequence
            .checked_add(1)
            .ok_or("Workflow run event sequence is exhausted")?;
        if expected_sequence < 0
            || run.get("id").and_then(Value::as_str) != Some(run_id)
            || run.get("workspaceId").and_then(Value::as_str) != Some(workspace_id)
            || run.get("schemaVersion").and_then(Value::as_i64) != Some(1)
            || !matches!(
                run.get("status").and_then(Value::as_str),
                Some("queued" | "running" | "success" | "error" | "cancelled" | "interrupted")
            )
            || event.get("runId").and_then(Value::as_str) != Some(run_id)
            || event.get("workflowId").and_then(Value::as_str) != Some(workflow_id)
            || event.get("sequence").and_then(Value::as_i64) != Some(sequence)
        {
            return Err("Workflow run event or revision is invalid".into());
        }
        validate_workflow_run_event_limit(
            expected_sequence,
            event.get("type").and_then(Value::as_str),
        )?;
        validate_workflow_run_max_concurrency(run)?;
        validate_workflow_run_node_states(run)?;
        validate_workflow_run_output_sizes(run)?;
        validate_workflow_run_node_meta_snapshot(run)?;
        let run_raw = serialize_workflow_run_without_events(run)?;
        if run_raw.len() > MAX_WORKFLOW_RUN_JSON_BYTES {
            return Err("Workflow run exceeds the 8 MB storage limit".into());
        }
        let event_raw = serde_json::to_string(event)
            .map_err(|error| format!("Cannot encode workflow run event: {error}"))?;
        if event_raw.len() > MAX_WORKFLOW_RUN_EVENT_JSON_BYTES {
            return Err("Workflow run event exceeds the 1 MB storage limit".into());
        }
        let status = run.get("status").and_then(Value::as_str).unwrap_or("error");
        let updated_at = run.get("updatedAt").and_then(Value::as_str).unwrap_or("");
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Cannot start workflow run update: {error}"))?;
        let original_raw: Option<String> = transaction
            .query_row(
                "SELECT run_json FROM workflow_runs WHERE run_id = ?1 AND workspace_id = ?2 AND event_sequence = ?3",
                params![run_id, workspace_id, expected_sequence],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Cannot read current workflow run: {error}"))?;
        let Some(original_raw) = original_raw else {
            transaction.rollback().map_err(|error| {
                format!("Cannot roll back missing workflow run update: {error}")
            })?;
            return Ok(false);
        };
        let original: Value = serde_json::from_str(&original_raw)
            .map_err(|error| format!("Stored workflow run JSON is invalid: {error}"))?;
        let previous_status = original.get("status").and_then(Value::as_str);
        let next_status = run.get("status").and_then(Value::as_str);
        let event_type = event.get("type").and_then(Value::as_str);
        let known_event_type = matches!(
            event_type,
            Some(
                "run_started"
                    | "node_started"
                    | "node_log"
                    | "node_completed"
                    | "node_failed"
                    | "node_interrupted"
                    | "node_skipped"
                    | "run_completed"
                    | "run_failed"
                    | "run_cancelled"
                    | "run_interrupted"
            )
        );
        let valid_transition = match (previous_status, next_status, event_type) {
            (Some("queued"), Some("running"), Some("run_started")) => true,
            (Some("queued"), Some("interrupted"), Some("run_interrupted")) => true,
            (Some("running"), Some("running"), Some(kind)) => !matches!(
                kind,
                "run_started"
                    | "run_completed"
                    | "run_failed"
                    | "run_cancelled"
                    | "run_interrupted"
            ),
            (Some("running"), Some("success"), Some("run_completed")) => true,
            (Some("running"), Some("error"), Some("run_failed")) => true,
            (Some("running"), Some("cancelled"), Some("run_cancelled")) => true,
            (Some("running"), Some("interrupted"), Some("run_interrupted")) => true,
            _ => false,
        };
        let expected_event_id = format!("{run_id}:{sequence}");
        if !known_event_type
            || !valid_transition
            || event.get("id").and_then(Value::as_str) != Some(expected_event_id.as_str())
            || event.get("timestamp").and_then(Value::as_str).is_none()
        {
            transaction.rollback().map_err(|error| {
                format!("Cannot roll back invalid workflow run transition: {error}")
            })?;
            return Err("Workflow run status transition or event identity is invalid".into());
        }
        if event_type == Some("run_interrupted")
            && event
                .get("skippedNodeIds")
                .and_then(Value::as_array)
                .is_none()
        {
            transaction.rollback().map_err(|error| {
                format!("Cannot roll back incomplete workflow interruption event: {error}")
            })?;
            return Err("Workflow run_interrupted event is missing skippedNodeIds".into());
        }
        validate_workflow_run_event_state_delta(&original, run, event_type.unwrap_or(""), event)?;
        for field in [
            "id",
            "workflowId",
            "workspaceId",
            "workflowRevision",
            "schemaVersion",
            "snapshot",
            "nodeMetaSnapshot",
            "input",
            "maxConcurrency",
            "createdAt",
            "retryOfRunId",
            "resumeFromNodeId",
        ] {
            if original.get(field) != run.get(field) {
                transaction.rollback().map_err(|error| {
                    format!("Cannot roll back mutated workflow run snapshot: {error}")
                })?;
                return Err(format!("Workflow run immutable field changed: {field}"));
            }
        }
        if event.get("timestamp").and_then(Value::as_str) != Some(updated_at) {
            transaction.rollback().map_err(|error| {
                format!("Cannot roll back mismatched workflow run timestamp: {error}")
            })?;
            return Err("Workflow run updatedAt does not match the event timestamp".into());
        }
        let updated = transaction.execute(
            "UPDATE workflow_runs SET event_sequence = ?1, status = ?2, run_json = ?3, updated_at = ?4 WHERE run_id = ?5 AND workspace_id = ?6 AND event_sequence = ?7",
            params![sequence, status, run_raw, updated_at, run_id, workspace_id, expected_sequence],
        ).map_err(|error| format!("Cannot update workflow run: {error}"))?;
        if updated == 0 {
            transaction
                .rollback()
                .map_err(|error| format!("Cannot roll back stale workflow run update: {error}"))?;
            return Ok(false);
        }
        transaction.execute(
            "INSERT INTO workflow_run_events (run_id, sequence, event_json) VALUES (?1, ?2, ?3)",
            params![run_id, sequence, event_raw],
        ).map_err(|error| format!("Cannot append workflow run event: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit workflow run update: {error}"))?;
        Ok(true)
    }
}

fn validate_workflow_run_event_state_delta(
    previous: &Value,
    next: &Value,
    event_type: &str,
    event: &Value,
) -> Result<(), String> {
    let previous_result = previous.get("result").cloned().unwrap_or(Value::Null);
    let previous_error = previous.get("error").cloned().unwrap_or(Value::Null);
    let next_result = next.get("result").cloned().unwrap_or(Value::Null);
    let next_error = next.get("error").cloned().unwrap_or(Value::Null);
    match event_type {
        "run_completed" => {
            let event_result = event
                .get("result")
                .ok_or("Workflow run_completed event is missing result")?;
            if next_result != *event_result {
                return Err("Workflow run result does not match run_completed event".into());
            }
            if next_error != previous_error {
                return Err("Workflow run error changed during run_completed".into());
            }
        }
        "run_failed" | "run_cancelled" | "run_interrupted" => {
            let error = event
                .get("error")
                .and_then(Value::as_str)
                .ok_or("Terminal workflow event is missing its error")?;
            if next_error.as_str() != Some(error) {
                return Err(format!(
                    "Workflow run error does not match {event_type} event"
                ));
            }
            if next_result != previous_result {
                return Err(format!("Workflow run result changed during {event_type}"));
            }
        }
        _ => {
            if next_result != previous_result || next_error != previous_error {
                return Err(format!(
                    "Workflow run result or error changed during {event_type}"
                ));
            }
        }
    }
    let previous_states = previous
        .get("nodeStates")
        .and_then(Value::as_object)
        .ok_or("Stored workflow run nodeStates are invalid")?;
    let next_states = next
        .get("nodeStates")
        .and_then(Value::as_object)
        .ok_or("Workflow run nodeStates are invalid")?;
    if event_type.starts_with("node_") {
        let node_id = event
            .get("nodeId")
            .and_then(Value::as_str)
            .ok_or("Workflow node event is missing nodeId")?;
        for (other_node_id, previous_state) in previous_states {
            if other_node_id == node_id {
                continue;
            }
            if next_states.get(other_node_id) != Some(previous_state) {
                return Err(format!(
                    "Workflow node event changed an unrelated node state: {other_node_id}"
                ));
            }
        }
        let previous_state = previous_states
            .get(node_id)
            .ok_or("Workflow node event references an unknown node")?;
        let next_state = next_states
            .get(node_id)
            .ok_or("Workflow node event references an unknown node")?;
        let prior = previous_state
            .get("status")
            .and_then(Value::as_str)
            .ok_or("Workflow node event references an unknown node")?;
        let current = next_state
            .get("status")
            .and_then(Value::as_str)
            .ok_or("Workflow node event references an unknown node")?;
        let expected = match event_type {
            "node_started" | "node_log" => "running",
            "node_completed" => "success",
            "node_failed" => "error",
            "node_interrupted" => "interrupted",
            "node_skipped" => "skipped",
            _ => return Err("Unknown workflow node event".into()),
        };
        if current != expected
            || (event_type == "node_started" && prior != "idle")
            || (event_type == "node_log" && prior != "running")
            || (event_type == "node_completed" && !matches!(prior, "idle" | "running"))
            || (event_type == "node_failed" && prior != "running")
            || (event_type == "node_interrupted" && prior != "running")
            || (event_type == "node_skipped" && prior != "idle")
        {
            return Err(format!(
                "Workflow node state does not match event {event_type}"
            ));
        }
        let mut expected_state = previous_state.clone();
        match event_type {
            "node_started" => expected_state["status"] = Value::from("running"),
            "node_log" => {
                let message = event
                    .get("message")
                    .and_then(Value::as_str)
                    .ok_or("Workflow node_log event is missing its message")?;
                let mut logs = previous_state
                    .get("logs")
                    .and_then(Value::as_array)
                    .cloned()
                    .ok_or("Stored workflow node logs are invalid")?;
                logs.push(Value::from(message));
                expected_state["logs"] = Value::Array(logs);
            }
            "node_completed" => {
                expected_state["status"] = Value::from("success");
                expected_state["output"] = event
                    .get("output")
                    .cloned()
                    .ok_or("Workflow node_completed event is missing its output")?;
                expected_state["error"] = Value::Null;
            }
            "node_failed" | "node_interrupted" => {
                let error = event
                    .get("error")
                    .and_then(Value::as_str)
                    .ok_or("Workflow node terminal event is missing its error")?;
                expected_state["status"] = Value::from(expected);
                expected_state["output"] = Value::Null;
                expected_state["error"] = Value::from(error);
            }
            "node_skipped" => {
                if event
                    .get("reason")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                {
                    return Err("Workflow node_skipped event is missing its reason".into());
                }
                expected_state["status"] = Value::from("skipped");
                expected_state["logs"] = Value::Array(Vec::new());
                expected_state["output"] = Value::Null;
                expected_state["error"] = Value::Null;
            }
            _ => return Err("Unknown workflow node event".into()),
        }
        if next_state != &expected_state {
            return Err(format!(
                "Workflow node state does not match event {event_type}"
            ));
        }
    }
    match event_type {
        "run_started" => {
            if previous_states != next_states {
                return Err("Workflow node state changed during run_started".into());
            }
            if next_states
                .values()
                .any(|state| state.get("status").and_then(Value::as_str) == Some("running"))
            {
                return Err("Workflow run cannot start with a node already running".into());
            }
        }
        "run_completed" => {
            if previous_states != next_states {
                return Err("Workflow node state changed during run_completed".into());
            }
            if next_states.values().any(|state| {
                !matches!(
                    state.get("status").and_then(Value::as_str),
                    Some("success" | "skipped")
                )
            }) {
                return Err("Completed workflow run contains unfinished nodes".into());
            }
        }
        "run_failed" | "run_cancelled" => {
            if previous_states != next_states {
                return Err(format!("Workflow node state changed during {event_type}"));
            }
            if next_states.values().any(|state| {
                matches!(
                    state.get("status").and_then(Value::as_str),
                    Some("idle" | "running")
                )
            }) {
                return Err("Terminal workflow run contains unfinished nodes".into());
            }
        }
        "run_interrupted" => {
            if next_states
                .values()
                .any(|state| state.get("status").and_then(Value::as_str) == Some("running"))
            {
                return Err("Interrupted workflow run contains a running node".into());
            }
            let error = event
                .get("error")
                .and_then(Value::as_str)
                .ok_or("Interrupted workflow event is missing its error")?;
            let skipped_node_ids = event
                .get("skippedNodeIds")
                .and_then(Value::as_array)
                .map(|ids| {
                    let mut unique = std::collections::HashSet::new();
                    ids.iter()
                        .map(|id| {
                            id.as_str()
                                .filter(|id| unique.insert(*id))
                                .ok_or("Interrupted workflow skippedNodeIds are invalid")
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?;
            if let Some(ids) = &skipped_node_ids {
                for node_id in ids {
                    if previous_states
                        .get(*node_id)
                        .and_then(|state| state.get("status"))
                        .and_then(Value::as_str)
                        != Some("idle")
                    {
                        return Err(
                            "Interrupted workflow skippedNodeIds must reference idle nodes".into(),
                        );
                    }
                }
            }
            for (node_id, previous_state) in previous_states {
                let next_state = next_states
                    .get(node_id)
                    .ok_or("Interrupted workflow run is missing a node state")?;
                let prior_status = previous_state
                    .get("status")
                    .and_then(Value::as_str)
                    .ok_or("Stored workflow node state is invalid")?;
                let mut expected_state = previous_state.clone();
                match prior_status {
                    "running" => {
                        expected_state["status"] = Value::from("interrupted");
                        expected_state["error"] = Value::from(error);
                    }
                    "idle"
                        if skipped_node_ids
                            .as_ref()
                            .is_some_and(|ids| ids.contains(&node_id.as_str())) =>
                    {
                        expected_state["status"] = Value::from("skipped");
                    }
                    "idle" if skipped_node_ids.is_none() && next_state != previous_state => {
                        // Legacy schema-1 interrupted events did not enumerate skipped nodes.
                        expected_state["status"] = Value::from("skipped");
                    }
                    _ => {}
                }
                if next_state != &expected_state {
                    return Err(format!(
                        "Workflow run_interrupted contains an invalid node state transition for {node_id}"
                    ));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// Validate the mutable node state map independently of the frontend runner.
/// A schema-1 run snapshot is persisted as host-owned data and may be submitted
/// by any WebSocket client, so the host must ensure it still describes exactly
/// the nodes in its frozen graph.
fn validate_workflow_run_node_states(run: &Value) -> Result<(), String> {
    let nodes = run
        .pointer("/snapshot/nodes")
        .and_then(Value::as_array)
        .ok_or("Workflow run graph snapshot must contain a nodes array")?;
    let states = run
        .get("nodeStates")
        .and_then(Value::as_object)
        .ok_or("Workflow run nodeStates must be an object")?;
    if states.len() != nodes.len() {
        return Err("Workflow run nodeStates must match the graph nodes".into());
    }
    for node in nodes {
        let node_id = node
            .get("instanceId")
            .and_then(Value::as_str)
            .ok_or("Workflow run graph node instanceId is invalid")?;
        let state = states
            .get(node_id)
            .and_then(Value::as_object)
            .ok_or_else(|| format!("Workflow run state is missing for node {node_id}"))?;
        let logs_valid = state
            .get("logs")
            .and_then(Value::as_array)
            .is_some_and(|logs| logs.iter().all(Value::is_string));
        if !matches!(
            state.get("status").and_then(Value::as_str),
            Some("idle" | "running" | "success" | "error" | "skipped" | "interrupted")
        ) || !logs_valid
            || state.get("output").is_none()
            || !state
                .get("error")
                .is_some_and(|error| error.is_null() || error.is_string())
        {
            return Err(format!("Workflow run state is invalid for node {node_id}"));
        }
    }
    if states
        .keys()
        .any(|node_id| !nodes.iter().any(|node| node["instanceId"] == *node_id))
    {
        return Err("Workflow run nodeStates contain an unknown node".into());
    }
    Ok(())
}

fn validate_workflow_run_output_sizes(run: &Value) -> Result<(), String> {
    let input = run.get("input").ok_or("Workflow run input is missing")?;
    let input_size = serde_json::to_vec(input)
        .map_err(|error| format!("Cannot encode workflow input: {error}"))?
        .len();
    if input_size > MAX_WORKFLOW_NODE_OUTPUT_BYTES {
        return Err("Workflow input exceeds the 512 KB limit".into());
    }
    for state in run
        .get("nodeStates")
        .and_then(Value::as_object)
        .ok_or("Workflow run nodeStates must be an object")?
        .values()
    {
        let output = state
            .get("output")
            .ok_or("Workflow run node output is missing")?;
        let output_size = serde_json::to_vec(output)
            .map_err(|error| format!("Cannot encode workflow node output: {error}"))?
            .len();
        if output_size > MAX_WORKFLOW_NODE_OUTPUT_BYTES {
            return Err("Workflow node output exceeds the 512 KB limit".into());
        }
    }
    let result = run.get("result").ok_or("Workflow run result is missing")?;
    let result_size = serde_json::to_vec(result)
        .map_err(|error| format!("Cannot encode workflow result: {error}"))?
        .len();
    if result_size > MAX_WORKFLOW_NODE_OUTPUT_BYTES {
        return Err("Workflow result exceeds the 512 KB limit".into());
    }
    Ok(())
}

fn validate_workflow_run_max_concurrency(run: &Value) -> Result<(), String> {
    let Some(value) = run.get("maxConcurrency") else {
        // Older schema-1 Runs default to sequential execution when resumed.
        return Ok(());
    };
    let valid = value.as_u64().is_some_and(|count| (1..=4).contains(&count))
        || value.as_f64().is_some_and(|count| {
            count.is_finite() && count.fract() == 0.0 && (1.0..=4.0).contains(&count)
        });
    if valid {
        Ok(())
    } else {
        Err("Workflow run maxConcurrency must be an integer between 1 and 4".into())
    }
}

fn validate_workflow_run_event_limit(
    expected_sequence: i64,
    event_type: Option<&str>,
) -> Result<(), String> {
    let terminal = matches!(
        event_type,
        Some(
            "node_failed"
                | "node_interrupted"
                | "run_completed"
                | "run_failed"
                | "run_cancelled"
                | "run_interrupted"
        )
    );
    if expected_sequence >= MAX_WORKFLOW_RUN_EVENT_COUNT
        || (!terminal
            && expected_sequence
                >= MAX_WORKFLOW_RUN_EVENT_COUNT - TERMINAL_WORKFLOW_RUN_EVENT_RESERVE)
    {
        return Err("Workflow run reached the 10,000 event limit".into());
    }
    Ok(())
}

fn validate_workflow_run_node_meta_snapshot(run: &Value) -> Result<(), String> {
    let graph = run
        .get("snapshot")
        .ok_or("Workflow run graph snapshot is missing")?;
    validate_workflow_structure(graph)?;
    let input = run.get("input").ok_or("Workflow run input is missing")?;
    let start = graph
        .pointer("/nodes")
        .and_then(Value::as_array)
        .and_then(|nodes| {
            nodes.iter().find(|node| {
                node.pointer("/meta/id").and_then(Value::as_str) == Some("pipline.start")
            })
        })
        .ok_or("Workflow run graph snapshot is missing its Start node")?;
    let default_schema = serde_json::json!({ "properties": {}, "required": [] });
    let input_schema = start
        .pointer("/paramValues/inputSchema")
        .unwrap_or(&default_schema);
    workflow_validation::validate_workflow_start_input(input, input_schema)?;
    let Some(snapshot) = run.get("nodeMetaSnapshot") else {
        // Runs written by earlier schema-1 builds remain readable and appendable.
        return Ok(());
    };
    let templates = snapshot
        .as_object()
        .ok_or("Workflow run NodeMeta snapshot must be an object")?;
    let frozen_templates: HashMap<String, Value> = templates
        .iter()
        .map(|(key, meta)| (key.clone(), meta.clone()))
        .collect();
    validate_custom_node_contracts(graph, &frozen_templates)?;
    let nodes = run
        .pointer("/snapshot/nodes")
        .and_then(Value::as_array)
        .ok_or("Workflow run graph snapshot must contain a nodes array")?;
    for node in nodes {
        let meta = node
            .get("meta")
            .and_then(Value::as_object)
            .ok_or("Workflow run node reference is invalid")?;
        let id = meta
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Workflow run node template id is invalid")?;
        let version = meta
            .get("version")
            .and_then(Value::as_str)
            .ok_or("Workflow run node template version is invalid")?;
        let key = format!("{id}@{version}");
        let frozen = templates
            .get(&key)
            .ok_or_else(|| format!("Workflow run is missing frozen NodeMeta: {key}"))?;
        if frozen.get("id").and_then(Value::as_str) != Some(id)
            || frozen.get("version").and_then(Value::as_str) != Some(version)
        {
            return Err(format!(
                "Workflow run frozen NodeMeta does not match: {key}"
            ));
        }
    }
    Ok(())
}

fn serialize_workflow_run_without_events(run: &Value) -> Result<String, String> {
    let mut record = run.clone();
    if let Some(object) = record.as_object_mut() {
        object.remove("events");
        object.remove("retrySeedStates");
    }
    serde_json::to_string(&record).map_err(|error| format!("Cannot encode workflow run: {error}"))
}

fn valid_workflow_value_type(value_type: &Value, depth: usize) -> bool {
    const MAX_TYPE_DEPTH: usize = 24;
    const MAX_SCHEMA_FIELDS: usize = 256;

    if depth > MAX_TYPE_DEPTH {
        return false;
    }
    if let Some(kind) = value_type.as_str() {
        return matches!(
            kind,
            "string" | "number" | "boolean" | "object" | "array" | "any"
        );
    }
    let Some(object) = value_type.as_object() else {
        return false;
    };
    match object.get("kind").and_then(Value::as_str) {
        Some("array") => object
            .get("items")
            .is_some_and(|items| valid_workflow_value_type(items, depth + 1)),
        Some("object") => {
            let Some(schema) = object.get("schema") else {
                return true;
            };
            let Some(schema) = schema.as_object() else {
                return false;
            };
            let properties = schema.get("properties").and_then(Value::as_object);
            let properties_valid = match schema.get("properties") {
                None => true,
                Some(_) => properties.as_ref().is_some_and(|properties| {
                    properties.len() <= MAX_SCHEMA_FIELDS
                        && properties.iter().all(|(name, property)| {
                            name.chars().count() <= 128
                                && valid_workflow_value_type(property, depth + 1)
                        })
                }),
            };
            let required_valid = match schema.get("required") {
                None => true,
                Some(required) => required.as_array().is_some_and(|required| {
                    required.len() <= MAX_SCHEMA_FIELDS
                        && required.iter().enumerate().all(|(index, field)| {
                            field.as_str().is_some_and(|name| {
                                properties
                                    .as_ref()
                                    .is_some_and(|properties| properties.contains_key(name))
                                    && !required[..index]
                                        .iter()
                                        .any(|previous| previous.as_str() == Some(name))
                            })
                        })
                }),
            };
            properties_valid && required_valid
        }
        Some("string" | "number" | "boolean" | "any") => true,
        _ => false,
    }
}

fn valid_workflow_node_meta_i18n(meta: &Value) -> bool {
    let Some(locales) = meta.get("i18n").and_then(Value::as_object) else {
        return false;
    };
    if locales.len() != 4
        || ["en", "zh", "es", "ja"]
            .iter()
            .any(|locale| !locales.contains_key(*locale))
    {
        return false;
    }
    for locale in ["en", "zh", "es", "ja"] {
        let Some(entry) = locales.get(locale).and_then(Value::as_object) else {
            return false;
        };
        if entry
            .get("label")
            .and_then(Value::as_str)
            .is_none_or(|text| text.trim().is_empty() || text.chars().count() > 256)
            || entry
                .get("description")
                .and_then(Value::as_str)
                .is_none_or(|text| text.chars().count() > 4_000)
        {
            return false;
        }
        for group in ["inputs", "outputs", "params"] {
            let Some(source) = meta.get(group).and_then(Value::as_array) else {
                return false;
            };
            let Some(translations) = entry.get(group).and_then(Value::as_object) else {
                return false;
            };
            if translations.len() != source.len() {
                return false;
            }
            for item in source {
                let Some(name) = item.get("name").and_then(Value::as_str) else {
                    return false;
                };
                let Some(translation) = translations.get(name) else {
                    return false;
                };
                if group == "params" {
                    if translation
                        .get("label")
                        .and_then(Value::as_str)
                        .is_none_or(|text| text.trim().is_empty() || text.chars().count() > 256)
                    {
                        return false;
                    }
                    if item.get("description").is_some()
                        && translation
                            .get("description")
                            .and_then(Value::as_str)
                            .is_none_or(|text| text.chars().count() > 4_000)
                    {
                        return false;
                    }
                    if let Some(options) = item.get("options").and_then(Value::as_array) {
                        let Some(option_translations) =
                            translation.get("options").and_then(Value::as_object)
                        else {
                            return false;
                        };
                        if option_translations.len() != options.len()
                            || options.iter().any(|option| {
                                option
                                    .get("value")
                                    .and_then(Value::as_str)
                                    .is_none_or(|value| {
                                        option_translations
                                            .get(value)
                                            .and_then(Value::as_str)
                                            .is_none_or(|text| {
                                                text.trim().is_empty() || text.chars().count() > 256
                                            })
                                    })
                            })
                        {
                            return false;
                        }
                    }
                } else if translation
                    .as_str()
                    .is_none_or(|text| text.trim().is_empty() || text.chars().count() > 256)
                {
                    return false;
                }
            }
        }
    }
    true
}

fn valid_workflow_node_param(param: &Value) -> bool {
    let Some(object) = param.as_object() else {
        return false;
    };
    let Some(name) = object.get("name").and_then(Value::as_str) else {
        return false;
    };
    let Some(label) = object.get("label").and_then(Value::as_str) else {
        return false;
    };
    let Some(kind) = object.get("type").and_then(Value::as_str) else {
        return false;
    };
    if name.trim().is_empty()
        || name.chars().count() > 128
        || label.trim().is_empty()
        || label.chars().count() > 256
        || object.get("description").is_some_and(|description| {
            description
                .as_str()
                .is_none_or(|text| text.chars().count() > 4_000)
        })
        || object.get("required").and_then(Value::as_bool).is_none()
        || !matches!(
            kind,
            "string" | "number" | "boolean" | "object" | "array" | "any" | "select" | "json"
        )
    {
        return false;
    }

    let options = if kind == "select" {
        let Some(options) = object.get("options").and_then(Value::as_array) else {
            return false;
        };
        if options.is_empty() || options.len() > 256 {
            return false;
        }
        let mut values = Vec::with_capacity(options.len());
        for option in options {
            let Some(option) = option.as_object() else {
                return false;
            };
            let Some(option_label) = option.get("label").and_then(Value::as_str) else {
                return false;
            };
            let Some(value) = option.get("value").and_then(Value::as_str) else {
                return false;
            };
            if option_label.trim().is_empty()
                || option_label.chars().count() > 256
                || value.trim().is_empty()
                || value.chars().count() > 128
                || values.contains(&value)
            {
                return false;
            }
            values.push(value);
        }
        Some(values)
    } else {
        None
    };

    if let Some(default) = object.get("defaultValue") {
        let value_type = match kind {
            "select" => "string",
            "json" => "any",
            _ => kind,
        };
        if !value_matches_workflow_type(default, value_type, 0) {
            return false;
        }
        if kind == "select"
            && !options.as_ref().is_some_and(|values| {
                default
                    .as_str()
                    .is_some_and(|value| values.contains(&value))
            })
        {
            return false;
        }
    }
    true
}

fn value_matches_workflow_type(value: &Value, value_type: &str, depth: usize) -> bool {
    const MAX_VALUE_DEPTH: usize = 64;
    if depth > MAX_VALUE_DEPTH {
        return false;
    }
    match value_type {
        "any" => match value {
            Value::Array(items) => items
                .iter()
                .all(|item| valid_workflow_json_value(item, depth + 1)),
            Value::Object(items) => items
                .values()
                .all(|item| valid_workflow_json_value(item, depth + 1)),
            _ => true,
        },
        "string" => value.is_string(),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "object" => value
            .as_object()
            .is_some_and(|_| valid_workflow_json_value(value, depth)),
        "array" => value.as_array().is_some_and(|items| {
            items
                .iter()
                .all(|item| valid_workflow_json_value(item, depth + 1))
        }),
        _ => false,
    }
}

fn workflow_node_names_are_unique(items: &[Value]) -> bool {
    let mut names = Vec::with_capacity(items.len());
    for item in items {
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            return false;
        };
        if names.contains(&name) {
            return false;
        }
        names.push(name);
    }
    true
}

fn valid_workflow_json_value(value: &Value, depth: usize) -> bool {
    if depth > 64 {
        return false;
    }
    match value {
        Value::Array(items) => items
            .iter()
            .all(|item| valid_workflow_json_value(item, depth + 1)),
        Value::Object(items) => items
            .values()
            .all(|item| valid_workflow_json_value(item, depth + 1)),
        _ => true,
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_custom_node_id(value: &str) -> bool {
    let Some(slug) = value.strip_prefix("custom.") else {
        return false;
    };
    let mut bytes = slug.bytes();
    if !bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return false;
    }
    bytes.all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
    })
}

fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

#[cfg(test)]
#[path = "metadata_store/tests.rs"]
mod tests;
