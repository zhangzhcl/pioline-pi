use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use super::files::FilePreviewQuery;
use crate::host_server::{api_error, host_data_http_error, HostState};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusQuery {
    pub workspace_id: String,
}

pub async fn git_status(
    State(state): State<Arc<HostState>>,
    Query(query): Query<GitStatusQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let result = state
        .data
        .git_status(&query.workspace_id)
        .map_err(host_data_http_error)?;
    serde_json::to_value(result)
        .map(Json)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))
}

pub async fn git_file_diff(
    State(state): State<Arc<HostState>>,
    Query(query): Query<FilePreviewQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let result = state
        .data
        .git_file_diff(&query.workspace_id, &query.path)
        .map_err(host_data_http_error)?;
    serde_json::to_value(result)
        .map(Json)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))
}

pub async fn git_stat_handler(
    State(state): State<Arc<HostState>>,
    Query(query): Query<GitStatusQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let result = state
        .data
        .git_stat(&query.workspace_id)
        .map_err(host_data_http_error)?;
    serde_json::to_value(result)
        .map(Json)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))
}
