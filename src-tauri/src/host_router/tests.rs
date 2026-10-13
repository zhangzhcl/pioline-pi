use super::{ClientKind, HostRouter, RoutedAction, PROTOCOL_VERSION};
use serde_json::json;

#[test]
fn requires_an_exact_v2_handshake() {
    let mut router = HostRouter::new();
    assert!(router
        .connect(
            "client-a",
            &json!({ "type": "hello", "protocolVersion": 1, "clientType": "desktop" }),
        )
        .is_err());
    assert!(router
        .connect(
            "client-a",
            &json!({
                "type": "hello",
                "protocolVersion": PROTOCOL_VERSION,
                "clientType": "desktop",
            }),
        )
        .is_ok());
    assert_eq!(router.client_kind("client-a"), Some(ClientKind::Desktop));
}

#[test]
fn legacy_auth_frames_are_not_routable() {
    let mut router = HostRouter::new();
    router
        .connect(
            "desktop",
            &json!({ "type": "hello", "protocolVersion": 2, "clientType": "desktop" }),
        )
        .unwrap();
    let error = router
        .route(
            "desktop",
            &json!({
                "type": "auth_request",
                "requestId": "auth-1",
            }),
        )
        .unwrap_err();
    assert_eq!(error.code, "unknown_frame_type");
}

#[test]
fn keeps_runtime_and_host_routes_separate() {
    let mut router = HostRouter::new();
    router
        .connect(
            "desktop",
            &json!({ "type": "hello", "protocolVersion": 2, "clientType": "desktop" }),
        )
        .unwrap();
    let runtime = router
        .route(
            "desktop",
            &json!({
                "type": "runtime_request",
                "requestId": "request-1",
                "idempotencyKey": "intent-1",
                "target": {
                    "workspaceId": "workspace-a",
                    "sessionId": "session-a",
                    "instanceId": "instance-a"
                },
                "command": { "type": "prompt", "message": "secret" }
            }),
        )
        .unwrap();
    assert!(matches!(runtime, RoutedAction::Runtime { .. }));

    let host = router
        .route(
            "desktop",
            &json!({
                "type": "host_request",
                "requestId": "request-2",
                "operation": "pick_folder"
            }),
        )
        .unwrap();
    assert!(matches!(host, RoutedAction::Host { .. }));
}

#[test]
fn allows_previously_dangerous_host_operations_for_remote_clients() {
    let mut router = HostRouter::new();
    router
        .connect(
            "phone",
            &json!({ "type": "hello", "protocolVersion": 2, "clientType": "remote" }),
        )
        .unwrap();
    for operation in [
        "pick_folder",
        "open_app",
        "install_package",
        "install_pi_package",
        "remove_pi_package",
        "check_for_updates",
        "delete_workspace",
    ] {
        assert!(router
            .route(
                "phone",
                &json!({
                    "type": "host_request",
                    "requestId": "request",
                    "operation": operation,
                }),
            )
            .is_ok());
    }
}

#[test]
fn allows_git_commands_for_remote_clients() {
    let mut router = HostRouter::new();
    router
        .connect(
            "phone",
            &json!({ "type": "hello", "protocolVersion": 2, "clientType": "remote" }),
        )
        .unwrap();
    let command = router.route(
        "phone",
        &json!({
            "type": "git_command",
            "requestId": "git-1",
            "workspaceId": "workspace-a",
        }),
    );
    assert!(matches!(command, Ok(RoutedAction::Git { .. })));
}

#[test]
fn routes_terminal_commands_for_desktop_and_remote_clients() {
    let mut router = HostRouter::new();
    for (client_id, client_type) in [("window", "desktop"), ("phone", "remote")] {
        router
            .connect(
                client_id,
                &json!({
                    "type": "hello",
                    "protocolVersion": 2,
                    "clientType": client_type,
                }),
            )
            .unwrap();
    }
    let command = json!({
        "type": "terminal_command",
        "requestId": "terminal-1",
        "workspaceId": "workspace-a",
        "payload": { "type": "terminal_list" },
    });
    assert!(matches!(
        router.route("window", &command),
        Ok(RoutedAction::Terminal { .. })
    ));
    assert!(matches!(
        router.route("phone", &command),
        Ok(RoutedAction::Terminal { .. })
    ));
}

#[test]
fn routes_a_well_formed_rebind_session_request_and_rejects_a_missing_new_session_id() {
    let mut router = HostRouter::new();
    router
        .connect(
            "desktop",
            &json!({ "type": "hello", "protocolVersion": 2, "clientType": "desktop" }),
        )
        .unwrap();
    let target = json!({
        "workspaceId": "workspace-a",
        "sessionId": "session-a",
        "instanceId": "instance-a"
    });
    let routed = router
        .route(
            "desktop",
            &json!({
                "type": "runtime_rebind_session_request",
                "requestId": "request-1",
                "target": target,
                "newSessionId": "session-b",
            }),
        )
        .unwrap();
    assert!(matches!(routed, RoutedAction::Runtime { .. }));

    let missing_new_id = router.route(
        "desktop",
        &json!({
            "type": "runtime_rebind_session_request",
            "requestId": "request-2",
            "target": target,
        }),
    );
    assert!(missing_new_id.is_err());
}
