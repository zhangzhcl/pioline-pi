use super::super::HostServer;
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
async fn workflow_template_list_returns_authoritative_catalog_revision() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("pipline-host-workflow-catalog-{nonce}"));
    let public = temp.join("public");
    fs::create_dir_all(&public).unwrap();
    fs::write(public.join("index.html"), "Pipline").unwrap();
    let metadata = Arc::new(Mutex::new(
        MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap(),
    ));
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(
        MetadataStore::open(&temp.join("auth.sqlite3")).unwrap(),
    )))));
    let host = HostServer::start_with_workspaces(
        public,
        NativePiManager::new(32),
        auth,
        std::collections::HashMap::new(),
        None,
        Some(metadata),
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
                "clientId": "desktop-catalog-test"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    socket.next().await.unwrap().unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            json!({
                "type": "host_request",
                "requestId": "catalog-list-1",
                "operation": "list_workflow_node_templates",
                "workspaceId": "workspace-catalog-test"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let response = loop {
        let message = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
            .await
            .expect("workflow catalog response")
            .unwrap()
            .unwrap();
        let frame: serde_json::Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        if frame["requestId"] == "catalog-list-1" {
            break frame;
        }
    };
    assert_eq!(response["type"], "host_response");
    assert!(response["catalogRevision"].as_str().is_some());
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            json!({
                "type": "host_request",
                "requestId": "catalog-create-stale",
                "operation": "create_workflow_node_template",
                "workspaceId": "workspace-catalog-test",
                "expectedCatalogRevision": "catalog-v1-stale",
                "meta": {}
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let stale_create = loop {
        let message = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
            .await
            .expect("stale NodeMeta response")
            .unwrap()
            .unwrap();
        let frame: serde_json::Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        if frame["requestId"] == "catalog-create-stale" {
            break frame;
        }
    };
    assert_eq!(stale_create["type"], "error");
    assert_eq!(stale_create["error"]["code"], "workflow_catalog_conflict");
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            json!({
                "type": "host_request",
                "requestId": "catalog-cas-stale",
                "operation": "compare_and_swap_workflow",
                "workflowId": "workflow-catalog-test",
                "workspaceId": "workspace-catalog-test",
                "expectedRevision": 0,
                "expectedCatalogRevision": "catalog-v1-stale",
                "workflow": {},
                "event": { "actor": "agent" }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let stale_cas = loop {
        let message = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
            .await
            .expect("stale Agent proposal response")
            .unwrap()
            .unwrap();
        let frame: serde_json::Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        if frame["requestId"] == "catalog-cas-stale" {
            break frame;
        }
    };
    assert_eq!(stale_cas["type"], "error");
    assert_eq!(stale_cas["error"]["code"], "workflow_catalog_conflict");
    socket.close(None).await.unwrap();
    host.stop().await;
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn delivers_extension_dialog_events_while_a_runtime_request_is_still_pending() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-ws-pending-{nonce}"));
    let public = temp.join("public");
    fs::create_dir_all(&public).unwrap();
    fs::write(public.join("index.html"), "Picot").unwrap();
    let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
    let runtimes = NativePiManager::new(32);
    let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
    let mut fake = runtimes.register_in_memory(target.clone()).unwrap();
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

    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            json!({
                "type": "runtime_request",
                "requestId": "prompt-1",
                "target": target,
                "idempotencyKey": "key-1",
                "command": { "type": "prompt", "message": "/plan" },
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let forwarded = tokio::time::timeout(std::time::Duration::from_secs(1), fake.read_request())
        .await
        .expect("prompt forwarded to pi")
        .unwrap();
    assert_eq!(forwarded["type"], "prompt");

    fake.write_frame(json!({
        "type": "extension_ui_request",
        "id": "dialog-1",
        "method": "select",
        "title": "Plan mode",
        "options": ["Start Plan mode"],
    }))
    .await
    .unwrap();

    let event = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
        .await
        .expect("dialog event delivered without waiting for the prompt response")
        .unwrap()
        .unwrap();
    let event: serde_json::Value = serde_json::from_str(event.to_text().unwrap()).unwrap();
    assert_eq!(event["type"], "runtime_event");
    assert_eq!(event["event"]["type"], "extension_ui_request");
    assert_eq!(event["event"]["id"], "dialog-1");

    socket.close(None).await.unwrap();
    drop(socket);
    drop(fake);
    host.stop().await;
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn replays_startup_extension_ui_and_routes_the_owners_response_exactly_once() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-dialog-{nonce}"));
    let public = temp.join("public");
    fs::create_dir_all(&public).unwrap();
    fs::write(public.join("index.html"), "Picot").unwrap();
    let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
    let runtimes = NativePiManager::new(32);
    let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
    let mut fake = runtimes.register_in_memory(target.clone()).unwrap();
    fake.write_frame(json!({
        "type": "extension_ui_request",
        "id": "dialog-1",
        "method": "select",
        "title": "Project trust",
        "options": ["Trust once", "Open untrusted"]
    }))
    .await
    .unwrap();
    tokio::task::yield_now().await;

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
                "clientId": "owner"
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
                "requestId": "subscribe",
                "target": target,
            })
            .to_string(),
        ))
        .await
        .unwrap();
    socket.next().await.unwrap().unwrap();
    let replay = socket.next().await.unwrap().unwrap();
    let replay: serde_json::Value = serde_json::from_str(replay.to_text().unwrap()).unwrap();
    assert_eq!(replay["event"]["id"], "dialog-1");

    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            json!({
                "type": "runtime_request",
                "requestId": "dialog-response",
                "target": target,
                "command": {
                    "type": "extension_ui_response",
                    "id": "dialog-1",
                    "value": "Trust once"
                }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    socket.next().await.unwrap().unwrap();
    assert_eq!(
        fake.read_request().await.unwrap(),
        json!({
            "type": "extension_ui_response",
            "id": "dialog-1",
            "value": "Trust once"
        })
    );

    socket.close(None).await.unwrap();
    drop(socket);
    drop(fake);
    host.stop().await;
    fs::remove_dir_all(temp).unwrap();
}
