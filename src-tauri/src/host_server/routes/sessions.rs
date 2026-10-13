use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Redirect;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::host_server::{api_error, host_data_http_error, HostState};
use crate::runtime_coordinator::{RuntimeStatus, RuntimeTarget};

pub async fn app_launcher_redirect() -> Redirect {
    Redirect::temporary("/app")
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapQuery {
    pub workspace_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsQuery {
    pub workspace_id: String,
}

pub fn annotate_live_sessions(sessions: &mut Value, statuses: &[RuntimeStatus]) {
    let Some(items) = sessions.as_array_mut() else {
        return;
    };
    if statuses.is_empty() || items.is_empty() {
        return;
    }
    let status_by_session: std::collections::HashMap<&str, &RuntimeStatus> = statuses
        .iter()
        .map(|status| (status.target.session_id.as_str(), status))
        .collect();
    for session in items {
        let Some(session_id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(status) = status_by_session.get(session_id) else {
            continue;
        };
        session["target"] = json!(status.target);
        session["status"] = json!(status.state);
    }
}

pub async fn list_all_sessions_http(
    State(state): State<Arc<HostState>>,
    Query(query): Query<SessionsQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let sessions = state
        .data
        .list_all_sessions(&query.workspace_id)
        .map_err(host_data_http_error)?;
    let mut sessions = serde_json::to_value(sessions)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))?;
    if let Ok(statuses) = state.runtimes.statuses() {
        annotate_live_sessions(&mut sessions, &statuses);
    }
    let workspaces = serde_json::to_value(state.data.registered_workspaces())
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))?;
    Ok(Json(
        json!({ "sessions": sessions, "workspaces": workspaces }),
    ))
}

pub async fn bootstrap_target(
    State(state): State<Arc<HostState>>,
    Query(query): Query<BootstrapQuery>,
) -> Result<Json<RuntimeTarget>, (StatusCode, Json<Value>)> {
    // A live runtime already exists for this session — reuse it.
    if let Some(target) = state
        .runtimes
        .target_for_session(&query.workspace_id, &query.session_id)
    {
        return Ok(Json(target));
    }

    // Otherwise this is a historical session opened from the sidebar. Lazily
    // spawn a runtime that resumes the saved session file so its messages load
    // instead of failing with "runtime stopped/unavailable".
    let session_path = state
        .data
        .resolve_session_path(&query.workspace_id, &query.session_id)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "session_lookup_failed"))?
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "session_not_found"))?;
    let cwd = state
        .data
        .workspace_root_path(&query.workspace_id)
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "workspace_not_found"))?;
    let launch = state
        .pi_launch
        .native_launch_spec(
            &cwd.to_string_lossy(),
            Some(&session_path.to_string_lossy()),
        )
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "launch_spec_failed"))?;
    let target = RuntimeTarget::new(
        query.workspace_id,
        query.session_id,
        format!("instance-{}", uuid::Uuid::new_v4().simple()),
    );
    state
        .runtimes
        .spawn(target.clone(), &launch)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "runtime_spawn_failed"))?;
    Ok(Json(target))
}
