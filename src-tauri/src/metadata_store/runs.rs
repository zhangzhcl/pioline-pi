// 工作流运行实例（Run）创建、崩溃恢复中断标记、详情加载、列表查询与事件追加。

use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::run_state_validation::{
    validate_workflow_run_event_limit, validate_workflow_run_event_state_delta,
    validate_workflow_run_max_concurrency, validate_workflow_run_node_meta_snapshot,
    validate_workflow_run_node_states, validate_workflow_run_output_sizes,
};
use super::template_validation::valid_id;
use super::{
    workflow_run_read_validation, workflow_snapshot_validation, MetadataStore,
    MAX_WORKFLOW_RUN_EVENT_JSON_BYTES, MAX_WORKFLOW_RUN_JSON_BYTES,
};

impl MetadataStore {
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

    pub fn workflow_run_load(
        &self,
        run_id: &str,
        workspace_id: &str,
    ) -> Result<Option<Value>, String> {
        let stored: Option<(String, String, i64, i64, String, String)> = self
            .connection
            .prepare_cached(
                "SELECT status, workflow_id, workflow_revision, event_sequence, updated_at, run_json
                 FROM workflow_runs WHERE run_id = ?1 AND workspace_id = ?2",
            )
            .map_err(|error| format!("Cannot load workflow run: {error}"))?
            .query_row(params![run_id, workspace_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
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
            .prepare_cached(
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
            .prepare_cached(
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
            .prepare_cached(
                "SELECT run_json FROM workflow_runs WHERE run_id = ?1 AND workspace_id = ?2 AND event_sequence = ?3",
            )
            .map_err(|error| format!("Cannot read current workflow run: {error}"))?
            .query_row(params![run_id, workspace_id, expected_sequence], |row| row.get(0))
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
            (Some("queued"), Some("running"), Some("run_started"))
            | (Some("queued" | "running"), Some("interrupted"), Some("run_interrupted"))
            | (Some("running"), Some("success"), Some("run_completed"))
            | (Some("running"), Some("error"), Some("run_failed"))
            | (Some("running"), Some("cancelled"), Some("run_cancelled")) => true,
            (Some("running"), Some("running"), Some(kind)) => !matches!(
                kind,
                "run_started"
                    | "run_completed"
                    | "run_failed"
                    | "run_cancelled"
                    | "run_interrupted"
            ),
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
        let updated = transaction
            .prepare_cached(
                "UPDATE workflow_runs SET event_sequence = ?1, status = ?2, run_json = ?3, updated_at = ?4 WHERE run_id = ?5 AND workspace_id = ?6 AND event_sequence = ?7",
            )
            .map_err(|error| format!("Cannot update workflow run: {error}"))?
            .execute(params![
                sequence,
                status,
                run_raw,
                updated_at,
                run_id,
                workspace_id,
                expected_sequence
            ])
            .map_err(|error| format!("Cannot update workflow run: {error}"))?;
        if updated == 0 {
            transaction
                .rollback()
                .map_err(|error| format!("Cannot roll back stale workflow run update: {error}"))?;
            return Ok(false);
        }
        transaction
            .prepare_cached(
                "INSERT INTO workflow_run_events (run_id, sequence, event_json) VALUES (?1, ?2, ?3)",
            )
            .map_err(|error| format!("Cannot append workflow run event: {error}"))?
            .execute(params![run_id, sequence, event_raw])
            .map_err(|error| format!("Cannot append workflow run event: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit workflow run update: {error}"))?;
        Ok(true)
    }
}

struct FilteredRunObject<'a>(&'a serde_json::Map<String, Value>);

impl serde::Serialize for FilteredRunObject<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let len = self
            .0
            .keys()
            .filter(|key| *key != "events" && *key != "retrySeedStates")
            .count();
        let mut map = serializer.serialize_map(Some(len))?;
        for (key, value) in self.0 {
            if key == "events" || key == "retrySeedStates" {
                continue;
            }
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

pub(super) fn serialize_workflow_run_without_events(run: &Value) -> Result<String, String> {
    if let Some(object) = run.as_object() {
        serde_json::to_string(&FilteredRunObject(object))
            .map_err(|error| format!("Cannot encode workflow run: {error}"))
    } else {
        serde_json::to_string(run).map_err(|error| format!("Cannot encode workflow run: {error}"))
    }
}
