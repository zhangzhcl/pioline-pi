// ABOUTME: Unit tests for WindowOwnerRegistry capability and navigation isolation.

use super::*;

fn url(s: &str) -> tauri::Url {
    s.parse().expect("valid url")
}

fn new_owner(reg: &WindowOwnerRegistry, label: &str, port: u16) -> (OwnerId, String) {
    reg.create_owner(
        label.to_string(),
        PathBuf::from("/workspace"),
        port,
        &format!("http://127.0.0.1:{port}"),
    )
    .expect("owner created")
}

#[test]
fn capability_is_32_random_url_safe_bytes() {
    let reg = WindowOwnerRegistry::default();
    let (owner, capability) = new_owner(&reg, "w1", 3001);
    assert_eq!(owner.as_str().len(), 32);
    assert_eq!(reg.owner_for_label("w1"), Some(owner.clone()));
    assert_eq!(reg.label_for_owner(&owner).as_deref(), Some("w1"));
    let decoded = URL_SAFE_NO_PAD.decode(&capability).expect("decodes");
    assert_eq!(decoded.len(), CAPABILITY_LEN);
    for ch in capability.chars() {
        assert!(ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
        assert!(ch != '=');
    }
}

#[test]
fn authenticate_validates_in_constant_time() {
    let reg = WindowOwnerRegistry::default();
    let (owner, capability) = new_owner(&reg, "w1", 3001);

    assert_eq!(reg.authenticate(&capability), Some(owner));

    let mut flipped = URL_SAFE_NO_PAD.decode(&capability).unwrap();
    flipped[0] ^= 0xff;
    let tampered = URL_SAFE_NO_PAD.encode(&flipped);
    assert_eq!(reg.authenticate(&tampered), None);

    assert_eq!(reg.authenticate("short"), None);
    assert_eq!(reg.authenticate(""), None);
}

#[test]
fn window_label_can_be_reused_after_revocation() {
    let reg = WindowOwnerRegistry::default();
    let (owner, _) = new_owner(&reg, "w1", 3001);
    assert!(reg
        .create_owner(
            "w1".to_string(),
            PathBuf::from("/ws"),
            3002,
            "http://127.0.0.1:3002",
        )
        .is_err());
    reg.revoke_owner(&owner);
    assert!(new_owner(&reg, "w1", 3003).0 != owner);
}

#[test]
fn current_exact_origin_is_authorized() {
    let reg = WindowOwnerRegistry::default();
    let (owner, _) = new_owner(&reg, "w1", 3001);
    assert!(reg.authorize_navigation(&owner, &url("http://127.0.0.1:3001/chat")));
    assert!(!reg.authorize_navigation(&owner, &url("http://127.0.0.1:3002/chat")));
}

#[test]
fn prepared_pending_origin_is_authorized_within_ttl() {
    let reg = WindowOwnerRegistry::default();
    let (owner, _) = new_owner(&reg, "w1", 3001);
    let gen = reg
        .prepare_navigation(
            &owner,
            3002,
            PathBuf::from("/workspace"),
            "http://127.0.0.1:3002",
            Duration::from_secs(5),
        )
        .expect("prepare");
    assert!(gen > 0);
    assert!(reg.authorize_navigation(&owner, &url("http://127.0.0.1:3002/x")));
    assert!(!reg.authorize_navigation(&owner, &url("http://127.0.0.1:3002/again")));
    assert!(reg.authorize_navigation(&owner, &url("http://127.0.0.1:3001/x")));
}

#[test]
fn expired_permit_is_not_authorized_but_current_remains() {
    let reg = WindowOwnerRegistry::default();
    let (owner, _) = new_owner(&reg, "w1", 3001);
    reg.prepare_navigation(
        &owner,
        3002,
        PathBuf::from("/workspace"),
        "http://127.0.0.1:3002",
        Duration::ZERO,
    )
    .expect("prepare");
    assert!(!reg.authorize_navigation(&owner, &url("http://127.0.0.1:3002/x")));
    assert!(reg.authorize_navigation(&owner, &url("http://127.0.0.1:3001/x")));
}

#[test]
fn permit_is_consumed_by_commit_and_old_origin_becomes_unauthorized() {
    let reg = WindowOwnerRegistry::default();
    let (owner, _) = new_owner(&reg, "w1", 3001);
    let gen = reg
        .prepare_navigation(
            &owner,
            3002,
            PathBuf::from("/workspace"),
            "http://127.0.0.1:3002",
            Duration::from_secs(5),
        )
        .unwrap();
    assert!(reg.authorize_navigation(&owner, &url("http://127.0.0.1:3002/x")));

    reg.commit_workspace_transition(&owner, gen, "http://127.0.0.1:3002")
        .unwrap();

    assert!(reg.authorize_navigation(&owner, &url("http://127.0.0.1:3002/x")));
    assert!(!reg.authorize_navigation(&owner, &url("http://127.0.0.1:3001/x")));
    assert!(!reg.authorize_navigation(&owner, &url("http://127.0.0.1:3003/x")));
}

#[test]
fn non_loopback_or_non_http_destinations_are_rejected() {
    let reg = WindowOwnerRegistry::default();
    let (owner, _) = new_owner(&reg, "w1", 3001);
    assert!(!reg.authorize_navigation(&owner, &url("https://example.com/")));
    assert!(!reg.authorize_navigation(&owner, &url("http://192.168.1.5:3001/")));
    assert!(!reg.authorize_navigation(&owner, &url("file:///etc/passwd")));
    assert!(!reg.authorize_navigation(&owner, &url("picot://internal/app")));
}

#[test]
fn unregistered_loopback_ports_are_rejected() {
    let reg = WindowOwnerRegistry::default();
    let (owner, _) = new_owner(&reg, "w1", 3001);
    assert!(!reg.authorize_navigation(&owner, &url("http://localhost:9999/")));
    assert!(!reg.authorize_navigation(&owner, &url("http://127.0.0.1:9999/")));
}

#[test]
fn userinfo_is_rejected() {
    let reg = WindowOwnerRegistry::default();
    let (owner, _) = new_owner(&reg, "w1", 3001);
    assert!(!reg.authorize_navigation(&owner, &url("http://user:pass@127.0.0.1:3001/")));
}

#[test]
fn owner_isolation_prevents_cross_owner_authorization() {
    let reg = WindowOwnerRegistry::default();
    let (owner_a, cap_a) = new_owner(&reg, "w1", 3001);
    let (owner_b, cap_b) = new_owner(&reg, "w2", 3002);
    assert!(!reg.authorize_navigation(&owner_b, &url("http://127.0.0.1:3001/x")));
    assert_eq!(reg.authenticate(&cap_a), Some(owner_a));
    assert_eq!(reg.authenticate(&cap_b), Some(owner_b));
    assert_ne!(reg.authenticate(&cap_a), reg.authenticate(&cap_b));
}

#[test]
fn capability_never_appears_in_debug_or_descriptors() {
    let reg = WindowOwnerRegistry::default();
    let (owner, capability) = new_owner(&reg, "w1", 3001);
    let debug = format!("{owner:?}");
    assert!(!debug.contains(&capability));
    let (cwd, port) = reg.current_workspace(&owner).unwrap();
    assert_eq!(port, 3001);
    assert!(!format!("{cwd:?}").contains(&capability));
}

#[test]
fn initialization_script_exposes_capability_on_any_loopback_origin() {
    let script = capability_initialization_script("secret-cap");
    assert!(script.contains("\"secret-cap\""));
    assert!(script.contains("window.location.protocol === 'http:'"));
    assert!(script.contains("\"127.0.0.1\""));
    assert!(script.contains("\"localhost\""));
    assert!(!script.contains("window.location.port"));
    assert!(script.contains("__PICOT_NATIVE_CAPABILITY__"));
    assert!(script.contains("window === window.top"));
}

#[test]
fn workspace_transition_updates_cwd_and_port_on_commit() {
    let reg = WindowOwnerRegistry::default();
    let (owner, _) = new_owner(&reg, "w1", 3001);
    assert!(!reg.workspace_transition_in_progress(&owner));
    assert_eq!(reg.current_workspace_generation(&owner), Some(0));
    let gen = reg
        .begin_workspace_transition(&owner, PathBuf::from("/ws-b"), 3002)
        .unwrap();
    assert!(reg.workspace_transition_in_progress(&owner));
    reg.prepare_navigation(
        &owner,
        3002,
        PathBuf::from("/ws-b"),
        "http://127.0.0.1:3002",
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(reg.pending_target_port(&owner), Some(3002));
    assert_eq!(reg.pending_target_cwd(&owner), Some(PathBuf::from("/ws-b")));
    reg.commit_workspace_transition(&owner, gen, "http://127.0.0.1:3002")
        .unwrap();
    assert!(!reg.workspace_transition_in_progress(&owner));
    assert_eq!(reg.current_workspace_generation(&owner), Some(gen));
    let (cwd, port) = reg.current_workspace(&owner).unwrap();
    assert_eq!(cwd, PathBuf::from("/ws-b"));
    assert_eq!(port, 3002);
}

#[test]
fn pending_target_origin_tracks_prepare_and_commit() {
    let reg = WindowOwnerRegistry::default();
    let (owner, _) = new_owner(&reg, "w1", 3001);
    assert_eq!(reg.pending_target_origin(&owner), None);
    reg.prepare_navigation(
        &owner,
        3002,
        PathBuf::from("/workspace"),
        "http://127.0.0.1:3002",
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(
        reg.pending_target_origin(&owner).as_deref(),
        Some("http://127.0.0.1:3002")
    );
    let gen = reg
        .begin_workspace_transition(&owner, PathBuf::from("/ws-b"), 3002)
        .unwrap();
    let prepare_gen = reg
        .prepare_navigation(
            &owner,
            3002,
            PathBuf::from("/ws-b"),
            "http://127.0.0.1:3002",
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(prepare_gen, gen);
    reg.commit_workspace_transition(&owner, gen, "http://127.0.0.1:3002")
        .unwrap();
    assert_eq!(reg.pending_target_origin(&owner), None);
}

#[test]
fn cancel_workspace_transition_retains_old_binding() {
    let reg = WindowOwnerRegistry::default();
    let (owner, _) = new_owner(&reg, "w1", 3001);
    let gen = reg
        .begin_workspace_transition(&owner, PathBuf::from("/ws-b"), 3002)
        .unwrap();
    reg.prepare_navigation(
        &owner,
        3002,
        PathBuf::from("/ws-b"),
        "http://127.0.0.1:3002",
        Duration::from_secs(5),
    )
    .unwrap();

    reg.cancel_workspace_transition(&owner, gen).unwrap();
    let (cwd, port) = reg.current_workspace(&owner).unwrap();
    assert_eq!(cwd, PathBuf::from("/workspace"));
    assert_eq!(port, 3001);
    assert_eq!(reg.pending_target_origin(&owner), None);
    assert!(reg
        .begin_workspace_transition(&owner, PathBuf::from("/ws-c"), 3003)
        .is_ok());
}

#[test]
fn cancel_workspace_transition_rejects_mismatched_generation() {
    let reg = WindowOwnerRegistry::default();
    let (owner, _) = new_owner(&reg, "w1", 3001);
    let gen = reg
        .begin_workspace_transition(&owner, PathBuf::from("/ws-b"), 3002)
        .unwrap();
    assert!(reg.cancel_workspace_transition(&owner, gen + 999).is_err());
    assert!(reg
        .begin_workspace_transition(&owner, PathBuf::from("/ws-c"), 3003)
        .is_err());
}

#[test]
fn cancel_is_idempotent_when_nothing_in_progress() {
    let reg = WindowOwnerRegistry::default();
    let (owner, _) = new_owner(&reg, "w1", 3001);
    assert!(reg.cancel_workspace_transition(&owner, 42).is_ok());
}
