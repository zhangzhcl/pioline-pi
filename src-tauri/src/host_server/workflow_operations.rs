use serde_json::{json, Value};

use super::HostState;

#[path = "workflow_code_operations.rs"]
mod workflow_code_operations;

pub(crate) use workflow_code_operations::{
    dispatch_cancel_workflow_code_operation, dispatch_workflow_code_operation,
    ensure_desktop_workflow_code_client, WorkflowCodeCancellationRegistry,
};

pub(crate) fn workflow_id(frame: &Value) -> Result<&str, (&'static str, String)> {
    let id = frame
        .get("workflowId")
        .and_then(Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
        .ok_or_else(|| {
            (
                "invalid_workflow",
                "workflowId must be 1-128 ASCII letters, digits, '.', '_' or '-'".into(),
            )
        })?;
    Ok(id)
}

pub(crate) fn dispatch_workflow_operation(
    state: &HostState,
    request_id: &str,
    operation: &str,
    frame: &Value,
) -> Result<Value, (&'static str, String)> {
    let store = state.metadata.as_ref().ok_or_else(|| {
        (
            "host_operation_failed",
            "Workflow store is not available".into(),
        )
    })?;
    let mut store = store
        .lock()
        .map_err(|_| ("host_operation_failed", "Workflow store is poisoned".into()))?;
    let response = |fields: Vec<(&str, Value)>| {
        let mut object = serde_json::Map::with_capacity(3 + fields.len());
        object.insert("type".into(), Value::from("host_response"));
        object.insert("requestId".into(), Value::from(request_id));
        object.insert("operation".into(), Value::from(operation));
        for (name, value) in fields {
            object.insert(name.into(), value);
        }
        Value::Object(object)
    };
    match operation {
        "list_workflow_node_templates" => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    (
                        "invalid_workflow_template",
                        "workspaceId is required".into(),
                    )
                })?;
            let templates = store
                .workflow_node_templates_list(workspace_id)
                .map_err(|message| ("host_operation_failed", message))?;
            let catalog_revision = store
                .workflow_node_template_catalog_revision(workspace_id)
                .map_err(|message| ("host_operation_failed", message))?;
            drop(store);
            Ok(response(vec![
                ("templates", Value::Array(templates)),
                ("catalogRevision", Value::from(catalog_revision)),
            ]))
        }
        "create_workflow_node_template" => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    (
                        "invalid_workflow_template",
                        "workspaceId is required".into(),
                    )
                })?;
            let meta = frame
                .get("meta")
                .filter(|value| value.is_object())
                .ok_or_else(|| {
                    (
                        "invalid_workflow_template",
                        "meta object is required".into(),
                    )
                })?;
            let expected_catalog_revision = frame
                .get("expectedCatalogRevision")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    (
                        "invalid_workflow_template",
                        "expectedCatalogRevision is required".into(),
                    )
                })?;
            let current_catalog_revision = store
                .workflow_node_template_catalog_revision(workspace_id)
                .map_err(|message| ("host_operation_failed", message))?;
            if expected_catalog_revision != current_catalog_revision {
                return Err((
                    "workflow_catalog_conflict",
                    "Workflow NodeMeta catalog changed; reload it and retry".into(),
                ));
            }
            let created = store
                .workflow_node_template_create(workspace_id, meta)
                .map_err(|message| ("invalid_workflow_template", message))?;
            let catalog_revision = if created {
                store
                    .workflow_node_template_catalog_revision(workspace_id)
                    .map_err(|message| ("host_operation_failed", message))?
            } else {
                current_catalog_revision
            };
            drop(store);
            if created {
                let _ = state.workflow_events.send(json!({
                    "type": "workflow_node_templates_changed",
                    "workspaceId": workspace_id,
                }));
            }
            Ok(response(vec![
                ("created", Value::from(created)),
                ("catalogRevision", Value::from(catalog_revision)),
            ]))
        }
        "load_workflow" => {
            let id = workflow_id(frame)?;
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_workflow", "workspaceId is required".into()))?;
            let record = store
                .workflow_load(id, workspace_id)
                .map_err(|message| ("host_operation_failed", message))?;
            drop(store);
            Ok(response(vec![("record", record.unwrap_or(Value::Null))]))
        }
        "create_workflow" => {
            let workflow = frame
                .get("workflow")
                .filter(|value| value.is_object())
                .ok_or_else(|| ("invalid_workflow", "workflow object is required".into()))?;
            let workspace_id = workflow
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    (
                        "invalid_workflow",
                        "workflow.workspaceId is required".into(),
                    )
                })?;
            let created = store
                .workflow_create(workspace_id, workflow)
                .map_err(|message| ("invalid_workflow", message))?;
            drop(store);
            if created {
                let _ = state.workflow_events.send(json!({
                    "type": "workflow_changed",
                    "workspaceId": workspace_id,
                    "workflowId": workflow.get("id").and_then(Value::as_str).unwrap_or_default(),
                    "revision": 0,
                }));
            }
            Ok(response(vec![("created", Value::from(created))]))
        }
        "compare_and_swap_workflow" => {
            let id = workflow_id(frame)?;
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_workflow", "workspaceId is required".into()))?;
            let expected = frame
                .get("expectedRevision")
                .and_then(Value::as_i64)
                .ok_or_else(|| ("invalid_workflow", "expectedRevision is required".into()))?;
            let workflow = frame
                .get("workflow")
                .filter(|value| value.is_object())
                .ok_or_else(|| ("invalid_workflow", "workflow object is required".into()))?;
            let event = frame
                .get("event")
                .filter(|value| value.is_object())
                .ok_or_else(|| ("invalid_workflow", "event object is required".into()))?;
            if event.get("actor").and_then(Value::as_str) == Some("agent") {
                let expected_catalog_revision = frame
                    .get("expectedCatalogRevision")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        (
                            "invalid_workflow",
                            "expectedCatalogRevision is required for Agent proposals".into(),
                        )
                    })?;
                let current_catalog_revision = store
                    .workflow_node_template_catalog_revision(workspace_id)
                    .map_err(|message| ("host_operation_failed", message))?;
                if expected_catalog_revision != current_catalog_revision {
                    return Err((
                        "workflow_catalog_conflict",
                        "Workflow NodeMeta catalog changed; reload it and retry".into(),
                    ));
                }
            }
            let saved = store
                .workflow_compare_and_swap(id, workspace_id, expected, workflow, event)
                .map_err(|message| {
                    if message == "Workflow graph is read-only while a Run is active" {
                        ("workflow_run_active", message)
                    } else {
                        ("invalid_workflow", message)
                    }
                })?;
            drop(store);
            if saved {
                let _ = state.workflow_events.send(json!({
                    "type": "workflow_changed",
                    "workspaceId": workspace_id,
                    "workflowId": id,
                    "revision": expected + 1,
                }));
            }
            Ok(response(vec![("saved", Value::from(saved))]))
        }
        "create_workflow_run" => {
            let run = frame
                .get("run")
                .filter(|value| value.is_object())
                .ok_or_else(|| ("invalid_workflow_run", "run object is required".into()))?;
            let workspace_id = run
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_workflow_run", "run.workspaceId is required".into()))?;
            let created = store
                .workflow_run_create(workspace_id, run)
                .map_err(|message| ("invalid_workflow_run", message))?;
            drop(store);
            if created {
                let _ = state.workflow_events.send(json!({
                    "type": "workflow_run_changed",
                    "workspaceId": workspace_id,
                    "workflowId": run.get("workflowId").and_then(Value::as_str).unwrap_or_default(),
                    "runId": run.get("id").and_then(Value::as_str).unwrap_or_default(),
                    "status": "queued",
                    "eventSequence": 0,
                }));
            }
            Ok(response(vec![("created", Value::from(created))]))
        }
        "load_workflow_run" => {
            let id = workflow_id(frame)?;
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_workflow_run", "workspaceId is required".into()))?;
            let record = store
                .workflow_run_load(id, workspace_id)
                .map_err(|message| ("host_operation_failed", message))?;
            drop(store);
            Ok(response(vec![("record", record.unwrap_or(Value::Null))]))
        }
        "list_workflow_runs" => {
            let id = workflow_id(frame)?;
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_workflow_run", "workspaceId is required".into()))?;
            let runs = store
                .workflow_run_list(id, workspace_id, 50)
                .map_err(|message| ("host_operation_failed", message))?;
            drop(store);
            Ok(response(vec![("runs", Value::Array(runs))]))
        }
        "append_workflow_run_event" => {
            let id = workflow_id(frame)?;
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_workflow_run", "workspaceId is required".into()))?;
            let expected = frame
                .get("expectedSequence")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    (
                        "invalid_workflow_run",
                        "expectedSequence is required".into(),
                    )
                })?;
            let run = frame
                .get("run")
                .filter(|value| value.is_object())
                .ok_or_else(|| ("invalid_workflow_run", "run object is required".into()))?;
            let event = frame
                .get("event")
                .filter(|value| value.is_object())
                .ok_or_else(|| ("invalid_workflow_run", "event object is required".into()))?;
            let saved = store
                .workflow_run_append_event(id, workspace_id, expected, run, event)
                .map_err(|message| ("invalid_workflow_run", message))?;
            drop(store);
            if saved {
                let _ = state.workflow_events.send(json!({
                    "type": "workflow_run_changed",
                    "workspaceId": workspace_id,
                    "workflowId": run.get("workflowId").and_then(Value::as_str).unwrap_or_default(),
                    "runId": id,
                    "status": run.get("status").and_then(Value::as_str).unwrap_or("error"),
                    "eventSequence": expected.saturating_add(1),
                    "eventType": event.get("type").and_then(Value::as_str).unwrap_or_default(),
                }));
            }
            Ok(response(vec![("saved", Value::from(saved))]))
        }
        _ => unreachable!("dispatch_workflow_operation called with unknown operation"),
    }
}
