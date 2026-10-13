use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde_json::{json, Value};

use crate::host_git;
use crate::host_router::{RoutedAction, PROTOCOL_VERSION};
use crate::runtime_coordinator::RuntimeTarget;
use crate::window_owner::OwnerId;

use super::host_operations::dispatch_host_operation;
use super::{host_data_error, HostState};

#[path = "data_operations.rs"]
mod data_operations;

use data_operations::dispatch_data_operation;

/// Most runtime RPCs (`get_state`, `set_model`, `abort`, ...) are answered by
/// `pi --mode rpc` in milliseconds without waiting on the user or the LLM; a
/// short deadline keeps a wedged runtime from leaking a pending request.
pub(crate) const RUNTIME_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// `prompt` is the exception. An extension command runs inline and its response
/// only arrives once the handler returns — and a handler that opens a dialog
/// does not return until the user has answered it, possibly several screens
/// later. Bound that generously instead of at human-reaction speed; a 30s
/// deadline turned every extension menu into a spurious "request failed".
pub(crate) const RUNTIME_INTERACTIVE_REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub(crate) fn runtime_request_timeout(command: &Value) -> Duration {
    match command.get("type").and_then(Value::as_str) {
        Some("prompt" | "acp_prompt") => RUNTIME_INTERACTIVE_REQUEST_TIMEOUT,
        _ => RUNTIME_REQUEST_TIMEOUT,
    }
}

#[cfg(test)]
pub(crate) fn messages_from_entries_response(response: &Value) -> Value {
    messages_from_entries_response_owned(response.clone())
}

pub(crate) fn messages_from_entries_response_owned(mut response: Value) -> Value {
    let leaf_id = response
        .pointer("/data/leafId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let Some(entries) = response
        .pointer_mut("/data/entries")
        .and_then(Value::as_array_mut)
    else {
        return json!([]);
    };
    let mut id_to_index = HashMap::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        if let Some(id) = entry.get("id").and_then(Value::as_str) {
            id_to_index.insert(id.to_owned(), index);
        }
    }

    let mut branch_indices = Vec::new();
    let mut current = leaf_id
        .as_deref()
        .and_then(|id| id_to_index.get(id).copied());
    let mut visited = HashSet::new();
    while let Some(index) = current {
        if !visited.insert(index) {
            break;
        }
        let entry = &entries[index];
        if entry.get("type").and_then(Value::as_str) == Some("message")
            && entry.get("message").is_some()
        {
            branch_indices.push(index);
        }
        current = entry
            .get("parentId")
            .and_then(Value::as_str)
            .and_then(|parent_id| id_to_index.get(parent_id).copied());
    }

    let mut branch = Vec::with_capacity(branch_indices.len());
    for index in branch_indices.into_iter().rev() {
        let entry = &mut entries[index];
        let entry_id = entry.get("id").and_then(Value::as_str).map(str::to_owned);
        if let Some(message) = entry.get_mut("message").map(Value::take) {
            branch.push(message_with_entry_id(message, entry_id.as_deref()));
        }
    }
    Value::Array(branch)
}

pub(crate) fn message_with_entry_id(mut message: Value, entry_id: Option<&str>) -> Value {
    let role = message.get("role").and_then(Value::as_str);
    if role != Some("user") && role != Some("assistant") {
        return message;
    }
    let Some(entry_id) = entry_id else {
        return message;
    };
    if let Some(object) = message.as_object_mut() {
        object.insert("entryId".to_owned(), Value::String(entry_id.to_owned()));
    }
    message
}

