// 工作流图存储（加载、新建、乐观锁 CAS 更新）与自定义节点模板管理。

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::Value;

use super::template_validation::{
    valid_custom_node_id, valid_workflow_node_meta_i18n, valid_workflow_node_param,
    valid_workflow_value_type, workflow_node_names_are_unique,
};
use super::workflow_validation::{
    builtin_node_metas, validate_custom_node_contracts, validate_workflow_structure,
    CombinedNodeMetas,
};
use super::{MetadataStore, MAX_WORKFLOW_EVENT_JSON_BYTES, MAX_WORKFLOW_JSON_BYTES};

impl MetadataStore {
    pub(super) fn validate_workflow_node_contracts(
        &self,
        workspace_id: &str,
        workflow: &Value,
    ) -> Result<(), String> {
        let builtins = builtin_node_metas();
        let mut custom = std::collections::HashMap::new();
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
            if custom.contains_key(&key) {
                continue;
            }
            let raw: Option<String> = self
                .connection
                .prepare_cached(
                    "SELECT meta_json FROM workflow_node_templates WHERE workspace_id = ?1 AND meta_id = ?2 AND version = ?3",
                )
                .map_err(|error| format!("Cannot load workflow NodeMeta {key}: {error}"))?
                .query_row(params![workspace_id, id, version], |row| row.get(0))
                .optional()
                .map_err(|error| format!("Cannot load workflow NodeMeta {key}: {error}"))?;
            if let Some(raw) = raw {
                let meta = serde_json::from_str(&raw).map_err(|error| {
                    format!("Stored workflow NodeMeta {key} is invalid: {error}")
                })?;
                custom.insert(key, meta);
            }
        }
        validate_custom_node_contracts(
            workflow,
            &CombinedNodeMetas {
                builtins,
                custom: &custom,
            },
        )
    }

    pub fn workflow_load(
        &self,
        workflow_id: &str,
        workspace_id: &str,
    ) -> Result<Option<Value>, String> {
        let workflow_json: Option<String> = self
            .connection
            .prepare_cached(
                "SELECT workflow_json FROM workflows WHERE workflow_id = ?1 AND workspace_id = ?2",
            )
            .map_err(|error| format!("Cannot read workflow: {error}"))?
            .query_row(params![workflow_id, workspace_id], |row| row.get(0))
            .optional()
            .map_err(|error| format!("Cannot read workflow: {error}"))?;
        let Some(workflow_json) = workflow_json else {
            return Ok(None);
        };
        let workflow: Value = serde_json::from_str(&workflow_json)
            .map_err(|error| format!("Stored workflow JSON is invalid: {error}"))?;
        let mut statement = self
            .connection
            .prepare_cached(
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
            .prepare_cached("SELECT meta_json FROM workflow_node_templates WHERE workspace_id = ?1 ORDER BY created_at, meta_id, version")
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
            .prepare_cached("SELECT meta_id, version FROM workflow_node_templates WHERE workspace_id = ?1 ORDER BY meta_id, version")
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

    pub fn workflow_create(&self, workspace_id: &str, workflow: &Value) -> Result<bool, String> {
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
}
