// ABOUTME: Unit tests for NativeLaunchSpec command construction and
// ABOUTME: NativePiManager RPC routing, state transitions, and session rebinding.

use super::{NativeLaunchSpec, NativePiManager};
use crate::runtime_coordinator::{RuntimeState, RuntimeTarget};
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;

#[test]
fn launch_spec_has_no_tcp_port_and_resumes_only_at_process_start() {
    let spec = NativeLaunchSpec {
        binary: PathBuf::from("/embedded/pi"),
        cwd: PathBuf::from("/workspace"),
        session_path: Some(PathBuf::from("/sessions/a.jsonl")),
        extensions: vec![PathBuf::from("/extensions/picot-bridge.mjs")],
        pi_version: env!("PI_STUDIO_PI_VERSION_BUNDLED").into(),
        path_env: "/usr/bin".into(),
        approve: false,
        windows_powershell_fallback: false,
    };
    let launch = spec.command_description();
    assert_eq!(launch.program, PathBuf::from("/embedded/pi"));
    assert!(launch.args.windows(2).any(|pair| pair == ["--mode", "rpc"]));
    assert!(launch
        .args
        .windows(2)
        .any(|pair| pair == ["--session", "/sessions/a.jsonl"]));
    assert!(!launch.environment.contains_key("PI_STUDIO_PORT"));
    assert!(launch.environment.contains_key("PI_CODING_AGENT_DIR"));
    assert!(!launch
        .args
        .iter()
        .any(|argument| argument.to_string_lossy().parse::<u16>().is_ok()));
    assert!(!launch
        .environment
        .contains_key(crate::pi_shell_compat::WINDOWS_POWERSHELL_FALLBACK_ENV));
}

#[test]
fn launch_spec_emits_power_shell_fallback_only_when_enabled() {
    let spec = NativeLaunchSpec {
        binary: PathBuf::from("/embedded/pi"),
        cwd: PathBuf::from("/workspace"),
        session_path: None,
        extensions: vec![],
        pi_version: env!("PI_STUDIO_PI_VERSION_BUNDLED").into(),
        path_env: "/usr/bin".into(),
        approve: false,
        windows_powershell_fallback: true,
    };
    assert_eq!(
        spec.command_description()
            .environment
            .get(crate::pi_shell_compat::WINDOWS_POWERSHELL_FALLBACK_ENV)
            .and_then(|value| value.to_str()),
        Some("1")
    );
}

#[test]
fn a_remote_workspace_password_reaches_the_pi_process_it_was_parked_for() {
    let anchor = PathBuf::from("/picot-test/remotes/box/app");
    crate::remote_workspace::stash_password(&anchor, "not-a-real-secret");
    let spec = |cwd: PathBuf| NativeLaunchSpec {
        binary: PathBuf::from("/embedded/pi"),
        cwd,
        session_path: None,
        extensions: vec![],
        pi_version: env!("PI_STUDIO_PI_VERSION_BUNDLED").into(),
        path_env: "/usr/bin".into(),
        approve: false,
        windows_powershell_fallback: false,
    };
    assert_eq!(
        spec(anchor)
            .command_description()
            .environment
            .get("PICOT_SSH_PASSWORD")
            .and_then(|value| value.to_str()),
        Some("not-a-real-secret")
    );
    // An ordinary local workspace must not inherit some other host's password.
    assert!(!spec(PathBuf::from("/workspace"))
        .command_description()
        .environment
        .contains_key("PICOT_SSH_PASSWORD"));
}

#[test]
fn approve_flag_appends_dash_dash_approve_arg() {
    let spec = NativeLaunchSpec {
        binary: PathBuf::from("/embedded/pi"),
        cwd: PathBuf::from("/workspace"),
        session_path: None,
        extensions: vec![],
        pi_version: env!("PI_STUDIO_PI_VERSION_BUNDLED").into(),
        path_env: "/usr/bin".into(),
        approve: true,
        windows_powershell_fallback: false,
    };
    assert!(spec
        .command_description()
        .args
        .iter()
        .any(|argument| argument == "--approve"));
}

