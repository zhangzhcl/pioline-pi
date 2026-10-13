use super::extension_ui_smoke::verify_user_extension_ui_flows;
use super::fake_providers::{fake_chat_completion, FakeProviderState};
use super::{read_frame, read_through_agent_end, read_until, send_json};
use crate::host_server::HostServer;
use crate::metadata_store::MetadataStore;
use crate::native_pi_manager::{NativeLaunchSpec, NativePiManager};
use crate::remote_auth::RemoteAuth;
use crate::runtime_coordinator::RuntimeTarget;
use axum::routing::post;
use axum::Router;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub(super) async fn run_smoke(
    temp: &Path,
    public: &Path,
    pi_agent_dir: &Path,
    workspace: &Path,
) -> Result<(), String> {
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("bind fake model provider: {error}"))?;
    let provider_address = provider_listener
        .local_addr()
        .map_err(|error| format!("read fake provider address: {error}"))?;
    let provider_state = FakeProviderState {
        request_count: Arc::new(AtomicUsize::new(0)),
        received_write_tool: Arc::new(AtomicBool::new(false)),
    };
    let provider_observed = provider_state.clone();
    let provider_task = tokio::spawn(async move {
        let app = Router::new()
            .route("/v1/chat/completions", post(fake_chat_completion))
            .with_state(provider_state);
        axum::serve(provider_listener, app).await
    });
    fs::write(
        pi_agent_dir.join("models.json"),
        serde_json::to_vec(&json!({
            "providers": {
                "pipline-host-smoke": {
                    "baseUrl": format!("http://{provider_address}/v1"),
                    "api": "openai-completions",
                    "apiKey": "pipline-host-smoke-key",
                    "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
                    "models": [{
                        "id": "host-smoke-model",
                        "name": "Pipline Host Smoke Model",
                        "reasoning": false,
                        "input": ["text"],
                        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
                        "contextWindow": 8192,
                        "maxTokens": 256
                    }]
                }
            }
        }))
        .map_err(|error| format!("encode fake provider model: {error}"))?,
    )
    .map_err(|error| format!("write fake provider model: {error}"))?;
    fs::write(
        pi_agent_dir.join("settings.json"),
        br#"{"defaultProvider":"pipline-host-smoke","defaultModel":"host-smoke-model","defaultTools":["read","write"]}"#,
    )
    .map_err(|error| format!("write isolated Pi settings: {error}"))?;

    let metadata = MetadataStore::open(&temp.join("pipline.sqlite3"))
        .map_err(|error| format!("open metadata store: {error}"))?;
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
    let manager = NativePiManager::new(8);
    let target = RuntimeTarget::new(
        "host-smoke-workspace",
        "host-smoke-session",
        "host-smoke-instance",
    );
    let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("pi")
        .join(if cfg!(windows) { "pi.exe" } else { "pi" });
    if !binary.is_file() {
        return Err(format!(
            "embedded Pi binary is missing: {}",
            binary.display()
        ));
    }
    let bridge = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("extensions")
        .join("dist")
        .join("picot-bridge.mjs");
    if !bridge.is_file() {
        return Err(format!(
            "Pipline Pi bridge extension is missing: {}",
            bridge.display()
        ));
    }
    let launch_spec = NativeLaunchSpec {
        binary,
        cwd: workspace.to_path_buf(),
        session_path: Some(temp.join("session.jsonl")),
        extensions: vec![bridge],
        pi_version: env!("PI_STUDIO_PI_VERSION_BUNDLED").to_owned(),
        path_env: std::env::var("PATH").unwrap_or_default(),
        approve: true,
        windows_powershell_fallback: false,
    };
    manager
        .spawn(target.clone(), &launch_spec)
        .map_err(|error| format!("spawn bundled Pi: {error}"))?;

    let host = HostServer::start(public.to_path_buf(), manager.clone(), auth, None)
        .await
        .map_err(|error| format!("start HostServer: {error}"))?;
    let mut target_for_cleanup = target.clone();
    let outcome = async {
        let ws_url = host.origin().replace("http://", "ws://") + "/v2/ws";
        let (mut socket, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|error| format!("connect Host WebSocket: {error}"))?;
        send_json(
            &mut socket,
            json!({
                "type": "hello",
                "protocolVersion": 2,
                "clientType": "desktop",
                "clientId": "real-pi-smoke"
            }),
        )
        .await?;
        let hello = read_frame(&mut socket).await?;
        if hello["type"] != "hello_ack" {
            return Err(format!("unexpected hello response: {hello}"));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_subscribe",
                "requestId": "subscribe-real-pi",
                "target": target
            }),
        )
        .await?;
        let subscribed = read_until(&mut socket, |frame| {
            frame["requestId"] == "subscribe-real-pi"
        })
        .await?;
        if subscribed["type"] != "runtime_subscribed" {
            return Err(format!("runtime subscription rejected: {subscribed}"));
        }

        verify_user_extension_ui_flows(&mut socket, &target).await?;

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "get-state-real-pi",
                "target": target,
                "command": { "type": "get_state" }
            }),
        )
        .await?;
        let response = read_until(&mut socket, |frame| {
            frame["requestId"] == "get-state-real-pi"
        })
        .await?;
        if response["type"] != "runtime_response" || response["response"]["success"] != true {
            return Err(format!("Pi get_state failed through Host: {response}"));
        }
        if response["acceptance"] != "accepted" {
            return Err(format!("unexpected Host acceptance: {response}"));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "name-session-real-pi",
                "target": target,
                "command": { "type": "set_session_name", "name": "Pipline RPC integration smoke" }
            }),
        )
        .await?;
        let named = read_until(&mut socket, |frame| {
            frame["requestId"] == "name-session-real-pi"
        })
        .await?;
        if named["type"] != "runtime_response" || named["response"]["success"] != true {
            return Err(format!(
                "Pi could not name the isolated smoke session: {named}"
            ));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "prompt-real-pi",
                "idempotencyKey": "host-smoke-prompt-1",
                "target": target,
                "command": { "type": "prompt", "message": "Reply with the exact text: Pipline Host to Pi integration passed." }
            }),
        )
        .await?;
        let prompt_response = read_until(&mut socket, |frame| {
            frame["requestId"] == "prompt-real-pi"
        })
        .await?;
        if prompt_response["type"] != "runtime_response"
            || prompt_response["response"]["success"] != true
        {
            return Err(format!("Pi rejected prompt through Host: {prompt_response}"));
        }
        let (agent_end, runtime_events) = read_through_agent_end(&mut socket).await?;
        if agent_end["target"]["instanceId"] != target.instance_id {
            return Err(format!("agent event target mismatch: {agent_end}"));
        }
        let event_types = runtime_events
            .iter()
            .filter_map(|frame| frame["event"]["type"].as_str())
            .collect::<Vec<_>>();
        for required in [
            "message_update",
            "tool_execution_start",
            "tool_execution_end",
        ] {
            if !event_types.contains(&required) {
                return Err(format!(
                    "Pi runtime event {required} did not cross Host: {event_types:?}"
                ));
            }
        }
        let sequences = runtime_events
            .iter()
            .filter_map(|frame| frame["sequence"].as_u64())
            .collect::<Vec<_>>();
        if sequences.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(format!("Host runtime event sequence regressed: {sequences:?}"));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "get-messages-real-pi",
                "target": target,
                "command": { "type": "get_messages" }
            }),
        )
        .await?;
        let messages_response = read_until(&mut socket, |frame| {
            frame["requestId"] == "get-messages-real-pi"
        })
        .await?;
        if messages_response["response"]["success"] != true {
            return Err(format!(
                "Pi get_messages failed through Host: {messages_response}"
            ));
        }
        let messages = messages_response["response"]["data"]["messages"]
            .as_array()
            .ok_or_else(|| format!("Pi message history missing: {messages_response}"))?;
        let expected_reply = "Pipline Host to Pi integration passed.";
        let found_reply = messages.iter().any(|message| {
            message["role"] == "assistant"
                && message["content"].as_array().is_some_and(|parts| {
                    parts
                        .iter()
                        .any(|part| part["type"] == "text" && part["text"] == expected_reply)
                })
        });
        if !found_reply {
            return Err(format!(
                "expected assistant reply not in Pi history: {messages:?}"
            ));
        }
        let found_write = messages.iter().any(|message| {
            message["role"] == "assistant"
                && message["content"].as_array().is_some_and(|parts| {
                    parts
                        .iter()
                        .any(|part| part["type"] == "toolCall" && part["name"] == "write")
                })
        });
        let found_write_result = messages.iter().any(|message| {
            message["role"] == "toolResult"
                && message["toolName"] == "write"
                && message["isError"] != true
        });
        if !found_write || !found_write_result {
            return Err(format!(
                "Pi write tool call/result missing from history: {messages:?}"
            ));
        }
        let written_file = fs::read_to_string(workspace.join("pipline-host-smoke.txt"))
            .map_err(|error| format!("read Pi-created file: {error}"))?;
        if written_file != "Pipline Host to Pi write tool passed.\n" {
            return Err(format!("Pi wrote unexpected file content: {written_file:?}"));
        }

        manager
            .stop(&target)
            .map_err(|error| format!("stop first Pi process before session recovery: {error}"))?;
        let recovered_target = RuntimeTarget::new(
            target.workspace_id.clone(),
            target.session_id.clone(),
            "host-smoke-instance-recovered",
        );
        manager
            .spawn(recovered_target.clone(), &launch_spec)
            .map_err(|error| format!("restart Pi with saved session: {error}"))?;
        target_for_cleanup = recovered_target.clone();
        send_json(
            &mut socket,
            json!({
                "type": "runtime_subscribe",
                "requestId": "subscribe-recovered-pi",
                "target": recovered_target
            }),
        )
        .await?;
        let recovered_subscription = read_until(&mut socket, |frame| {
            frame["requestId"] == "subscribe-recovered-pi"
        })
        .await?;
        if recovered_subscription["type"] != "runtime_subscribed" {
            return Err(format!(
                "recovered Pi subscription rejected: {recovered_subscription}"
            ));
        }
        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "get-recovered-messages",
                "target": recovered_target,
                "command": { "type": "get_messages" }
            }),
        )
        .await?;
        let recovered_messages = read_until(&mut socket, |frame| {
            frame["requestId"] == "get-recovered-messages"
        })
        .await?;
        if recovered_messages["response"]["success"] != true {
            return Err(format!(
                "restored Pi session could not load messages: {recovered_messages}"
            ));
        }
        let restored_history = recovered_messages["response"]["data"]["messages"]
            .as_array()
            .ok_or_else(|| format!("restored Pi history missing: {recovered_messages}"))?;
        let restored_assistant_reply = restored_history.iter().any(|message| {
            message["role"] == "assistant"
                && message["content"].as_array().is_some_and(|parts| {
                    parts.iter().any(|part| {
                        part["type"] == "text"
                            && part["text"] == "Pipline Host to Pi integration passed."
                    })
                })
        });
        if !restored_assistant_reply {
            return Err(format!(
                "Pi did not restore assistant history: {restored_history:?}"
            ));
        }
        let _ = socket.close(None).await;
        Ok::<(), String>(())
    }
    .await;

    let stop_result = manager.stop(&target_for_cleanup);
    host.stop().await;
    provider_task.abort();
    outcome?;
    if provider_observed.request_count.load(Ordering::SeqCst) != 2 {
        return Err(format!(
            "expected two model requests for write plus final reply, got {}",
            provider_observed.request_count.load(Ordering::SeqCst)
        ));
    }
    if !provider_observed.received_write_tool.load(Ordering::SeqCst) {
        return Err("Pi did not advertise its native write tool to the model".into());
    }
    stop_result.map_err(|error| format!("stop bundled Pi: {error}"))
}
