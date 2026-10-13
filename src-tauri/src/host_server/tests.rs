use super::{
    extension_ui_requires_owner, is_public_http_request, messages_from_entries_response,
    trusted_loopback_request, HostServer, WorkflowCodeCancellationRegistry,
};
use crate::metadata_store::MetadataStore;
use crate::native_pi_manager::NativePiManager;
use crate::remote_auth::RemoteAuth;
use serde_json::json;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[path = "health_and_auth_tests.rs"]
mod health_and_auth_tests;
#[path = "websocket_tests.rs"]
mod websocket_tests;

#[test]
fn cancels_an_active_workflow_code_request_and_remembers_early_cancellation() {
    let mut registry = WorkflowCodeCancellationRegistry::default();
    let key = ("desktop-window".to_owned(), "host-request".to_owned());
    let mut active_receiver = registry.register(key.clone()).unwrap();
    assert!(registry.cancel(key));
    assert!(active_receiver.try_recv().is_ok());

    let early_key = ("desktop-window".to_owned(), "host-next".to_owned());
    assert!(!registry.cancel(early_key.clone()));
    assert!(registry.register(early_key).is_err());
}

#[test]
fn exposes_static_assets_and_only_the_minimum_unauthenticated_protocol_routes() {
    use axum::http::Method;

    for path in [
        "/",
        "/app",
        "/manifest.json",
        "/locales/en.json",
        "/icons/logo-dark.svg",
        "/v/build/style.css",
    ] {
        assert!(is_public_http_request(&Method::GET, path), "{path}");
    }
    assert!(is_public_http_request(&Method::GET, "/v2/ws"));
    assert!(is_public_http_request(
        &Method::POST,
        "/v2/auth/device-requests"
    ));
    assert!(is_public_http_request(
        &Method::POST,
        "/v2/auth/device-requests/request-1/claim"
    ));

    for (method, path) in [
        (Method::POST, "/v2/auth/exchange"),
        (Method::GET, "/v2/remote-access"),
        (Method::GET, "/v2/auth/device-requests"),
        (Method::POST, "/v2/auth/device-requests/request-1/approve"),
        (Method::GET, "/v2/sessions"),
        (Method::GET, "/api/files/content"),
        (Method::GET, "/health/runtime"),
    ] {
        assert!(!is_public_http_request(&method, path), "{path}");
    }
}

#[test]
fn loopback_authority_requires_actual_peer_and_accepts_supported_hosts() {
    use axum::extract::connect_info::ConnectInfo;
    use axum::http::{HeaderMap, HeaderValue, Uri};
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    let peer = ConnectInfo(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1));
    let uri = Uri::from_static("/health");
    for host in [
        "localhost",
        "localhost:57620",
        "127.0.0.1:57620",
        "[::1]:57620",
    ] {
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static(host));
        assert!(trusted_loopback_request(peer, &headers, &uri), "{host}");
    }
    assert!(trusted_loopback_request(
        peer,
        &HeaderMap::new(),
        &Uri::from_static("http://localhost:57620/health"),
    ));
    let mut external = HeaderMap::new();
    external.insert("host", HeaderValue::from_static("remote.example"));
    assert!(!trusted_loopback_request(peer, &external, &uri));
    let non_loopback = ConnectInfo(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)),
        1,
    ));
    let mut spoofed = HeaderMap::new();
    spoofed.insert("host", HeaderValue::from_static("127.0.0.1:57620"));
    assert!(!trusted_loopback_request(non_loopback, &spoofed, &uri));
    let ipv6_peer = ConnectInfo(SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 1));
    assert!(!trusted_loopback_request(ipv6_peer, &external, &uri));
    let mut ipv6_headers = HeaderMap::new();
    ipv6_headers.insert("host", HeaderValue::from_static("[::1]:57620"));
    assert!(trusted_loopback_request(ipv6_peer, &ipv6_headers, &uri));
}

#[test]
fn only_blocking_extension_ui_requests_require_the_session_owner() {
    assert!(extension_ui_requires_owner(&json!({
        "type": "extension_ui_request",
        "method": "select"
    })));
    assert!(!extension_ui_requires_owner(&json!({
        "type": "extension_ui_request",
        "method": "notify",
        "message": "{\"__picotConfig\":\"cfg-1\",\"ok\":true}"
    })));
    assert!(!extension_ui_requires_owner(&json!({
        "type": "agent_start"
    })));
}

#[test]
fn derives_active_branch_messages_with_user_and_assistant_entry_ids_from_entries() {
    let response = json!({
        "type": "response",
        "command": "get_entries",
        "success": true,
        "data": {
            "leafId": "assistant-2",
            "entries": [
                {
                    "type": "message",
                    "id": "user-1",
                    "parentId": null,
                    "message": { "role": "user", "content": "first" }
                },
                {
                    "type": "message",
                    "id": "assistant-1",
                    "parentId": "user-1",
                    "message": { "role": "assistant", "content": [{ "type": "text", "text": "old" }] }
                },
                {
                    "type": "message",
                    "id": "user-abandoned",
                    "parentId": "assistant-1",
                    "message": { "role": "user", "content": "abandoned" }
                },
                {
                    "type": "message",
                    "id": "user-2",
                    "parentId": "assistant-1",
                    "message": { "role": "user", "content": "current" }
                },
                {
                    "type": "message",
                    "id": "assistant-2",
                    "parentId": "user-2",
                    "message": { "role": "assistant", "content": [{ "type": "text", "text": "new" }] }
                }
            ]
        }
    });

    let messages = messages_from_entries_response(&response);

    assert_eq!(
        messages,
        json!([
            { "role": "user", "content": "first", "entryId": "user-1" },
            { "role": "assistant", "content": [{ "type": "text", "text": "old" }], "entryId": "assistant-1" },
            { "role": "user", "content": "current", "entryId": "user-2" },
            { "role": "assistant", "content": [{ "type": "text", "text": "new" }], "entryId": "assistant-2" }
        ])
    );
}