#[tokio::test]
async fn routes_native_requests_by_opaque_target_and_rejects_session_replacement() {
    let manager = NativePiManager::in_memory(8);
    let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
    let mut events = manager.subscribe();
    let mut fake = manager.register_in_memory(target.clone()).unwrap();

    fake.write_frame(json!({ "type": "agent_start" }))
        .await
        .unwrap();
    let event = events.recv().await.unwrap();
    assert_eq!(event.target, target);
    assert_eq!(event.sequence, 1);
    assert_eq!(event.event["type"], "agent_start");

    let request = tokio::spawn({
        let manager = manager.clone();
        let target = target.clone();
        async move {
            manager
                .request(
                    &target,
                    json!({ "type": "get_state" }),
                    None,
                    Duration::from_secs(1),
                )
                .await
        }
    });
    let outbound = fake.read_request().await.unwrap();
    let id = outbound["id"].as_str().unwrap();
    fake.write_frame(json!({
        "id": id,
        "type": "response",
        "command": "get_state",
        "success": true
    }))
    .await
    .unwrap();
    assert!(request.await.unwrap().unwrap()["success"]
        .as_bool()
        .unwrap());

    let first_prompt = tokio::spawn({
        let manager = manager.clone();
        let target = target.clone();
        async move {
            manager
                .request(
                    &target,
                    json!({ "type": "prompt", "message": "once" }),
                    Some("prompt-intent"),
                    Duration::from_secs(1),
                )
                .await
        }
    });
    let outbound = fake.read_request().await.unwrap();
    let id = outbound["id"].as_str().unwrap();
    fake.write_frame(json!({
        "id": id,
        "type": "response",
        "command": "prompt",
        "success": true
    }))
    .await
    .unwrap();
    let accepted = first_prompt.await.unwrap().unwrap();
    let duplicate = manager
        .request(
            &target,
            json!({ "type": "prompt", "message": "once" }),
            Some("prompt-intent"),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
    assert_eq!(duplicate, accepted);
    assert!(fake.try_read_request().is_none());

    assert!(manager
        .request(
            &target,
            json!({ "type": "switch_session", "sessionPath": "/other.jsonl" }),
            Some("intent-1"),
            Duration::from_secs(1),
        )
        .await
        .is_err());
}

#[cfg(windows)]
#[test]
fn launch_spec_preserves_unpaired_windows_utf16_session_path_units() {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let mut session = r"C:\Users\".encode_utf16().collect::<Vec<_>>();
    session.push(0xD800);
    session.extend(r"\.pi\agent\sessions\session.jsonl".encode_utf16());
    let spec = NativeLaunchSpec {
        binary: PathBuf::from(r"C:\Pipline\resources\pi.exe"),
        cwd: PathBuf::from(r"C:\workspace"),
        session_path: Some(PathBuf::from(std::ffi::OsString::from_wide(&session))),
        extensions: vec![],
        pi_version: env!("PI_STUDIO_PI_VERSION_BUNDLED").into(),
        path_env: r"C:\Windows\System32".into(),
        approve: false,
        windows_powershell_fallback: false,
    };
    let launch = spec.command_description();
    let session_argument = launch
        .args
        .windows(2)
        .find(|pair| pair[0] == "--session")
        .map(|pair| &pair[1])
        .expect("session path argument should exist");
    assert_eq!(session_argument.encode_wide().collect::<Vec<_>>(), session);
}

#[tokio::test]
async fn marks_starting_runtime_ready_after_first_successful_rpc_response() {
    let manager = NativePiManager::in_memory(8);
    let target = RuntimeTarget::new("workspace-a", "session-a", "instance-starting");
    let mut fake = manager
        .register_in_memory_with_state(target.clone(), RuntimeState::Starting)
        .unwrap();
    let request = tokio::spawn({
        let manager = manager.clone();
        let target = target.clone();
        async move {
            manager
                .request(
                    &target,
                    json!({ "type": "get_state" }),
                    None,
                    Duration::from_secs(1),
                )
                .await
        }
    });
    let outbound = fake.read_request().await.unwrap();
    let id = outbound["id"].as_str().unwrap();
    fake.write_frame(json!({
        "id": id,
        "type": "response",
        "command": "get_state",
        "success": true,
        "data": { "sessionId": "session-a" }
    }))
    .await
    .unwrap();

    assert!(request.await.unwrap().is_ok());
    assert_eq!(
        manager.snapshot(&target).unwrap().state,
        RuntimeState::Ready
    );
}

#[tokio::test]
async fn unregisters_runtime_when_the_rpc_stream_closes_unexpectedly() {
    let manager = NativePiManager::in_memory(8);
    let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
    let fake = manager.register_in_memory(target.clone()).unwrap();

    assert_eq!(manager.target_for_session_id("session-a"), Some(target));
    drop(fake);

    tokio::time::timeout(Duration::from_secs(1), async {
        while manager.target_for_session_id("session-a").is_some()
            || !manager.statuses().unwrap().is_empty()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("closed RPC stream should unregister its runtime");
    assert!(manager.statuses().unwrap().is_empty());
}

#[tokio::test]
async fn binds_a_temporary_session_once_and_routes_future_events_to_the_formal_target() {
    let manager = NativePiManager::in_memory(8);
    let temporary = RuntimeTarget::new("workspace-a", "temporary-a", "instance-a");
    let mut events = manager.subscribe();
    let fake = manager.register_in_memory(temporary.clone()).unwrap();

    let formal = manager.bind_session_id(&temporary, "session-a").unwrap();
    let binding = events.recv().await.unwrap();
    assert_eq!(binding.target, temporary);
    assert_eq!(binding.event["type"], "session_bound");
    assert_eq!(binding.event["sessionId"], "session-a");
    assert_eq!(formal.instance_id, "instance-a");

    fake.write_frame(json!({ "type": "agent_start" }))
        .await
        .unwrap();
    let event = events.recv().await.unwrap();
    assert_eq!(event.target, formal);
    assert_eq!(manager.target_for_session_id("session-a"), Some(formal));
}

#[tokio::test]
async fn rebinds_a_formal_session_after_an_in_place_fork_and_routes_future_events_there() {
    let manager = NativePiManager::in_memory(8);
    let original = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
    let mut events = manager.subscribe();
    let fake = manager.register_in_memory(original.clone()).unwrap();

    assert_eq!(
        manager.bind_session_id(&original, "session-b").unwrap(),
        original
    );

    let forked = manager.rebind_session_id(&original, "session-b").unwrap();
    let binding = events.recv().await.unwrap();
    assert_eq!(binding.target, original);
    assert_eq!(binding.event["type"], "session_rebound");
    assert_eq!(binding.event["sessionId"], "session-b");
    assert_eq!(forked.instance_id, "instance-a");
    assert_eq!(forked.session_id, "session-b");

    assert_eq!(manager.target_for_session_id("session-a"), None);
    assert_eq!(
        manager.target_for_session_id("session-b"),
        Some(forked.clone())
    );

    fake.write_frame(json!({ "type": "agent_start" }))
        .await
        .unwrap();
    let event = events.recv().await.unwrap();
    assert_eq!(event.target, forked);
}
