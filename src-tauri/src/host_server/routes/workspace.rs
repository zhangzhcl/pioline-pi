use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::host_data::HostDataError;
use crate::host_server::{api_error, host_data_http_error, HostState};
use crate::runtime_coordinator::RuntimeTarget;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfoQuery {
    pub workspace_id: Option<String>,
    pub workspace_path: Option<String>,
}

pub async fn workspace_info_handler(
    State(state): State<Arc<HostState>>,
    Query(query): Query<WorkspaceInfoQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // The sidebar passes the workspace's on-disk path (projectPath), not
    // the internal workspace ID. Try both: first by workspace_id (when
    // available), then fall back to treating workspace_path as the root.
    let result = if let Some(ws_id) = &query.workspace_id {
        state.data.workspace_info(ws_id)
    } else if let Some(ws_path) = &query.workspace_path {
        state.data.workspace_info_by_path(ws_path)
    } else {
        Err(HostDataError::UnknownWorkspace)
    }
    .map_err(host_data_http_error)?;
    serde_json::to_value(result)
        .map(Json)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionRequest {
    pub workspace_id: String,
}

/// POST /v2/new-session — spawn a fresh temporary runtime for `workspaceId`.
/// Used by LAN/remote clients that cannot invoke Tauri native commands.
pub async fn new_session(
    State(state): State<Arc<HostState>>,
    Json(body): Json<NewSessionRequest>,
) -> Result<Json<RuntimeTarget>, (StatusCode, Json<Value>)> {
    // "default" (or empty) targets the always-registered home workspace so a
    // plain new chat never depends on client-side workspace-id resolution.
    let workspace_id = match body.workspace_id.trim() {
        "" | "default" => state
            .data
            .default_workspace_id()
            .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "default_workspace_unavailable"))?,
        explicit => explicit.to_owned(),
    };
    let cwd = state
        .data
        .workspace_root_path(&workspace_id)
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "workspace_not_found"))?;
    let session_id = format!("temporary-{}", uuid::Uuid::new_v4().simple());
    let instance_id = format!("instance-{}", uuid::Uuid::new_v4().simple());
    let target = RuntimeTarget::new(workspace_id, session_id, instance_id);
    let cwd_str = cwd.to_string_lossy().into_owned();
    let launch = state
        .pi_launch
        .native_launch_spec(&cwd_str, None)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "launch_spec_failed"))?;
    state
        .runtimes
        .spawn(target.clone(), &launch)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "runtime_spawn_failed"))?;
    Ok(Json(target))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveWorkspaceRequest {
    pub project_path: String,
}

pub fn resolve_workspace_path(
    state: &HostState,
    project_path: &str,
) -> Result<String, &'static str> {
    let path = PathBuf::from(project_path);
    if !path.is_dir() {
        return Err("project_not_found");
    }
    let workspace_id = state
        .auth
        .lock()
        .map_err(|_| "auth_unavailable")?
        .resolve_workspace(&path)
        .map_err(|_| "workspace_resolve_failed")?;
    state
        .data
        .register_workspace(&workspace_id, &path)
        .map_err(|_| "workspace_register_failed")?;
    Ok(workspace_id)
}

/// POST /v2/resolve-workspace — map a project path to its stable workspace id
/// and register the workspace root so subsequent `/v2/bootstrap` calls can
/// lazily resume its sessions. Used by LAN/mobile clients switching to a
/// session that belongs to a different project (no Tauri window mechanism).
pub async fn resolve_workspace(
    State(state): State<Arc<HostState>>,
    Json(body): Json<ResolveWorkspaceRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let workspace_id = resolve_workspace_path(&state, &body.project_path).map_err(|code| {
        let status = if code == "project_not_found" {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        api_error(status, code)
    })?;
    Ok(Json(json!({ "workspaceId": workspace_id })))
}
