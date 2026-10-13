use crate::host_router::PROTOCOL_VERSION;
use crate::host_server::{api_error_with_detail, HostState};
use crate::model_health::{self, ModelTestOutcome, ModelTestRequest};
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// 返回本机第一个非回环的 IPv4 局域网地址；未找到时返回 None
pub fn local_lan_ip() -> Option<std::net::IpAddr> {
    use std::net::{IpAddr, Ipv4Addr, UdpSocket};
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let local = socket.local_addr().ok()?;
    match local.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => Some(local.ip()),
        _ => None,
    }
}

/// 格式化带有端口的局域网 HTTP 访问地址
pub fn local_lan_url_with_port(port: u16) -> Option<String> {
    local_lan_ip().map(|ip| format!("http://{ip}:{port}"))
}

/// L1 健康检查：汇报基础协议版本、内置 Pi 版本、局域网访问地址与运行实例数
pub async fn health(State(state): State<Arc<HostState>>) -> Json<Value> {
    let runtime_count = state.runtimes.statuses().map_or(0, |s| s.len());
    Json(json!({
        "status": "ok",
        "protocolVersion": PROTOCOL_VERSION,
        "piVersion": crate::pi_launch::locked_pi_version(),
        "lanUrl": local_lan_url_with_port(state.port).unwrap_or_default(),
        "runtimeCount": runtime_count,
    }))
}

/// L2 健康检查：汇报所有追踪实例的生命周期状态与分状态汇总计数
pub async fn health_runtime(
    State(state): State<Arc<HostState>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let statuses = state.runtimes.statuses().map_err(|message| {
        api_error_with_detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "statuses_unavailable",
            &message,
        )
    })?;
    let mut by_state: HashMap<String, usize> = HashMap::new();
    for status in &statuses {
        let key = serde_json::to_value(status.state)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".to_string());
        *by_state.entry(key).or_insert(0) += 1;
    }
    Ok(Json(json!({
        "status": "ok",
        "runtimeCount": statuses.len(),
        "byState": by_state,
        "runtimes": statuses,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTestBody {
    pub provider_name: String,
    pub provider: Value,
    pub model: Value,
}

/// L3 健康检查：通过沙箱化轻量执行验证模型提供商端点真实连通性
pub async fn health_model_test(
    State(state): State<Arc<HostState>>,
    Json(body): Json<ModelTestBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let request = ModelTestRequest {
        provider_name: body.provider_name,
        provider: body.provider,
        model: body.model,
    };
    let pi_launch = state.pi_launch.clone();
    let outcome = tokio::task::spawn(async move {
        model_health::run_model_test(&pi_launch, request, model_health::DEFAULT_TEST_TIMEOUT).await
    })
    .await
    .map_err(|error| {
        api_error_with_detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "model_test_panicked",
            &error.to_string(),
        )
    })?;
    match outcome {
        Ok(outcome) => Ok(Json(model_test_outcome_json(outcome))),
        Err(message) => Err(api_error_with_detail(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            &message,
        )),
    }
}

pub fn model_test_outcome_json(outcome: ModelTestOutcome) -> Value {
    serde_json::to_value(outcome)
        .unwrap_or_else(|_| json!({ "ok": false, "error": "serialization_failed" }))
}
