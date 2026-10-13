use serde_json::{json, Value};

use crate::acp_launch;
use crate::pi_launch::{list_installed_apps, open_external, open_in_app};
use crate::runtime_coordinator::RuntimeTarget;

use super::routes::workspace::resolve_workspace_path;
use super::workflow_operations::{
    dispatch_cancel_workflow_code_operation, dispatch_workflow_code_operation,
    dispatch_workflow_operation, ensure_desktop_workflow_code_client,
};
use super::{host_data_error, HostState};

#[path = "package_skill_operations.rs"]
mod package_skill_operations;

use package_skill_operations::dispatch_package_or_skill_operation;

/// Preference operations are limited to `ui.*` keys: this migration only
/// exposes display preferences to the browser, and a prefix check keeps a
/// compromised client from probing other metadata rows.
pub(crate) fn preference_key(frame: &Value) -> Result<String, (&'static str, String)> {
    let key = frame
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ("invalid_preference", "key is required".into()))?;
    if !key.starts_with("ui.") {
        return Err((
            "invalid_preference",
            "Only ui.* preference keys are supported".into(),
        ));
    }
    Ok(key.to_owned())
}

pub(crate) fn dispatch_preference_operation(
    state: &HostState,
    request_id: &str,
    operation: &str,
    frame: &Value,
) -> Result<Value, (&'static str, String)> {
    let store = state.metadata.as_ref().ok_or_else(|| {
        (
            "host_operation_failed",
            "Preference store is not available".into(),
        )
    })?;
    let key = preference_key(frame)?;
    let response = |operation: &str, fields: &[(&str, Value)]| {
        let mut object = serde_json::Map::new();
        object.insert("type".into(), Value::from("host_response"));
        object.insert("requestId".into(), Value::from(request_id));
        object.insert("operation".into(), Value::from(operation));
        for (name, value) in fields {
            object.insert((*name).into(), value.clone());
        }
        Value::Object(object)
    };
    match operation {
        "get_preference" => {
            let value = store
                .lock()
                .map_err(|_| {
                    (
                        "host_operation_failed",
                        "Preference store is poisoned".into(),
                    )
                })?
                .preference_get(&key)
                .map_err(|message| ("host_operation_failed", message))?;
            Ok(response(
                operation,
                &[
                    ("key", Value::from(key)),
                    ("value", value.unwrap_or(Value::Null)),
                ],
            ))
        }
        "set_preference" => {
            let value = frame
                .get("value")
                .cloned()
                .filter(|value| !value.is_null())
                .ok_or_else(|| ("invalid_preference", "value is required".into()))?;
            store
                .lock()
                .map_err(|_| {
                    (
                        "host_operation_failed",
                        "Preference store is poisoned".into(),
                    )
                })?
                .preference_set(&key, &value)
                .map_err(|message| ("host_operation_failed", message))?;
            Ok(response(
                operation,
                &[("key", Value::from(key)), ("value", value)],
            ))
        }
        "remove_preference" => {
            let removed = store
                .lock()
                .map_err(|_| {
                    (
                        "host_operation_failed",
                        "Preference store is poisoned".into(),
                    )
                })?
                .preference_remove(&key)
                .map_err(|message| ("host_operation_failed", message))?;
            Ok(response(
                operation,
                &[("key", Value::from(key)), ("removed", Value::from(removed))],
            ))
        }
        _ => unreachable!("dispatch_preference_operation called with unknown operation"),
    }
}