pub(crate) async fn dispatch(
    action: RoutedAction,
    state: &HostState,
) -> Result<Value, (&'static str, String)> {
    match action {
        RoutedAction::Runtime {
            client_id,
            request_id,
            mut frame,
        } => {
            if frame.get("type").and_then(Value::as_str) == Some("runtime_snapshot_request") {
                let session_id = frame
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ("invalid_session", "sessionId is required".into()))?;
                let mut target = state
                    .runtimes
                    .target_for_session_id(session_id)
                    .ok_or_else(|| {
                        ("runtime_not_found", "Runtime session is not running".into())
                    })?;
                let mut state_response = state
                    .runtimes
                    .request(
                        &target,
                        json!({ "type": "get_state" }),
                        None,
                        Duration::from_secs(10),
                    )
                    .await
                    .map_err(|message| ("snapshot_failed", message))?;
                if target.session_id.starts_with("temporary-") {
                    if let Some(formal_session_id) = state_response
                        .pointer("/data/sessionId")
                        .and_then(Value::as_str)
                        .filter(|session_id| !session_id.is_empty())
                    {
                        target = state
                            .runtimes
                            .bind_session_id(&target, formal_session_id)
                            .map_err(|message| ("session_binding_failed", message))?;
                    }
                }
                let entries_response = state
                    .runtimes
                    .request(
                        &target,
                        json!({ "type": "get_entries" }),
                        None,
                        Duration::from_secs(10),
                    )
                    .await
                    .map_err(|message| ("snapshot_failed", message))?;
                let messages = messages_from_entries_response_owned(entries_response);
                let host_snapshot = state
                    .runtimes
                    .snapshot(&target)
                    .map_err(|message| ("snapshot_failed", message))?;
                return Ok(json!({
                    "type": "runtime_snapshot",
                    "requestId": request_id,
                    "target": target,
                    "sequence": host_snapshot.sequence,
                    "state": {
                        "lifecycle": host_snapshot.state,
                        "pi": state_response.get_mut("data").map(Value::take).unwrap_or(Value::Null),
                        "messages": messages,
                    }
                }));
            }
            if frame.get("type").and_then(Value::as_str) == Some("runtime_capabilities_request") {
                return Ok(json!({
                    "type": "runtime_capabilities",
                    "requestId": request_id,
                    "protocolVersion": PROTOCOL_VERSION,
                    "nativeRpc": true,
                    "extensionUi": true,
                    "sessionTree": true,
                    "oauth": false,
                    "hostDataPlane": true,
                    "sourcePreservingFork": false,
                }));
            }
            if frame.get("type").and_then(Value::as_str) == Some("runtime_rebind_session_request") {
                let target: RuntimeTarget = serde_json::from_value(
                    frame
                        .get_mut("target")
                        .map(Value::take)
                        .ok_or_else(|| ("invalid_target", "Runtime target is required".into()))?,
                )
                .map_err(|_| ("invalid_target", "Runtime target is invalid".into()))?;
                let new_session_id = frame
                    .get("newSessionId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ("invalid_session_id", "newSessionId is required".into()))?;
                let rebound = state
                    .runtimes
                    .rebind_session_id(&target, new_session_id)
                    .map_err(|message| ("session_rebind_failed", message))?;
                return Ok(json!({
                    "type": "runtime_response",
                    "requestId": request_id,
                    "acceptance": "completed",
                    "response": { "success": true, "data": { "target": rebound } },
                }));
            }
            if frame.get("type").and_then(Value::as_str) != Some("runtime_request") {
                return Err((
                    "unsupported_runtime_request",
                    "Unsupported runtime request".into(),
                ));
            }
            let target: RuntimeTarget = serde_json::from_value(
                frame
                    .get_mut("target")
                    .map(Value::take)
                    .ok_or_else(|| ("invalid_target", "Runtime target is required".into()))?,
            )
            .map_err(|_| ("invalid_target", "Runtime target is invalid".into()))?;
            let command = frame
                .get_mut("command")
                .map(Value::take)
                .ok_or_else(|| ("invalid_command", "Runtime command is required".into()))?;
            let timeout = runtime_request_timeout(&command);
            if state.acp.owns(&target) {
                if command.get("type").and_then(Value::as_str) == Some("acp_permission_response") {
                    state
                        .acp
                        .respond_permission(&target, command)
                        .await
                        .map_err(|message| ("acp_permission_response_failed", message))?;
                    return Ok(json!({
                        "type": "runtime_response",
                        "requestId": request_id,
                        "acceptance": "completed",
                        "response": { "success": true },
                    }));
                }
                let response = state
                    .acp
                    .request(&target, command, timeout)
                    .await
                    .map_err(|message| ("runtime_request_failed", message))?;
                return Ok(json!({
                    "type": "runtime_response",
                    "requestId": request_id,
                    "acceptance": "accepted",
                    "response": response,
                }));
            }
            if command.get("type").and_then(Value::as_str) == Some("extension_ui_response") {
                let is_owner = state
                    .session_owners
                    .lock()
                    .map_err(|_| {
                        (
                            "dialog_owner_unavailable",
                            "Dialog owner unavailable".into(),
                        )
                    })?
                    .get(&target)
                    .is_some_and(|owner| owner == &client_id);
                if !is_owner {
                    return Err((
                        "dialog_response_forbidden",
                        "Only the owning client may answer this dialog".into(),
                    ));
                }
                state
                    .runtimes
                    .respond_extension_ui(&target, command)
                    .await
                    .map_err(|message| ("dialog_response_failed", message))?;
                return Ok(json!({
                    "type": "runtime_response",
                    "requestId": request_id,
                    "acceptance": "completed",
                    "response": { "success": true },
                }));
            }
            let idempotency_key = frame.get("idempotencyKey").and_then(Value::as_str);
            if let Ok(mut owners) = state.session_owners.lock() {
                owners.insert(target.clone(), client_id);
            }
            let response = state
                .runtimes
                .request(&target, command, idempotency_key, timeout)
                .await
                .map_err(|message| ("runtime_request_failed", message))?;
            Ok(json!({
                "type": "runtime_response",
                "requestId": request_id,
                "acceptance": "accepted",
                "response": response,
            }))
        }
        RoutedAction::Git {
            client_id,
            request_id,
            frame,
        } => {
            host_git::dispatch(
                &state.git_service,
                &state.data,
                &state.pi_launch,
                &state.git_events,
                &client_id,
                &request_id,
                &frame,
            )
            .await
        }
        RoutedAction::Terminal {
            client_id,
            request_id,
            frame,
        } => {
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| ("invalid_workspace", "workspaceId is required".into()))?;
            let workspace_root = state
                .data
                .workspace_root_path(workspace_id)
                .map_err(host_data_error)?;
            let payload = frame
                .get("payload")
                .ok_or_else(|| ("invalid_terminal_command", "payload is required".into()))?;
            let owner = OwnerId::from_client_id(&client_id);
            let mut response = state
                .terminal_manager
                .dispatch(&owner, &workspace_root, payload)
                .map_err(|message| ("terminal_command_failed", message))?;
            if let Some(object) = response.as_object_mut() {
                object.insert("requestId".into(), Value::String(request_id));
            }
            Ok(response)
        }
        RoutedAction::Host {
            client_id,
            request_id,
            operation,
            frame,
            ..
        } => dispatch_host_operation(state, &client_id, &request_id, &operation, &frame).await,
        RoutedAction::Data {
            request_id, frame, ..
        } => dispatch_data_operation(request_id, frame, state).await,
        RoutedAction::Subscribe { request_id, .. } => Ok(json!({
            "type": "runtime_subscribed",
            "requestId": request_id,
        })),
    }
}
