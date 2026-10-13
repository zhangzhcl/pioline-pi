use super::super::{
    runtime_request_timeout, HostServer, RUNTIME_INTERACTIVE_REQUEST_TIMEOUT,
    RUNTIME_REQUEST_TIMEOUT,
};
use crate::metadata_store::MetadataStore;
use crate::native_pi_manager::NativePiManager;
use crate::remote_auth::RemoteAuth;
use crate::runtime_coordinator::RuntimeTarget;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[tokio::test]
async fn health_runtime_reports_zero_runtimes_when_idle() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-runtime-{nonce}"));
    let public = temp.join("public");
    fs::create_dir_all(&public).unwrap();
    fs::write(public.join("index.html"), "<h1>Picot native host</h1>").unwrap();
    let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
    let host = HostServer::start(public, NativePiManager::new(32), auth, None)
        .await
        .unwrap();

    let body: serde_json::Value = reqwest::get(format!("{}/health/runtime", host.origin()))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["runtimeCount"], 0);
    assert!(body["runtimes"].as_array().unwrap().is_empty());

    host.stop().await;
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn health_model_test_reports_connectivity_failure_for_unreachable_provider() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-model-test-{nonce}"));
    let public = temp.join("public");
    fs::create_dir_all(&public).unwrap();
    fs::write(public.join("index.html"), "<h1>Picot native host</h1>").unwrap();
    let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
    let host = HostServer::start(public, NativePiManager::new(32), auth, None)
        .await
        .unwrap();

    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/health/models/test", host.origin()))
        .json(&json!({
            "providerName": "probe-unreachable",
            "provider": {
                "baseUrl": "https://model-test.invalid",
                "api": "openai-completions",
                "apiKey": "literal-test-key",
            },
            "model": { "id": "does-not-matter" },
        }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["ok"], false);
    assert!(body["error"].as_str().is_some());

    host.stop().await;
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn health_model_test_rejects_missing_model_id() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-model-test-invalid-{nonce}"));
    let public = temp.join("public");
    fs::create_dir_all(&public).unwrap();
    fs::write(public.join("index.html"), "<h1>Picot native host</h1>").unwrap();
    let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
    let host = HostServer::start(public, NativePiManager::new(32), auth, None)
        .await
        .unwrap();

    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/health/models/test", host.origin()))
        .json(&json!({
            "providerName": "probe",
            "provider": {},
            "model": {},
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);

    host.stop().await;
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn bearer_authenticated_external_authority_cannot_retrieve_remote_access() {
    use axum::http::header::HOST;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-ws-auth-boundary-{nonce}"));
    let public = temp.join("public");
    fs::create_dir_all(&public).unwrap();
    fs::write(public.join("index.html"), "Picot").unwrap();
    let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
    let host = HostServer::start(public, NativePiManager::new(32), auth, None)
        .await
        .unwrap();
    let token = "picot_device_invalid";
    let response = reqwest::Client::new()
        .get(format!("{}/v2/remote-access", host.origin()))
        .header(HOST, "remote.example")
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);

    host.stop().await;
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn sends_runtime_events_only_after_an_explicit_target_subscription() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-ws-{nonce}"));
    let public = temp.join("public");
    fs::create_dir_all(&public).unwrap();
    fs::write(public.join("index.html"), "Picot").unwrap();
    let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
    let runtimes = NativePiManager::new(32);
    let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
    let fake = runtimes.register_in_memory(target.clone()).unwrap();
    let host = HostServer::start(public, runtimes, auth, None)
        .await
        .unwrap();
    let ws_url = host.origin().replace("http://", "ws://") + "/v2/ws";
    let (mut socket, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            json!({
                "type": "hello",
                "protocolVersion": 2,
                "clientType": "desktop",
                "clientId": "desktop-a"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    socket.next().await.unwrap().unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            json!({
                "type": "runtime_subscribe",
                "requestId": "subscribe-1",
                "target": target,
            })
            .to_string(),
        ))
        .await
        .unwrap();
    socket.next().await.unwrap().unwrap();

    fake.write_frame(json!({ "type": "agent_start" }))
        .await
        .unwrap();
    let event = tokio::time::timeout(std::time::Duration::from_secs(1), socket.next())
        .await
        .expect("subscribed runtime event")
        .unwrap()
        .unwrap();
    let event: serde_json::Value = serde_json::from_str(event.to_text().unwrap()).unwrap();
    assert_eq!(event["type"], "runtime_event");
    assert_eq!(event["target"]["sessionId"], "session-a");
    assert_eq!(event["sequence"], 1);

    socket.close(None).await.unwrap();
    drop(socket);
    drop(fake);
    host.stop().await;
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn prompts_get_the_interactive_deadline_and_everything_else_the_short_one() {
    assert_eq!(
        runtime_request_timeout(&json!({ "type": "prompt", "message": "/plan" })),
        RUNTIME_INTERACTIVE_REQUEST_TIMEOUT
    );
    assert_eq!(
        runtime_request_timeout(&json!({ "type": "get_commands" })),
        RUNTIME_REQUEST_TIMEOUT
    );
    assert_eq!(
        runtime_request_timeout(&json!({ "type": "steer", "message": "stop" })),
        RUNTIME_REQUEST_TIMEOUT
    );
    assert_eq!(runtime_request_timeout(&json!({})), RUNTIME_REQUEST_TIMEOUT);
}

#[tokio::test]
async fn routes_preference_operations_through_host_requests() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-pref-{nonce}"));
    let public = temp.join("public");
    fs::create_dir_all(&public).unwrap();
    fs::write(public.join("index.html"), "Picot").unwrap();
    let metadata = Arc::new(Mutex::new(
        MetadataStore::open(&temp.join("picot.sqlite3")).unwrap(),
    ));
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(
        MetadataStore::open(&temp.join("auth.sqlite3")).unwrap(),
    )))));
    let runtimes = NativePiManager::new(32);
    let host = HostServer::start_with_workspaces(
        public,
        runtimes,
        auth,
        std::collections::HashMap::new(),
        None,
        Some(Arc::clone(&metadata)),
    )
    .await
    .unwrap();
    let ws_url = host.origin().replace("http://", "ws://") + "/v2/ws";
    let (mut socket, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            json!({
                "type": "hello",
                "protocolVersion": 2,
                "clientType": "desktop",
                "clientId": "desktop-a"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    socket.next().await.unwrap().unwrap();

    async fn preference_request(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        frame: serde_json::Value,
    ) -> serde_json::Value {
        use futures_util::{SinkExt, StreamExt};
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                frame.to_string(),
            ))
            .await
            .unwrap();
        loop {
            let message = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
                .await
                .expect("preference response")
                .unwrap()
                .unwrap();
            let frame: serde_json::Value =
                serde_json::from_str(message.to_text().unwrap()).unwrap();
            if frame["type"] == "host_response" || frame["type"] == "error" {
                return frame;
            }
        }
    }

    let set_response = preference_request(
        &mut socket,
        json!({
            "type": "host_request",
            "requestId": "pref-1",
            "operation": "set_preference",
            "key": "ui.chatFontSize",
            "value": "large",
        }),
    )
    .await;
    assert_eq!(set_response["type"], "host_response");
    assert_eq!(set_response["operation"], "set_preference");
    assert_eq!(
        metadata
            .lock()
            .unwrap()
            .preference_get("ui.chatFontSize")
            .unwrap(),
        Some(json!("large"))
    );

    let get_response = preference_request(
        &mut socket,
        json!({
            "type": "host_request",
            "requestId": "pref-2",
            "operation": "get_preference",
            "key": "ui.chatFontSize",
        }),
    )
    .await;
    assert_eq!(get_response["value"], json!("large"));

    let missing = preference_request(
        &mut socket,
        json!({
            "type": "host_request",
            "requestId": "pref-3",
            "operation": "get_preference",
            "key": "ui.missingKey",
        }),
    )
    .await;
    assert!(missing["value"].is_null());

    let rejected = preference_request(
        &mut socket,
        json!({
            "type": "host_request",
            "requestId": "pref-4",
            "operation": "set_preference",
            "key": "agent.thinkingLevel",
            "value": "high",
        }),
    )
    .await;
    assert_eq!(rejected["type"], "error");
    assert_eq!(rejected["error"]["code"], "invalid_preference");

    let removed = preference_request(
        &mut socket,
        json!({
            "type": "host_request",
            "requestId": "pref-5",
            "operation": "remove_preference",
            "key": "ui.chatFontSize",
        }),
    )
    .await;
    assert_eq!(removed["removed"], json!(true));
    assert_eq!(
        metadata
            .lock()
            .unwrap()
            .preference_get("ui.chatFontSize")
            .unwrap(),
        None
    );

    socket.close(None).await.unwrap();
    drop(socket);
    drop(metadata);
    host.stop().await;
    fs::remove_dir_all(temp).unwrap();
}
