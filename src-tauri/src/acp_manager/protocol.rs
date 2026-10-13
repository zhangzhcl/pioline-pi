// ABOUTME: JSON-RPC 2.0 frame handling, workspace-scoped fs/* callbacks, and
// ABOUTME: unit tests for AcpAgentManager.

use super::{AcpAgentManagerInner, NativeRuntimeEvent};
use crate::pi_rpc_bridge::PiRpcBridge;
use crate::runtime_coordinator::RuntimeTarget;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(super) fn build_prompt_blocks(command: &Value) -> Vec<Value> {
    let mut blocks = Vec::new();
    if let Some(message) = command.get("message").and_then(Value::as_str) {
        if !message.is_empty() {
            blocks.push(json!({ "type": "text", "text": message }));
        }
    }
    if let Some(images) = command.get("images").and_then(Value::as_array) {
        for image in images {
            let Some(data) = image.get("data").and_then(Value::as_str) else {
                continue;
            };
            let mime_type = image
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            blocks.push(json!({ "type": "image", "data": data, "mimeType": mime_type }));
        }
    }
    blocks
}

pub(super) fn unwrap_jsonrpc_result(mut response: Value) -> Result<Value, String> {
    if let Some(error) = response.get("error") {
        return Err(format!("ACP agent returned an error: {error}"));
    }
    Ok(response.get_mut("result").map_or(Value::Null, Value::take))
}

fn jsonrpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Resolves `path` (which ACP sends as an absolute path) against `cwd`,
/// requiring the result to stay inside the workspace root — the same scoping
/// boundary the rest of the host data plane enforces for file access.
#[cfg(test)]
pub(super) fn resolve_in_workspace(
    cwd: &Path,
    path: &str,
    require_existing: bool,
) -> Option<PathBuf> {
    let canonical_cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    resolve_in_canonical_workspace(cwd, &canonical_cwd, path, require_existing)
}

fn resolve_in_canonical_workspace(
    cwd: &Path,
    canonical_cwd: &Path,
    path: &str,
    require_existing: bool,
) -> Option<PathBuf> {
    let requested = PathBuf::from(path);
    let resolved = if requested.is_absolute() {
        requested
    } else {
        cwd.join(requested)
    };
    let canonical_target = if require_existing {
        resolved.canonicalize().ok()?
    } else {
        let parent = resolved.parent().unwrap_or(&resolved);
        let canonical_parent = parent.canonicalize().ok()?;
        match resolved.file_name() {
            Some(name) => canonical_parent.join(name),
            None => canonical_parent,
        }
    };
    canonical_target
        .starts_with(canonical_cwd)
        .then_some(canonical_target)
}

fn handle_fs_request(cwd: &Path, canonical_cwd: &Path, event: &Value) -> Value {
    let id = event.get("id").unwrap_or(&Value::Null);
    let method = event.get("method").and_then(Value::as_str).unwrap_or("");
    let params = event.get("params").unwrap_or(&Value::Null);
    let Some(path) = params.get("path").and_then(Value::as_str) else {
        return jsonrpc_error(id, -32602, "Missing path");
    };
    match method {
        "fs/read_text_file" => {
            let Some(resolved) = resolve_in_canonical_workspace(cwd, canonical_cwd, path, true)
            else {
                return jsonrpc_error(id, -32602, "Path is outside the workspace");
            };
            match std::fs::read_to_string(&resolved) {
                Ok(content) => {
                    json!({ "jsonrpc": "2.0", "id": id, "result": { "content": content } })
                }
                Err(error) => jsonrpc_error(id, -32000, &format!("Cannot read file: {error}")),
            }
        }
        "fs/write_text_file" => {
            let Some(resolved) = resolve_in_canonical_workspace(cwd, canonical_cwd, path, false)
            else {
                return jsonrpc_error(id, -32602, "Path is outside the workspace");
            };
            let content = params.get("content").and_then(Value::as_str).unwrap_or("");
            match std::fs::write(&resolved, content) {
                Ok(()) => json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null }),
                Err(error) => jsonrpc_error(id, -32000, &format!("Cannot write file: {error}")),
            }
        }
        _ => jsonrpc_error(id, -32601, "Method not found"),
    }
}

pub(super) async fn handle_agent_frame(
    inner: &Arc<AcpAgentManagerInner>,
    target: &RuntimeTarget,
    bridge: &PiRpcBridge,
    cwd: &Path,
    canonical_cwd: &Path,
    mut event: Value,
) {
    let method = event
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let has_id = event.get("id").is_some();
    match (method.as_deref(), has_id) {
        (Some("session/update"), false) => {
            let params = event.get_mut("params").map_or(Value::Null, Value::take);
            broadcast_event(
                inner,
                target,
                json!({ "type": "acp_session_update", "params": params }),
            );
        }
        (Some(method), true) if method.starts_with("fs/") => {
            let reply = handle_fs_request(cwd, canonical_cwd, &event);
            let _ = bridge.send_frame(reply).await;
        }
        (Some("session/request_permission"), true) => {
            let id = event.get_mut("id").map_or(Value::Null, Value::take);
            let request_key = format!("perm-{}", uuid::Uuid::new_v4().simple());
            if let Ok(mut pending) = inner.pending_permissions.lock() {
                pending.insert(format!("{}:{request_key}", target.instance_id), id);
            }
            let params = event.get_mut("params").map_or(Value::Null, Value::take);
            broadcast_event(
                inner,
                target,
                json!({ "type": "acp_permission_request", "requestId": request_key, "params": params }),
            );
        }
        (Some(_), true) => {
            let id = event.get("id").unwrap_or(&Value::Null);
            let _ = bridge
                .send_frame(jsonrpc_error(id, -32601, "Method not supported by Pipline"))
                .await;
        }
        _ => {}
    }
}