pub(crate) async fn dispatch_host_operation(
    state: &HostState,
    client_id: &str,
    request_id: &str,
    operation: &str,
    frame: &Value,
) -> Result<Value, (&'static str, String)> {
    match operation {
        "get_workflow_execution_capabilities" => {
            ensure_desktop_workflow_code_client(state, client_id)?;
            #[cfg(feature = "workflow-code-runner-prototype")]
            let code_execution =
                crate::workflow_code_runner::platform_isolated_execution_available();
            #[cfg(not(feature = "workflow-code-runner-prototype"))]
            let code_execution = false;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": operation,
                "codeExecution": code_execution,
            }))
        }
        "cancel_workflow_code" => {
            dispatch_cancel_workflow_code_operation(state, client_id, request_id, frame)
        }
        "execute_workflow_code" => {
            dispatch_workflow_code_operation(state, client_id, request_id, frame).await
        }
        "get_preference" | "set_preference" | "remove_preference" => {
            dispatch_preference_operation(state, request_id, operation, frame)
        }
        "load_workflow"
        | "list_workflow_node_templates"
        | "create_workflow_node_template"
        | "create_workflow"
        | "compare_and_swap_workflow"
        | "create_workflow_run"
        | "load_workflow_run"
        | "list_workflow_runs"
        | "append_workflow_run_event" => {
            dispatch_workflow_operation(state, request_id, operation, frame)
        }
        "list_pi_packages"
        | "check_pi_package_updates"
        | "install_pi_package"
        | "remove_pi_package"
        | "update_pi_package"
        | "set_pi_package_disabled"
        | "pick_skill_source"
        | "skill_scan_install_source"
        | "skill_install_links" => {
            dispatch_package_or_skill_operation(state, client_id, request_id, operation, frame)
                .await
        }
        "list_installed_apps" => Ok(json!({
            "type": "host_response",
            "requestId": request_id,
            "operation": "list_installed_apps",
            "apps": list_installed_apps(),
        })),
        "acp_list_agents" => {
            let path_env = crate::pi_launch::build_augmented_path();
            let agents: Vec<Value> = acp_launch::detected_presets(&path_env)
                .into_iter()
                .map(|(id, label)| json!({ "id": id, "label": label }))
                .collect();
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "acp_list_agents",
                "agents": agents,
            }))
        }
        "open_in_app" => {
            let path = frame
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| ("invalid_path", "path is required".into()))?;
            let app_name = frame
                .get("appName")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let command = frame
                .get("command")
                .and_then(Value::as_str)
                .map(str::to_owned);
            tokio::task::spawn_blocking(move || {
                open_in_app(&path, app_name.as_deref(), command.as_deref())
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("open_in_app_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "open_in_app",
                "ok": true,
            }))
        }
        "open_external" => {
            let url = frame
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| ("invalid_url", "url is required".into()))?;
            tokio::task::spawn_blocking(move || open_external(&url))
                .await
                .map_err(|error| ("host_operation_failed", error.to_string()))?
                .map_err(|message| ("open_external_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "open_external",
                "ok": true,
            }))
        }
        "resolve_workspace" => {
            let project_path = frame
                .get("projectPath")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_project_path", "projectPath is required".into()))?;
            let workspace_id = resolve_workspace_path(state, project_path)
                .map_err(|code| (code, code.replace('_', " ")))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "resolve_workspace",
                "workspaceId": workspace_id,
            }))
        }
        "delete_sessions" => {
            let session_ids: Vec<String> = frame
                .get("sessionIds")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let data = state.data.clone();
            let result = tokio::task::spawn_blocking(move || data.delete_sessions(&session_ids))
                .await
                .map_err(|error| ("host_operation_failed", error.to_string()))?
                .map_err(host_data_error)?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "delete_sessions",
                "deleted": result.deleted,
                "errors": result.errors,
            }))
        }
        "session_ui_profile_load" => {
            let expected = frame
                .get("expectedSessionId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_session", "expectedSessionId is required".into()))?
                .to_owned();
            let profiles = state.session_ui_profiles.clone();
            let fallback_to_latest = frame
                .get("fallbackToLatest")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let profile = tokio::task::spawn_blocking(move || {
                let profile = profiles.load(&expected)?;
                if profile.is_none() && fallback_to_latest {
                    profiles.load_latest()
                } else {
                    Ok(profile)
                }
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("session_ui_profile_load_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "session_ui_profile_load",
                "profile": profile,
            }))
        }
        "session_ui_profile_save" => {
            let expected = frame
                .get("expectedSessionId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_session", "expectedSessionId is required".into()))?
                .to_owned();
            let provider = frame
                .get("provider")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_provider", "provider is required".into()))?
                .to_owned();
            let model_id = frame
                .get("modelId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_model", "modelId is required".into()))?
                .to_owned();
            let thinking_level = frame
                .get("thinkingLevel")
                .and_then(Value::as_str)
                .map_or_else(|| "off".to_string(), str::to_owned);
            let profiles = state.session_ui_profiles.clone();
            let saved = tokio::task::spawn_blocking(move || {
                profiles.save(&expected, &provider, &model_id, &thinking_level)
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("session_ui_profile_save_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "session_ui_profile_save",
                "profile": saved,
            }))
        }
        "restart_runtime" => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_workspace", "workspaceId is required".into()))?
                .to_owned();
            let session_id = frame
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_session", "sessionId is required".into()))?
                .to_owned();
            let session_path = state
                .data
                .resolve_session_path(&workspace_id, &session_id)
                .ok()
                .flatten();
            let cwd = state.data.workspace_root_path(&workspace_id).map_err(|_| {
                (
                    "workspace_not_found",
                    "Could not resolve workspace root".into(),
                )
            })?;
            let cwd = cwd.to_string_lossy().to_string();
            let session_path_str = session_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string());
            let spec = state
                .pi_launch
                .native_launch_spec(&cwd, session_path_str.as_deref())
                .map_err(|message| ("launch_spec_failed", message))?;
            let target =
                RuntimeTarget::new(workspace_id, session_id, "restart-pending".to_string());
            let runtimes = state.runtimes.clone();
            let new_instance =
                tokio::task::spawn_blocking(move || runtimes.restart(&target, &spec))
                    .await
                    .map_err(|error| ("host_operation_failed", error.to_string()))?
                    .map_err(|message| ("restart_runtime_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "restart_runtime",
                "instanceId": new_instance,
                "ok": true,
            }))
        }
        "acp_task_start" => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_workspace", "workspaceId is required".into()))?
                .to_owned();
            let session_id = frame
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_session", "sessionId is required".into()))?
                .to_owned();
            let agent_id = frame
                .get("agentId")
                .and_then(Value::as_str)
                .unwrap_or("claude-code")
                .to_owned();

            let cwd = state.data.workspace_root_path(&workspace_id).map_err(|_| {
                (
                    "workspace_not_found",
                    "Could not resolve workspace root".into(),
                )
            })?;
            let run_id = uuid::Uuid::new_v4().simple().to_string();
            let task_session_id = format!("{session_id}::acp::{run_id}");
            let instance_id = format!("acp-task-{run_id}");
            let target = RuntimeTarget::new(workspace_id, task_session_id, instance_id);

            let spec = acp_launch::resolve_preset(&agent_id, cwd)
                .map_err(|message| ("unknown_acp_agent", message))?;
            state
                .acp
                .spawn(target.clone(), spec)
                .await
                .map_err(|message| ("acp_task_start_failed", message))?;

            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "acp_task_start",
                "target": target,
                "agentId": agent_id,
            }))
        }
        "acp_task_stop" => {
            let target: RuntimeTarget = serde_json::from_value(
                frame
                    .get("target")
                    .cloned()
                    .ok_or_else(|| ("invalid_target", "Runtime target is required".into()))?,
            )
            .map_err(|_| ("invalid_target", "Runtime target is invalid".into()))?;
            let _ = state.acp.stop(&target);
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "acp_task_stop",
                "ok": true,
            }))
        }
        _ => Err((
            "host_operation_unimplemented",
            "Host operation is not implemented on protocol v2".into(),
        )),
    }
}