#[tokio::test]
async fn serves_health_and_static_assets_from_one_origin() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-{nonce}"));
    let public = temp.join("public");
    fs::create_dir_all(&public).unwrap();
    fs::write(public.join("index.html"), "<h1>Picot native host</h1>").unwrap();
    let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
    let host = HostServer::start(public, NativePiManager::new(32), auth, None)
        .await
        .unwrap();

    let root = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
        .get(format!("{}/", host.origin()))
        .send()
        .await
        .unwrap();
    assert_eq!(root.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(root.headers().get("location").unwrap(), "/app");

    let health: serde_json::Value = reqwest::get(format!("{}/health", host.origin()))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["protocolVersion"], 2);
    assert_eq!(health["piVersion"], env!("PI_STUDIO_PI_VERSION_BUNDLED"));
    let index = reqwest::get(format!("{}/app/settings", host.origin()))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(index.contains("Picot native host"));

    host.stop().await;
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn protects_http_data_and_remote_access_by_authority_and_bearer() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-auth-boundary-{nonce}"));
    let public = temp.join("public");
    fs::create_dir_all(&public).unwrap();
    fs::write(public.join("index.html"), "Picot").unwrap();
    let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
    let host = HostServer::start(public, NativePiManager::new(32), auth, None)
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let runtime_url = format!("{}/health/runtime", host.origin());

    let loopback = client.get(&runtime_url).send().await.unwrap();
    assert!(loopback.status().is_success());

    let external_authority = client
        .get(&runtime_url)
        .header("host", "remote.example")
        .send()
        .await
        .unwrap();
    assert_eq!(
        external_authority.status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    let invalid_bearer = client
        .get(&runtime_url)
        .header("host", "remote.example")
        .bearer_auth("invalid-token")
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_bearer.status(), reqwest::StatusCode::UNAUTHORIZED);

    let remote_access = client
        .get(format!("{}/v2/remote-access", host.origin()))
        .send()
        .await
        .unwrap();
    assert!(remote_access.status().is_success());
    let body: serde_json::Value = remote_access.json().await.unwrap();
    let launcher_url = reqwest::Url::parse(body["url"].as_str().unwrap()).unwrap();
    assert_eq!(launcher_url.path(), "/app");
    assert!(launcher_url.query().is_none());
    assert!(launcher_url.fragment().is_none());
    assert!(!body.to_string().contains("picot_pair_"));

    let request = host
        .state
        .auth
        .lock()
        .unwrap()
        .create_device_request("remote-test", "Remote browser", &"a".repeat(64), 1)
        .unwrap();
    host.state
        .auth
        .lock()
        .unwrap()
        .decide_device_request(&request.request_id, true, 2)
        .unwrap();
    let crate::remote_auth::DeviceClaim::Approved(device_token) = host
        .state
        .auth
        .lock()
        .unwrap()
        .claim_device_request(&request.request_id, "remote-test", &"a".repeat(64), 3)
        .unwrap()
    else {
        panic!("approved request did not issue a token");
    };
    let remote_access_bearer = client
        .get(format!("{}/v2/remote-access", host.origin()))
        .header("host", "remote.example")
        .bearer_auth(device_token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        remote_access_bearer.status(),
        reqwest::StatusCode::FORBIDDEN
    );

    host.stop().await;
    fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn serves_static_assets_under_a_content_fingerprinted_path() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-versioned-{nonce}"));
    let public = temp.join("public");
    fs::create_dir_all(public.join("native")).unwrap();
    fs::write(
        public.join("index.html"),
        "<html><head><base href=\"/\" /></head><body>Picot</body></html>",
    )
    .unwrap();
    fs::write(public.join("native/app.js"), "export const marker = 1;").unwrap();
    let metadata = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
    let host = HostServer::start(public, NativePiManager::new(32), auth, None)
        .await
        .unwrap();

    let index = reqwest::get(format!("{}/app/settings", host.origin()))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let base_start = index.find("<base href=\"").unwrap() + "<base href=\"".len();
    let base_end = index[base_start..].find('"').unwrap();
    let base_href = &index[base_start..base_start + base_end];
    assert!(
        base_href.starts_with("/v/") && base_href.ends_with('/'),
        "expected a versioned base href, got {base_href:?}"
    );

    let app_js = reqwest::get(format!("{}{}native/app.js", host.origin(), base_href))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(app_js, "export const marker = 1;");

    host.stop().await;
    fs::remove_dir_all(temp).unwrap();
}