pub(super) fn broadcast_event(
    inner: &Arc<AcpAgentManagerInner>,
    target: &RuntimeTarget,
    event: Value,
) {
    let sequenced = {
        let Ok(mut coordinator) = inner.coordinator.lock() else {
            return;
        };
        coordinator.emit_event(target, event)
    };
    if let Ok(sequenced) = sequenced {
        let _ = inner.events.send(NativeRuntimeEvent {
            target: sequenced.target,
            sequence: sequenced.sequence,
            event: sequenced.event,
        });
    }
}

pub(super) fn remove_closed_runtime(inner: &AcpAgentManagerInner, instance_id: &str) {
    let runtime = inner
        .runtimes
        .lock()
        .ok()
        .and_then(|mut runtimes| runtimes.remove(instance_id));
    let Some(mut runtime) = runtime else {
        return;
    };
    if let Some(process) = &mut runtime.process {
        let _ = process.kill();
    }
    let target = runtime.target;
    if let Ok(mut coordinator) = inner.coordinator.lock() {
        let _ = coordinator.unregister(&target);
    }
    if let Ok(mut pending) = inner.pending_permissions.lock() {
        let prefix = format!("{}:", target.instance_id);
        pending.retain(|key, _| !key.starts_with(&prefix));
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_in_workspace;
    use crate::acp_launch;
    use crate::acp_manager::AcpAgentManager;
    use crate::runtime_coordinator::RuntimeTarget;

    #[tokio::test]
    #[ignore]
    async fn spawns_and_prompts_the_real_claude_code_acp_agent() {
        let manager = AcpAgentManager::new();
        let target = RuntimeTarget::new("workspace-real", "session-real", "instance-real");
        let cwd = std::env::current_dir().unwrap();
        let spec = acp_launch::resolve_preset("claude-code", cwd).unwrap();

        let acp_session_id = manager.spawn(target.clone(), spec).await.unwrap();
        assert!(!acp_session_id.is_empty());
        assert!(manager.owns(&target));
        let mut events = manager.subscribe();

        let response = manager
            .request(
                &target,
                serde_json::json!({
                    "type": "acp_prompt",
                    "message": "Reply with exactly the single word PONG. Do not use any tools.",
                }),
                std::time::Duration::from_secs(60),
            )
            .await
            .unwrap();
        assert_eq!(response["stopReason"], "end_turn");

        let saw_message_chunk = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.event["type"] == "acp_session_update"
                    && event.event["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
                {
                    return true;
                }
            }
        })
        .await
        .unwrap_or(false);
        assert!(
            saw_message_chunk,
            "expected at least one acp_session_update/agent_message_chunk broadcast"
        );

        manager.stop(&target).unwrap();
        assert!(!manager.owns(&target));
    }

    #[test]
    fn owns_reports_false_for_an_unregistered_target() {
        let manager = AcpAgentManager::new();
        let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
        assert!(!manager.owns(&target));
    }

    #[test]
    fn rejects_paths_that_escape_the_workspace_root() {
        let cwd = std::env::current_dir().unwrap();
        assert!(resolve_in_workspace(&cwd, "/etc/passwd", true).is_none());
        assert!(resolve_in_workspace(&cwd, "../../etc/passwd", false).is_none());
    }

    #[test]
    fn resolves_a_relative_path_inside_the_workspace() {
        let cwd = std::env::current_dir().unwrap();
        let resolved = resolve_in_workspace(&cwd, "Cargo.toml", true);
        assert_eq!(resolved, cwd.join("Cargo.toml").canonicalize().ok());
    }

    #[tokio::test]
    async fn stop_workspace_and_stop_all_unregister_runtimes_and_clear_permissions() {
        use crate::acp_manager::ManagedAcpRuntime;
        use crate::pi_rpc_bridge::PiRpcBridge;
        use crate::runtime_coordinator::RuntimeState;

        let manager = AcpAgentManager::new();
        let target_a = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
        let target_b = RuntimeTarget::new("workspace-b", "session-b", "instance-b");

        for target in [&target_a, &target_b] {
            let (bridge, _proc) = PiRpcBridge::in_memory(1024);
            manager
                .inner
                .coordinator
                .lock()
                .unwrap()
                .register(target.clone(), RuntimeState::Ready)
                .unwrap();
            manager.inner.runtimes.lock().unwrap().insert(
                target.instance_id.clone(),
                ManagedAcpRuntime {
                    target: target.clone(),
                    bridge,
                    process: None,
                    acp_session_id: format!("acp-{}", target.session_id),
                },
            );
            manager.inner.pending_permissions.lock().unwrap().insert(
                format!("{}:req-1", target.instance_id),
                serde_json::json!(1),
            );
        }

        assert!(manager.owns(&target_a));
        assert!(manager.owns(&target_b));

        manager.stop_workspace("workspace-a");
        assert!(!manager.owns(&target_a));
        assert!(manager.owns(&target_b));
        assert!(!manager
            .inner
            .pending_permissions
            .lock()
            .unwrap()
            .contains_key("instance-a:req-1"));
        assert!(manager
            .inner
            .pending_permissions
            .lock()
            .unwrap()
            .contains_key("instance-b:req-1"));

        manager.stop_all();
        assert!(!manager.owns(&target_b));
        assert!(manager.inner.pending_permissions.lock().unwrap().is_empty());
    }
}
