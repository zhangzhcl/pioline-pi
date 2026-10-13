// Host 数据平面（Data 请求）协议分发处理。

use serde_json::{json, Value};

use super::super::routes::sessions::annotate_live_sessions;
use super::super::{host_data_error, HostState};

pub(super) async fn dispatch_data_operation(
    request_id: String,
    frame: Value,
    state: &HostState,
) -> Result<Value, (&'static str, String)> {
    match frame.get("operation").and_then(Value::as_str) {
        Some("list_files") => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_workspace", "workspaceId is required".into()))?;
            let relative_path = frame
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let show_hidden = frame
                .get("showHidden")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let entries = state
                .data
                .list_files(workspace_id, relative_path, show_hidden)
                .map_err(host_data_error)?;
            Ok(json!({
                "type": "data_response",
                "requestId": request_id,
                "operation": "list_files",
                "entries": entries,
            }))
        }
        Some("list_sessions") => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_workspace", "workspaceId is required".into()))?;
            let sessions = state
                .data
                .list_sessions(workspace_id)
                .map_err(host_data_error)?;
            Ok(json!({
                "type": "data_response",
                "requestId": request_id,
                "operation": "list_sessions",
                "sessions": sessions,
            }))
        }
        Some("list_all_sessions") => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_workspace", "workspaceId is required".into()))?;
            let sessions = state
                .data
                .list_all_sessions(workspace_id)
                .map_err(host_data_error)?;
            let mut sessions = serde_json::to_value(sessions)
                .map_err(|error| ("serialization_failed", error.to_string()))?;
            if let Ok(statuses) = state.runtimes.statuses() {
                annotate_live_sessions(&mut sessions, &statuses);
            }
            Ok(json!({
                "type": "data_response",
                "requestId": request_id,
                "operation": "list_all_sessions",
                "sessions": sessions,
                "workspaces": state.data.registered_workspaces(),
            }))
        }
        Some("list_launcher_sessions") => {
            let sessions = state
                .data
                .list_launcher_sessions()
                .map_err(host_data_error)?;
            let mut sessions = serde_json::to_value(sessions)
                .map_err(|error| ("serialization_failed", error.to_string()))?;
            if let Ok(statuses) = state.runtimes.statuses() {
                annotate_live_sessions(&mut sessions, &statuses);
            }
            Ok(json!({
                "type": "data_response",
                "requestId": request_id,
                "operation": "list_launcher_sessions",
                "sessions": sessions,
                "workspaces": state.data.registered_workspaces(),
            }))
        }
        Some("search_sessions") => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_workspace", "workspaceId is required".into()))?;
            let query = frame.get("query").and_then(Value::as_str).unwrap_or("");
            let results = state
                .data
                .search_sessions(workspace_id, query)
                .map_err(host_data_error)?;
            Ok(json!({
                "type": "data_response",
                "requestId": request_id,
                "operation": "search_sessions",
                "results": results,
            }))
        }
        Some("cost_dashboard") => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_workspace", "workspaceId is required".into()))?;
            let dashboard = state
                .data
                .cost_dashboard(workspace_id)
                .map_err(host_data_error)?;
            Ok(json!({
                "type": "data_response",
                "requestId": request_id,
                "operation": "cost_dashboard",
                "dashboard": dashboard,
            }))
        }
        Some("read_session_messages") => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_workspace", "workspaceId is required".into()))?;
            let session_id = frame
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_session", "sessionId is required".into()))?;
            let data = state.data.clone();
            let workspace_id = workspace_id.to_owned();
            let session_id = session_id.to_owned();
            let messages = tokio::task::spawn_blocking(move || {
                data.read_session_messages(&workspace_id, &session_id)
            })
            .await
            .map_err(|error| ("host_data_task_failed", error.to_string()))?
            .map_err(host_data_error)?;
            Ok(json!({
                "type": "data_response",
                "requestId": request_id,
                "operation": "read_session_messages",
                "messages": messages,
            }))
        }
        Some("read_session_tree") => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_workspace", "workspaceId is required".into()))?;
            let session_id = frame
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_session", "sessionId is required".into()))?;
            let data = state.data.clone();
            let workspace_id = workspace_id.to_owned();
            let session_id = session_id.to_owned();
            let tree = tokio::task::spawn_blocking(move || {
                data.read_session_tree(&workspace_id, &session_id)
            })
            .await
            .map_err(|error| ("host_data_task_failed", error.to_string()))?
            .map_err(host_data_error)?;
            Ok(json!({
                "type": "data_response",
                "requestId": request_id,
                "operation": "read_session_tree",
                "tree": tree,
            }))
        }
        Some("workspace_info") => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_workspace", "workspaceId is required".into()))?;
            let info = state
                .data
                .workspace_info(workspace_id)
                .map_err(host_data_error)?;
            Ok(json!({
                "type": "data_response",
                "requestId": request_id,
                "operation": "workspace_info",
                "info": info,
            }))
        }
        _ => Err((
            "unknown_data_operation",
            "Unsupported data operation".into(),
        )),
    }
}
