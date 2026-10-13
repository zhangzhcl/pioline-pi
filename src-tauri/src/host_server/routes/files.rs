use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::header::{CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::host_data::WriteFileResult;
use crate::host_server::{api_error, host_data_http_error, HostState};
use crate::markitdown_preview::{ConversionOutcome, DependencyReason, INPUT_BYTE_CAP};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreviewQuery {
    pub workspace_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMentionQuery {
    pub workspace_id: String,
    pub query: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileContentRequest {
    pub workspace_id: String,
    pub path: String,
    pub content: String,
    pub expected_mtime_ms: Option<f64>,
    pub force: Option<bool>,
}

pub async fn read_file_content(
    State(state): State<Arc<HostState>>,
    Query(query): Query<FilePreviewQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if let Some(source) = state
        .data
        .read_convertible_file(&query.workspace_id, &query.path)
        .map_err(host_data_http_error)?
    {
        let mut response = json!({
            "path": source.path,
            "content": "",
            "size": source.size,
            "mtimeMs": source.mtime_ms,
            "mimeType": source.mime_type,
            "isBinary": false,
            "truncated": false,
            "editable": false,
        });
        let outcome = if source.size > INPUT_BYTE_CAP || source.bytes.len() as u64 > INPUT_BYTE_CAP
        {
            ConversionOutcome::Failed
        } else {
            state.markitdown.convert(&source.suffix, source.bytes).await
        };
        match outcome {
            ConversionOutcome::Ready(markdown) => {
                response["content"] = Value::String(markdown);
                response["previewStatus"] = Value::String("ready".into());
                response["renderAs"] = Value::String("markdown".into());
            }
            ConversionOutcome::DependencyUnavailable {
                reason,
                display_command,
            } => {
                response["previewStatus"] = Value::String("dependencyUnavailable".into());
                let (reason, python_version) = match reason {
                    DependencyReason::PythonMissing => ("pythonMissing", None),
                    DependencyReason::PythonTooOld { version } => ("pythonTooOld", Some(version)),
                    DependencyReason::MarkitdownMissing => ("markitdownMissing", None),
                    DependencyReason::MarkitdownIncompatible => ("markitdownIncompatible", None),
                };
                response["dependencyReason"] = Value::String(reason.into());
                if let Some(version) = python_version {
                    response["pythonVersion"] = Value::String(version);
                }
                if let Some(command) = display_command {
                    response["displayCommand"] = Value::String(command);
                }
            }
            ConversionOutcome::Failed => {
                response["previewStatus"] = Value::String("conversionFailed".into());
            }
        }
        return Ok(Json(response));
    }
    let content = state
        .data
        .read_file_content(&query.workspace_id, &query.path)
        .map_err(host_data_http_error)?;
    serde_json::to_value(content)
        .map(Json)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))
}

pub async fn raw_file_content(
    State(state): State<Arc<HostState>>,
    Query(query): Query<FilePreviewQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let raw = state
        .data
        .raw_file_content(&query.workspace_id, &query.path)
        .map_err(host_data_http_error)?;
    let mut response = Response::new(Body::from(raw.bytes));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&raw.mime_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&raw.size.to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'; style-src 'unsafe-inline'"),
    );
    Ok(response)
}

pub async fn file_mentions(
    State(state): State<Arc<HostState>>,
    Query(query): Query<FileMentionQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let result = state
        .data
        .search_file_mentions(&query.workspace_id, &query.query)
        .map_err(host_data_http_error)?;
    serde_json::to_value(result)
        .map(Json)
        .map_err(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "serialization_failed"))
}

pub async fn write_file_content(
    State(state): State<Arc<HostState>>,
    Json(body): Json<WriteFileContentRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let force = body.force.unwrap_or(false);
    let Some(expected_mtime_ms) = body.expected_mtime_ms.or_else(|| force.then_some(0.0)) else {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "expected_mtime_ms_required",
        ));
    };
    match state
        .data
        .write_file_content(
            &body.workspace_id,
            &body.path,
            &body.content,
            expected_mtime_ms,
            force,
        )
        .map_err(host_data_http_error)?
    {
        WriteFileResult::Saved { size, mtime_ms } => Ok(Json(json!({
            "path": body.path,
            "size": size,
            "mtimeMs": mtime_ms,
        }))),
        WriteFileResult::Conflict => Err(api_error(StatusCode::CONFLICT, "conflict")),
        WriteFileResult::Invalid => Err(api_error(StatusCode::BAD_REQUEST, "invalid_file")),
    }
}
