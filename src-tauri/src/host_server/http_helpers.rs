// Host HTTP 鉴权判断、Loopback 校验与错误响应构造辅助函数。

use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{ConnectInfo, Json};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use serde_json::{json, Value};

use crate::host_data::HostDataError;

pub(crate) fn host_data_error(error: HostDataError) -> (&'static str, String) {
    match error {
        HostDataError::UnknownWorkspace => {
            ("workspace_not_found", "Workspace is not registered".into())
        }
        HostDataError::InvalidRelativePath | HostDataError::OutsideWorkspace => (
            "path_outside_workspace",
            "Requested path is outside the registered workspace".into(),
        ),
        HostDataError::NotDirectory => (
            "not_a_directory",
            "Requested path is not a directory".into(),
        ),
        HostDataError::NotFile => ("not_a_file", "Requested path is not a file".into()),
        HostDataError::InvalidMentionQuery => (
            "invalid_mention_query",
            "File mention query is invalid".into(),
        ),
        HostDataError::Io(message) => ("file_access_failed", message),
    }
}

pub(crate) fn host_data_http_error(error: HostDataError) -> (StatusCode, Json<Value>) {
    let status = match error {
        HostDataError::UnknownWorkspace => StatusCode::NOT_FOUND,
        HostDataError::InvalidRelativePath
        | HostDataError::OutsideWorkspace
        | HostDataError::NotDirectory
        | HostDataError::NotFile
        | HostDataError::InvalidMentionQuery => StatusCode::BAD_REQUEST,
        HostDataError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let (code, _) = host_data_error(error);
    api_error(status, code)
}

pub(crate) fn is_public_http_request(method: &Method, path: &str) -> bool {
    if !path.starts_with("/v2/") && !path.starts_with("/api/") && !path.starts_with("/health/") {
        return true;
    }
    (method == Method::GET && matches!(path, "/health" | "/v2/ws"))
        || (method == Method::POST
            && (matches!(path, "/v2/auth/device-requests")
                || (path.starts_with("/v2/auth/device-requests/") && path.ends_with("/claim"))))
}

fn loopback_peer(peer: ConnectInfo<std::net::SocketAddr>) -> bool {
    peer.0.ip().is_loopback()
}

fn loopback_authority(headers: &HeaderMap, uri: &Uri) -> bool {
    let authority = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .or_else(|| uri.authority().map(axum::http::uri::Authority::as_str));
    let Some(authority) = authority else {
        return false;
    };
    let Ok(authority) = axum::http::uri::Authority::from_str(authority) else {
        return false;
    };
    let host = authority.host().trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

pub(crate) fn trusted_loopback_request(
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: &HeaderMap,
    uri: &Uri,
) -> bool {
    loopback_peer(peer) && loopback_authority(headers, uri)
}

pub(crate) fn api_error(status: StatusCode, code: &'static str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": { "code": code } })))
}

pub(crate) fn api_error_with_detail(
    status: StatusCode,
    code: &'static str,
    message: &str,
) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
}

pub(crate) fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
