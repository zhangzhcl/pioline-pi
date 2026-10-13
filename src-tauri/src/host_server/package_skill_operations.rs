// Pi 包管理（列表、更新检查、安装、卸载、启停）与技能源目录选择、扫描、软链安装操作。

use serde_json::{json, Value};
use tauri_plugin_dialog::DialogExt;

use crate::pi_launch::set_package_disabled;
use crate::window_owner::OwnerId;

use super::super::{host_data_error, HostState};

pub(super) async fn dispatch_package_or_skill_operation(
    state: &HostState,
    client_id: &str,
    request_id: &str,
    operation: &str,
    frame: &Value,
) -> Result<Value, (&'static str, String)> {
    match operation {
        "list_pi_packages" => {
            let resolver = state.pi_launch.clone();
            let packages = tokio::task::spawn_blocking(move || resolver.list_pi_packages())
                .await
                .map_err(|error| ("host_operation_failed", error.to_string()))?
                .map_err(|message| ("list_pi_packages_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "list_pi_packages",
                "packages": packages,
            }))
        }
        "check_pi_package_updates" => {
            let workspace_root = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .and_then(|id| state.data.workspace_root_path(id).ok());
            let resolver = state.pi_launch.clone();
            let packages = tokio::task::spawn_blocking(move || resolver.list_pi_packages())
                .await
                .map_err(|error| ("host_operation_failed", error.to_string()))?
                .map_err(|message| ("list_pi_packages_failed", message))?;
            // npm 探测以工作区作为 cwd 执行，以遵循项目级 npmCommand 与 .npmrc 配置。
            let updates = crate::package_updates::check_available_updates(
                &packages,
                workspace_root.as_deref(),
            )
            .await;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "check_pi_package_updates",
                "updates": updates,
            }))
        }
        "install_pi_package" | "remove_pi_package" | "update_pi_package" => {
            let source = frame
                .get("source")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_source", "Package source cannot be empty".into()))?
                .to_owned();
            let local = frame.get("local").and_then(Value::as_bool).unwrap_or(false);
            let resolver = state.pi_launch.clone();
            let operation = operation.to_string();
            let operation_ref = operation.clone();
            tokio::task::spawn_blocking(move || match operation_ref.as_str() {
                "install_pi_package" => resolver.install_pi_package(&source, local),
                "remove_pi_package" => resolver.remove_pi_package(&source, local),
                "update_pi_package" => resolver.update_pi_package(&source),
                _ => unreachable!(),
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("package_operation_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": operation,
                "ok": true,
            }))
        }
        "set_pi_package_disabled" => {
            let source = frame
                .get("source")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_source", "Package source cannot be empty".into()))?
                .to_owned();
            let disabled = frame
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let scope = frame
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or("global")
                .to_owned();
            let cwd = frame
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let changed = tokio::task::spawn_blocking(move || {
                set_package_disabled(&scope, &cwd, &source, disabled)
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("set_pi_package_disabled_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "set_pi_package_disabled",
                "ok": true,
                "changed": changed,
            }))
        }
        "pick_skill_source" => {
            let Some(app) = state.app_handle.clone() else {
                return Err((
                    "host_operation_failed",
                    "Folder picker is not available".into(),
                ));
            };
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    (
                        "invalid_workspace",
                        "workspaceId is required to pick a skill source".into(),
                    )
                })?
                .to_owned();
            let workspace_root = state
                .data
                .workspace_root_path(&workspace_id)
                .map_err(host_data_error)?;
            let owner_id = OwnerId::from_client_id(client_id);
            let port = state.port;
            let generation = 0u64;
            let window_label = client_id.to_owned();
            let path =
                tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
                    .await
                    .map_err(|error| ("host_operation_failed", error.to_string()))?;
            let Some(picked) = path else {
                return Ok(json!({
                    "type": "host_response",
                    "requestId": request_id,
                    "operation": "pick_skill_source",
                    "sourceId": null,
                }));
            };
            let canonical_path = picked
                .as_path()
                .ok_or_else(|| ("invalid_path", "Selected folder is not a local path".into()))?
                .to_path_buf();
            let registry = state.skill_registry.clone();
            let source_id = tokio::task::spawn_blocking(move || {
                registry.issue(
                    owner_id,
                    window_label,
                    &workspace_root,
                    port,
                    generation,
                    &canonical_path,
                )
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("pick_skill_source_failed", message))?;
            Ok(json!({
                "type": "host_response",
                "requestId": request_id,
                "operation": "pick_skill_source",
                "sourceId": source_id,
            }))
        }
        "skill_scan_install_source" => {
            let source_id = frame
                .get("sourceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_source", "sourceId is required".into()))?
                .to_owned();
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    (
                        "invalid_workspace",
                        "workspaceId is required to scan a skill source".into(),
                    )
                })?
                .to_owned();
            let workspace_root = state
                .data
                .workspace_root_path(&workspace_id)
                .map_err(host_data_error)?;
            let owner_id = OwnerId::from_client_id(client_id);
            let window_label = client_id.to_owned();
            let generation = 0u64;
            let registry = state.skill_registry.clone();
            let binding = tokio::task::spawn_blocking(move || {
                registry.resolve(
                    &source_id,
                    &owner_id,
                    &window_label,
                    &workspace_root,
                    generation,
                )
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("skill_scan_failed", message))?;
            let agent_dir = crate::pi_agent_dir::agent_dir()
                .unwrap_or_else(|| std::env::temp_dir().join(".pi").join("agent"));
            let install_secret = state.install_secret.clone();
            let context = crate::skill_install::InstallContext {
                agent_dir,
                cwd: binding.workspace_root.clone(),
                install_secret,
            };
            let result = tokio::task::spawn_blocking(move || {
                crate::skill_install::scan_install_source(&binding, &context)
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?;
            serde_json::to_value(&result)
                .map(|scan| {
                    json!({
                        "type": "host_response",
                        "requestId": request_id,
                        "operation": "skill_scan_install_source",
                        "scan": scan,
                    })
                })
                .map_err(|error| ("host_operation_failed", error.to_string()))
        }
        "skill_install_links" => {
            let source_id = frame
                .get("sourceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_source", "sourceId is required".into()))?
                .to_owned();
            let scope = frame
                .get("scope")
                .and_then(Value::as_str)
                .filter(|value| *value == "global" || *value == "project")
                .ok_or_else(|| {
                    (
                        "invalid_scope",
                        "scope must be 'global' or 'project'".into(),
                    )
                })?
                .to_owned();
            let scan_revision = frame
                .get("scanRevision")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ("invalid_revision", "scanRevision is required".into()))?
                .to_owned();
            let selection = frame
                .get("selection")
                .and_then(Value::as_array)
                .filter(|items| !items.is_empty())
                .ok_or_else(|| ("invalid_selection", "selection array is required".into()))?;
            let workspace_id = frame
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    (
                        "invalid_workspace",
                        "workspaceId is required to install skill links".into(),
                    )
                })?
                .to_owned();
            let parsed_selection: Vec<crate::skill_install::InstallCandidateSelection> = selection
                .iter()
                .map(|item| {
                    let kind = item
                        .get("kind")
                        .and_then(Value::as_str)
                        .filter(|k| *k == "group" || *k == "skill")
                        .ok_or("invalid selection entry: kind")?;
                    let id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|v| !v.is_empty())
                        .ok_or("invalid selection entry: id")?;
                    Ok(crate::skill_install::InstallCandidateSelection {
                        kind: kind.to_string(),
                        id: id.to_string(),
                    })
                })
                .collect::<Result<_, String>>()
                .map_err(|message| ("invalid_selection", message))?;
            let workspace_root = state
                .data
                .workspace_root_path(&workspace_id)
                .map_err(host_data_error)?;
            let owner_id = OwnerId::from_client_id(client_id);
            let window_label = client_id.to_owned();
            let generation = 0u64;
            let registry = state.skill_registry.clone();
            let binding = tokio::task::spawn_blocking(move || {
                registry.resolve(
                    &source_id,
                    &owner_id,
                    &window_label,
                    &workspace_root,
                    generation,
                )
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("skill_install_failed", message))?;
            let agent_dir = crate::pi_agent_dir::agent_dir()
                .unwrap_or_else(|| std::env::temp_dir().join(".pi").join("agent"));
            let install_secret = state.install_secret.clone();
            let context = crate::skill_install::InstallContext {
                agent_dir,
                cwd: binding.workspace_root.clone(),
                install_secret,
            };
            let binding_clone = binding.clone();
            let scope_clone = scope.clone();
            let scan_revision_clone = scan_revision.clone();
            let result = tokio::task::spawn_blocking(move || {
                crate::skill_install::install_links(
                    &binding_clone,
                    &scope_clone,
                    &scan_revision_clone,
                    &parsed_selection,
                    &context,
                )
            })
            .await
            .map_err(|error| ("host_operation_failed", error.to_string()))?
            .map_err(|message| ("skill_install_failed", message))?;
            let registry = state.skill_registry.clone();
            let _ = tokio::task::spawn_blocking(move || {
                registry.consume(
                    &binding.source_id,
                    &binding.owner_id,
                    binding.workspace_generation,
                )
            })
            .await;
            serde_json::to_value(&result)
                .map(|value| {
                    json!({
                        "type": "host_response",
                        "requestId": request_id,
                        "operation": "skill_install_links",
                        "result": value,
                    })
                })
                .map_err(|error| ("host_operation_failed", error.to_string()))
        }
        _ => unreachable!("dispatch_package_or_skill_operation called with unknown operation"),
    }
}
