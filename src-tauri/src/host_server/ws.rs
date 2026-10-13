use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

use crate::host_router::{ClientKind, RoutedAction, PROTOCOL_VERSION};
use crate::native_pi_manager::NativeRuntimeEvent;
use crate::runtime_coordinator::RuntimeTarget;
use crate::window_owner::OwnerId;

use super::{dispatch, trusted_loopback_request, HostState, MAX_WS_MESSAGE_BYTES};

pub(crate) struct ActiveWebSocket(Arc<HostState>);

impl ActiveWebSocket {
    pub(crate) fn new(state: Arc<HostState>) -> Self {
        state.active_websockets.fetch_add(1, Ordering::AcqRel);
        Self(state)
    }
}

impl Drop for ActiveWebSocket {
    fn drop(&mut self) {
        self.0.active_websockets.fetch_sub(1, Ordering::AcqRel);
        self.0.websockets_idle.notify_one();
    }
}

pub(crate) async fn websocket_upgrade(
    State(state): State<Arc<HostState>>,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    websocket: WebSocketUpgrade,
) -> Response {
    let loopback = trusted_loopback_request(peer, &headers, &uri);
    websocket
        .max_message_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_websocket(socket, state, loopback))
}

pub(crate) async fn handle_websocket(
    mut socket: WebSocket,
    state: Arc<HostState>,
    loopback_peer: bool,
) {
    let _connection = ActiveWebSocket::new(Arc::clone(&state));
    let mut connection_shutdown = state.connection_shutdown.clone();
    let first_message = tokio::select! {
        _ = connection_shutdown.changed() => return,
        message = socket.next() => message,
    };
    let Some(Ok(Message::Text(first))) = first_message else {
        return;
    };
    let Ok(hello) = serde_json::from_str::<Value>(&first) else {
        let _ = send_error(&mut socket, None, "invalid_json", "Invalid JSON frame").await;
        return;
    };
    let client_id = match hello.get("clientId").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value.to_owned(),
        _ => {
            let _ = send_error(
                &mut socket,
                None,
                "invalid_client_id",
                "clientId is required",
            )
            .await;
            return;
        }
    };
    if !loopback_peer {
        let authorized = hello
            .get("deviceToken")
            .and_then(Value::as_str)
            .and_then(|token| state.auth.lock().ok()?.authorize(token).ok())
            .unwrap_or(false);
        if !authorized {
            let _ = send_error(
                &mut socket,
                None,
                "unauthorized_device",
                "Device token rejected",
            )
            .await;
            return;
        }
    }
    let handshake = state
        .router
        .lock()
        .map_err(|_| "Host router unavailable".to_string())
        .and_then(|mut router| {
            router
                .connect_as(
                    &client_id,
                    &hello,
                    if loopback_peer {
                        ClientKind::Desktop
                    } else {
                        ClientKind::Remote
                    },
                )
                .map_err(|error| error.message)
        });
    if let Err(message) = handshake {
        let _ = send_error(&mut socket, None, "handshake_rejected", &message).await;
        return;
    }
    let terminal_owner = OwnerId::from_client_id(&client_id);
    if socket
        .send(Message::Text(
            json!({ "type": "hello_ack", "protocolVersion": PROTOCOL_VERSION })
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }

    let mut runtime_events = state.runtimes.subscribe();
    let mut acp_events = state.acp.subscribe();
    let mut terminal_events = state.terminal_events.subscribe();
    let mut workflow_events = state.workflow_events.subscribe();
    let mut git_events = state.git_events.subscribe();
    let mut subscriptions = HashSet::new();

    // Writing goes through a channel so this loop never blocks on the socket,
    // and — more importantly — so request dispatch can move off this task. A
    // runtime request stays pending for as long as the Pi command it triggers
    // runs, and a command that opens an extension dialog only finishes once
    // the user answers it. Answering needs the `extension_ui_request` event
    // that this very loop delivers, so awaiting dispatch inline deadlocked the
    // dialog until the 30s RPC timeout fired.
    let (mut socket_sink, mut socket_stream) = socket.split();
    let (outgoing_tx, mut outgoing_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let mut dispatch_tasks = tokio::task::JoinSet::new();
    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing_rx.recv().await {
            if socket_sink.send(message).await.is_err() {
                break;
            }
        }
    });
    let send_frame = |value: Value| outgoing_tx.send(Message::Text(value.to_string().into()));

    'connection: loop {
        tokio::select! {
            _ = connection_shutdown.changed() => break,
            completed = dispatch_tasks.join_next(), if !dispatch_tasks.is_empty() => {
                let _ = completed;
            }
            incoming = socket_stream.next() => {
                let Some(Ok(message)) = incoming else { break };
                let Message::Text(text) = message else {
                    if matches!(message, Message::Close(_)) { break; }
                    continue;
                };
                let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                    let _ = send_frame(structured_error(None, "invalid_json", "Invalid JSON frame"));
                    continue;
                };
                let request_id = frame
                    .get("requestId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let routed = state
                    .router
                    .lock()
                    .map_err(|_| ("router_unavailable", "Host router unavailable".to_string()))
                    .and_then(|router| {
                        router
                            .route_owned(&client_id, frame)
                            .map_err(|error| (error.code, error.message))
                    });
                // Subscribe stays on this task: it mutates `subscriptions`,
                // which the runtime-event branch below reads, and it never
                // awaits. Every other action is dispatched on its own task so a
                // long-running Pi command cannot stall event delivery.
                let mut after_response = Vec::new();
                let response = match routed {
                    Ok(RoutedAction::Subscribe { request_id, target, .. }) => {
                        match serde_json::from_value::<RuntimeTarget>(target) {
                            Ok(target) => {
                                subscriptions.insert(target.clone());
                                let owns_session = state
                                    .session_owners
                                    .lock()
                                    .is_ok_and(|mut owners| {
                                        if let Some(existing) = owners.get(&target) {
                                            existing == &client_id
                                        } else {
                                            owners.insert(target.clone(), client_id.clone());
                                            true
                                        }
                                    });
                                if owns_session {
                                    if let Ok(pending) = state.runtimes.pending_extension_ui(&target) {
                                        after_response.extend(pending.iter().map(runtime_event_frame));
                                    }
                                }
                                Ok(json!({ "type": "runtime_subscribed", "requestId": request_id }))
                            }
                            Err(_) => Err(("invalid_target", "Runtime target is invalid".into())),
                        }
                    }
                    Ok(action) => {
                        let state = Arc::clone(&state);
                        let outgoing_tx = outgoing_tx.clone();
                        dispatch_tasks.spawn(async move {
                            let outgoing = match dispatch(action, &state).await {
                                Ok(value) => value,
                                Err((code, message)) => {
                                    structured_error(request_id.as_deref(), code, &message)
                                }
                            };
                            let _ = outgoing_tx.send(Message::Text(outgoing.to_string().into()));
                        });
                        continue;
                    }
                    Err((code, message)) => Err((code, message)),
                };
                let outgoing = match response {
                    Ok(value) => value,
                    Err((code, message)) => structured_error(request_id.as_deref(), code, &message),
                };
                if send_frame(outgoing).is_err() {
                    break;
                }
                for replay in after_response {
                    if send_frame(replay).is_err() {
                        break 'connection;
                    }
                }
            }
            event = runtime_events.recv() => {
                match event {
                    Ok(event) if subscriptions.contains(&event.target) => {
                        if extension_ui_requires_owner(&event.event) {
                            let is_owner = state
                                .session_owners
                                .lock()
                                .is_ok_and(|owners| {
                                    owners.get(&event.target).map(String::as_str)
                                        == Some(client_id.as_str())
                                });
                            if !is_owner { continue; }
                        }
                        if send_frame(runtime_event_frame(&event)).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let outgoing = structured_error(
                            None,
                            "event_sequence_gap",
                            "Runtime events were missed; request a snapshot",
                        );
                        if send_frame(outgoing).is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            event = acp_events.recv() => {
                match event {
                    Ok(event) if subscriptions.contains(&event.target) => {
                        if send_frame(runtime_event_frame(&event)).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let outgoing = structured_error(
                            None,
                            "event_sequence_gap",
                            "ACP runtime events were missed; switch agents again to resync",
                        );
                        if send_frame(outgoing).is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            event = terminal_events.recv() => {
                match event {
                    Ok((owner, outgoing)) if owner == terminal_owner => {
                        if send_frame(outgoing).is_err() {
                            break;
                        }
                    }
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            event = workflow_events.recv() => {
                match event {
                    Ok(event) => {
                        if send_frame(event).is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if send_frame(json!({ "type": "workflow_resync_required" })).is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            event = git_events.recv() => {
                match event {
                    Ok((owner, outgoing)) if owner == client_id => {
                        if send_frame(outgoing).is_err() {
                            break;
                        }
                    }
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    dispatch_tasks.abort_all();
    while dispatch_tasks.join_next().await.is_some() {}
    drop(outgoing_tx);
    let _ = writer.await;
    if let Ok(mut router) = state.router.lock() {
        router.disconnect(&client_id);
    }
    if let Ok(mut owners) = state.session_owners.lock() {
        owners.retain(|_, owner| owner != &client_id);
    }
}

pub(crate) fn extension_ui_requires_owner(event: &Value) -> bool {
    if event.get("type").and_then(Value::as_str) != Some("extension_ui_request") {
        return false;
    }
    matches!(
        event.get("method").and_then(Value::as_str),
        Some("select" | "confirm" | "input" | "editor" | "workflow")
    )
}

pub(crate) fn runtime_event_frame(event: &NativeRuntimeEvent) -> Value {
    json!({
        "type": "runtime_event",
        "target": &event.target,
        "sequence": event.sequence,
        "event": &event.event,
    })
}

pub(crate) async fn send_error(
    socket: &mut WebSocket,
    request_id: Option<&str>,
    code: &'static str,
    message: &str,
) -> Result<(), axum::Error> {
    socket
        .send(Message::Text(
            structured_error(request_id, code, message)
                .to_string()
                .into(),
        ))
        .await
}

pub(crate) fn structured_error(
    request_id: Option<&str>,
    code: &'static str,
    message: &str,
) -> Value {
    json!({
        "type": "error",
        "requestId": request_id,
        "error": { "code": code, "message": message },
    })
}
