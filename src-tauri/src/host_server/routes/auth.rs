use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Json, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{json, Value};

use super::health::local_lan_url_with_port;
use crate::host_server::{api_error, now_seconds, trusted_loopback_request, HostState};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRequestBody {
    pub device_id: String,
    pub device_name: String,
    pub claim_secret: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceClaimBody {
    pub device_id: String,
    pub claim_secret: String,
}

pub fn no_store_json(status: StatusCode, value: Value) -> Response {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(value.to_string()))
        .expect("JSON response is valid")
}

pub async fn remote_access(
    State(state): State<Arc<HostState>>,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !trusted_loopback_request(peer, &headers, &uri) {
        return Err(api_error(StatusCode::FORBIDDEN, "loopback_required"));
    }
    let port = state.port;
    let base_url = local_lan_url_with_port(port).unwrap_or_default();
    if base_url.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "No LAN interface found" })),
        ));
    }
    // The QR is navigation only. It deliberately encodes the stable launcher
    // URL and never contains a session path, pairing secret, or device token.
    let url = format!("{}/app", base_url.trim_end_matches('/'));
    let code = qrcode::QrCode::new(url.as_bytes()).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("QR encode failed: {e}") })),
        )
    })?;
    let svg_str = code
        .render()
        .min_dimensions(200, 200)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(svg_str.as_bytes());
    let data_url = format!("data:image/svg+xml;base64,{b64}");
    Ok(Json(json!({ "dataUrl": data_url, "url": url })))
}

pub async fn create_device_request(
    State(state): State<Arc<HostState>>,
    Json(body): Json<DeviceRequestBody>,
) -> Response {
    let result = state
        .auth
        .lock()
        .map_err(|_| "auth_unavailable")
        .and_then(|mut auth| {
            auth.create_device_request(
                &body.device_id,
                &body.device_name,
                &body.claim_secret,
                now_seconds(),
            )
            .map_err(|error| match error {
                crate::remote_auth::DeviceRequestError::Capacity => "request_capacity",
                crate::remote_auth::DeviceRequestError::RateLimited => "rate_limited",
                crate::remote_auth::DeviceRequestError::Invalid => "invalid_request",
                _ => "request_rejected",
            })
        });
    match result {
        Ok(created) => no_store_json(
            StatusCode::CREATED,
            json!({
                "requestId": created.request_id,
                "expiresAt": created.expires_at,
                "pollAfterMs": 1500,
            }),
        ),
        Err(code) => no_store_json(
            if code == "invalid_request" {
                StatusCode::BAD_REQUEST
            } else if code == "rate_limited" {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            json!({ "error": { "code": code } }),
        ),
    }
}

pub async fn list_device_requests(
    State(state): State<Arc<HostState>>,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !trusted_loopback_request(peer, &headers, &uri) {
        return no_store_json(
            StatusCode::FORBIDDEN,
            json!({ "error": { "code": "loopback_required" } }),
        );
    }
    match state.auth.lock() {
        Ok(mut auth) => no_store_json(
            StatusCode::OK,
            json!({ "requests": auth.list_device_requests(now_seconds()) }),
        ),
        Err(_) => no_store_json(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": { "code": "auth_unavailable" } }),
        ),
    }
}

pub async fn decide_device_request(
    State(state): State<Arc<HostState>>,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    request_id: axum::extract::Path<String>,
    approve: bool,
) -> Response {
    if !trusted_loopback_request(peer, &headers, &uri) {
        return no_store_json(
            StatusCode::FORBIDDEN,
            json!({ "error": { "code": "loopback_required" } }),
        );
    }
    let result = state
        .auth
        .lock()
        .map_err(|_| crate::remote_auth::DeviceRequestError::Storage("auth unavailable".into()))
        .and_then(|mut auth| auth.decide_device_request(&request_id, approve, now_seconds()));
    match result {
        Ok(()) => no_store_json(
            StatusCode::OK,
            json!({ "status": if approve { "approved" } else { "denied" } }),
        ),
        Err(
            crate::remote_auth::DeviceRequestError::NotFound
            | crate::remote_auth::DeviceRequestError::Denied
            | crate::remote_auth::DeviceRequestError::Expired,
        ) => no_store_json(
            StatusCode::GONE,
            json!({ "error": { "code": "already_handled" } }),
        ),
        Err(_) => no_store_json(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": { "code": "auth_unavailable" } }),
        ),
    }
}

pub async fn approve_device_request(
    state: State<Arc<HostState>>,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    request_id: axum::extract::Path<String>,
) -> Response {
    decide_device_request(state, peer, headers, uri, request_id, true).await
}

pub async fn deny_device_request(
    state: State<Arc<HostState>>,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    request_id: axum::extract::Path<String>,
) -> Response {
    decide_device_request(state, peer, headers, uri, request_id, false).await
}

pub async fn claim_device_request(
    State(state): State<Arc<HostState>>,
    axum::extract::Path(request_id): axum::extract::Path<String>,
    Json(body): Json<DeviceClaimBody>,
) -> Response {
    let result = state
        .auth
        .lock()
        .map_err(|_| crate::remote_auth::DeviceRequestError::Storage("auth unavailable".into()))
        .and_then(|mut auth| {
            auth.claim_device_request(
                &request_id,
                &body.device_id,
                &body.claim_secret,
                now_seconds(),
            )
        });
    match result {
        Ok(crate::remote_auth::DeviceClaim::Pending) => {
            no_store_json(StatusCode::ACCEPTED, json!({ "status": "pending" }))
        }
        Ok(crate::remote_auth::DeviceClaim::Approved(token)) => no_store_json(
            StatusCode::OK,
            json!({ "status": "approved", "deviceToken": token }),
        ),
        Err(crate::remote_auth::DeviceRequestError::Denied) => {
            no_store_json(StatusCode::FORBIDDEN, json!({ "status": "denied" }))
        }
        Err(
            crate::remote_auth::DeviceRequestError::Expired
            | crate::remote_auth::DeviceRequestError::NotFound,
        ) => no_store_json(
            StatusCode::GONE,
            json!({ "error": { "code": "request_expired" } }),
        ),
        Err(
            crate::remote_auth::DeviceRequestError::WrongSecret
            | crate::remote_auth::DeviceRequestError::WrongDevice,
        ) => no_store_json(
            StatusCode::UNAUTHORIZED,
            json!({ "error": { "code": "claim_rejected" } }),
        ),
        Err(crate::remote_auth::DeviceRequestError::Invalid) => no_store_json(
            StatusCode::BAD_REQUEST,
            json!({ "error": { "code": "invalid_request" } }),
        ),
        Err(_) => no_store_json(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": { "code": "auth_unavailable" } }),
        ),
    }
}
