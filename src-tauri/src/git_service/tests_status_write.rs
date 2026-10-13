// Git 状态解析、工作区嵌套拒绝、暂存/丢弃与远端推送单元测试。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::path::Path;
use std::process::Command;

use super::porcelain::parse_porcelain_v2_z;
use super::process::{bounded_push_output, is_git_unavailable, map_git_spawn_error};
use super::{
    GitPathIdentity, GitService, GIT_NOT_FOUND, MAX_PUSH_OUTPUT_BYTES, PUSH_DETACHED_HEAD,
    PUSH_NO_REMOTE,
};

#[test]
fn parses_paths_and_renames() {
    let p = parse_porcelain_v2_z(
        b"# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\x002 R. N... 100644 100644 100644 a a R100 new\0old\0? - weird\npath\0",
    );
    assert_eq!(p.entries.len(), 2);
    assert_eq!(p.entries[0].original_display_path.as_deref(), Some("old"));
    assert_eq!(p.head_state, "attached");
    assert_eq!(p.branch.as_deref(), Some("main"));
    assert_eq!(p.upstream.as_deref(), Some("origin/main"));
    assert_eq!(p.ahead, Some(2));
    assert_eq!(p.behind, Some(1));
}

#[test]
fn parses_unborn_branch() {
    let p = parse_porcelain_v2_z(b"# branch.oid (initial)\0# branch.head main\0");
    assert_eq!(p.head_state, "unborn");
    assert_eq!(p.branch.as_deref(), Some("main"));
}

fn init_repo_with_commit(root: &Path) {
    let run = |args: &[&str]| {
        Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap()
    };
    assert!(run(&["init"]).status.success());
    assert!(run(&["config", "user.name", "Test"]).status.success());
    assert!(run(&["config", "user.email", "test@example.com"])
        .status
        .success());
    std::fs::write(root.join("file.txt"), "base\n").unwrap();
    assert!(run(&["add", "file.txt"]).status.success());
    assert!(run(&["commit", "-m", "base"]).status.success());
}

#[test]
fn push_publishes_to_a_bare_remote_and_then_reuses_the_upstream() {
    let remote = tempfile::tempdir().unwrap();
    assert!(Command::new("git")
        .args(["init", "--bare"])
        .arg(remote.path())
        .output()
        .unwrap()
        .status
        .success());
    let root = tempfile::tempdir().unwrap();
    init_repo_with_commit(root.path());
    assert!(Command::new("git")
        .current_dir(root.path())
        .args(["remote", "add", "origin"])
        .arg(remote.path())
        .output()
        .unwrap()
        .status
        .success());

    let service = GitService::new();
    let first = service.push(root.path()).unwrap();
    assert_eq!(first.remote, "origin");
    assert!(first.set_upstream, "first push must publish the branch");
    let refs = Command::new("git")
        .current_dir(remote.path())
        .args(["for-each-ref", "--format=%(refname)"])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&refs.stdout).contains(&format!("refs/heads/{}", first.branch)));

    std::fs::write(root.path().join("file.txt"), "second\n").unwrap();
    assert!(Command::new("git")
        .current_dir(root.path())
        .args(["commit", "-am", "second"])
        .output()
        .unwrap()
        .status
        .success());
    let second = service.push(root.path()).unwrap();
    assert!(
        !second.set_upstream,
        "a configured upstream must be reused, not re-set"
    );
}

#[test]
fn push_refuses_a_detached_head() {
    let root = tempfile::tempdir().unwrap();
    init_repo_with_commit(root.path());
    assert!(Command::new("git")
        .current_dir(root.path())
        .args(["checkout", "--detach"])
        .output()
        .unwrap()
        .status
        .success());
    assert_eq!(
        service_push_error(root.path()),
        PUSH_DETACHED_HEAD,
        "a detached HEAD has no branch to publish"
    );
}

#[test]
fn push_reports_a_repository_without_a_remote() {
    let root = tempfile::tempdir().unwrap();
    init_repo_with_commit(root.path());
    assert_eq!(service_push_error(root.path()), PUSH_NO_REMOTE);
}

fn service_push_error(root: &Path) -> String {
    GitService::new().push(root).expect_err("push must fail")
}

#[test]
fn bounded_push_output_keeps_the_tail_where_git_puts_the_reason() {
    let short = bounded_push_output(b"  ! [rejected] main -> main  ");
    assert_eq!(short, "! [rejected] main -> main");
    let long = format!("{}REASON", "x".repeat(MAX_PUSH_OUTPUT_BYTES));
    let bounded = bounded_push_output(long.as_bytes());
    assert!(bounded.starts_with("..."));
    assert!(bounded.ends_with("REASON"));
    assert!(bounded.len() <= MAX_PUSH_OUTPUT_BYTES + 3);
}

#[test]
fn missing_git_spawn_is_a_stable_unavailable_error() {
    let mapped = map_git_spawn_error(&std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "program not found",
    ));
    assert_eq!(mapped, GIT_NOT_FOUND);
    assert!(is_git_unavailable(&mapped));
    assert!(is_git_unavailable("program not found"));
    assert!(!is_git_unavailable("not a git repository"));
}

#[test]
fn parses_unmerged_stage_modes_and_object_ids() {
    let p = parse_porcelain_v2_z(
        b"u UU N... 100644 100755 100644 100644 deadbeef1111 deadbeef2222 deadbeef3333 conflict.txt\0",
    );
    let entry = &p.entries[0];
    assert_eq!(
        entry.unmerged_modes.as_deref(),
        Some(&["100644".into(), "100755".into(), "100644".into()][..])
    );
    assert_eq!(
        entry.unmerged_object_ids.as_deref(),
        Some(
            &[
                "deadbeef1111".into(),
                "deadbeef2222".into(),
                "deadbeef3333".into()
            ][..]
        )
    );
}

#[test]
fn stages_resolved_conflict_from_conflicted_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        Command::new("git")
            .current_dir(root.path())
            .args(args)
            .output()
            .unwrap()
    };
    assert!(run(&["init"]).status.success());
    std::fs::write(root.path().join("file.txt"), "base\n").unwrap();
    assert!(run(&["add", "file.txt"]).status.success());
    assert!(run(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "base",
    ])
    .status
    .success());
    assert!(run(&["checkout", "-b", "feature"]).status.success());
    std::fs::write(root.path().join("file.txt"), "feature\n").unwrap();
    assert!(run(&["commit", "-am", "feature"]).status.success());
    assert!(run(&["checkout", "-"]).status.success());
    std::fs::write(root.path().join("file.txt"), "main\n").unwrap();
    assert!(run(&["commit", "-am", "main"]).status.success());
    assert!(!run(&["merge", "feature"]).status.success());

    let service = GitService::new();
    let snapshot = service.status("owner", root.path(), 1).unwrap();
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.entry_kind == "unmerged")
        .unwrap();
    std::fs::write(root.path().join("file.txt"), "resolved\n").unwrap();
    service
        .write(
            &snapshot.snapshot_id,
            "owner",
            root.path(),
            1,
            &[GitPathIdentity {
                group: "conflicted".into(),
                path_bytes: BASE64.decode(&entry.path_bytes_base64).unwrap(),
                original_path_bytes: None,
            }],
            "stage",
        )
        .unwrap();
    let after = service.status("owner", root.path(), 1).unwrap();
    assert_eq!(after.counts.conflicted, 0);
    assert_eq!(after.counts.staged, 1);
}

#[test]
fn nested_workspace_is_rejected_for_subdirectory_root() {
    let parent = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        Command::new("git")
            .current_dir(parent.path())
            .args(args)
            .output()
            .unwrap()
    };
    assert!(run(&["init"]).status.success());
    std::fs::write(parent.path().join("parent.txt"), "p\n").unwrap();
    let sub = parent.path().join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(sub.join("sub.txt"), "s\n").unwrap();
    assert!(run(&["add", "parent.txt"]).status.success());
    assert!(run(&["add", "sub/sub.txt"]).status.success());

    let service = GitService::new();
    let err = service
        .status("owner", &sub, 1)
        .expect_err("nested workspace status must be refused");
    assert!(
        err.contains("nested") || err.contains("not a git repository"),
        "expected nested-repository rejection, got: {err}"
    );
    let err = service
        .prepare_ai_snapshot("owner", &sub, 1)
        .expect_err("nested workspace AI snapshot must be refused");
    assert!(
        err.contains("nested") || err.contains("not a git repository"),
        "expected nested-repository rejection, got: {err}"
    );
    let err = service
        .prepare_commit("snap", "owner", &sub, 1, "m", None)
        .expect_err("nested workspace commit must be refused");
    assert!(
        err.contains("nested") || err.contains("not a git repository"),
        "expected nested-repository rejection, got: {err}"
    );
}

#[test]
fn real_repo_stage_stale_and_discard_preserves_staged() {
    let root = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        Command::new("git")
            .current_dir(root.path())
            .args(args)
            .output()
            .unwrap()
    };
    assert!(run(&["init"]).status.success());
    std::fs::write(root.path().join("file.txt"), "one\n").unwrap();
    assert!(run(&["add", "file.txt"]).status.success());
    assert!(run(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "initial"
    ])
    .status
    .success());
    std::fs::write(root.path().join("file.txt"), "two\n").unwrap();
    let service = GitService::new();
    let before_stage = service.status("owner", root.path(), 1).unwrap();
    let entry = before_stage
        .entries
        .iter()
        .find(|entry| entry.display_path == "file.txt")
        .unwrap();
    let identity = GitPathIdentity {
        group: "changes".into(),
        path_bytes: b"file.txt".to_vec(),
        original_path_bytes: None,
    };
    service
        .write(
            &before_stage.snapshot_id,
            "owner",
            root.path(),
            1,
            &[identity],
            "stage",
        )
        .unwrap();
    std::fs::write(root.path().join("file.txt"), "three\n").unwrap();
    assert!(service
        .write(
            &before_stage.snapshot_id,
            "owner",
            root.path(),
            1,
            &[GitPathIdentity {
                group: "changes".into(),
                path_bytes: b"file.txt".to_vec(),
                original_path_bytes: None
            }],
            "stage"
        )
        .is_err());
    let after_stage = service.status("owner", root.path(), 1).unwrap();
    let staged = after_stage
        .entries
        .iter()
        .find(|entry| entry.display_path == "file.txt")
        .unwrap();
    assert!(service.belongs_to_group(staged, "staged"));
    service
        .write(
            &after_stage.snapshot_id,
            "owner",
            root.path(),
            1,
            &[GitPathIdentity {
                group: "changes".into(),
                path_bytes: b"file.txt".to_vec(),
                original_path_bytes: None,
            }],
            "discard",
        )
        .unwrap();
    let discarded = std::fs::read_to_string(root.path().join("file.txt")).unwrap();
    assert_eq!(discarded.replace("\r\n", "\n"), "two\n");
    let _ = entry;
}

#[test]
fn binary_diff_detected_as_fallback_reason() {
    let root = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        Command::new("git")
            .current_dir(root.path())
            .args(args)
            .output()
            .unwrap()
    };
    assert!(run(&["init"]).status.success());
    let binary_content = vec![b'G', b'I', b'F', 0u8, 1u8, 2u8, 3u8];
    std::fs::write(root.path().join("blob.bin"), &binary_content).unwrap();
    assert!(run(&["add", "blob.bin"]).status.success());
    assert!(run(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "initial"
    ])
    .status
    .success());
    let modified = vec![b'G', b'I', b'F', 0u8, 9u8, 9u8, 9u8];
    std::fs::write(root.path().join("blob.bin"), &modified).unwrap();
    let service = GitService::new();
    let snapshot = service.status("owner", root.path(), 1).unwrap();
    let entry = snapshot
        .entries
        .iter()
        .find(|e| e.display_path == "blob.bin")
        .unwrap();
    let path_bytes = BASE64.decode(&entry.path_bytes_base64).unwrap();
    let diff = service
        .diff(super::GitDiffRequest {
            snapshot_id: &snapshot.snapshot_id,
            owner: "owner",
            root: root.path(),
            generation: 1,
            group: "changes",
            path_bytes: &path_bytes,
            comparison: "changes",
        })
        .unwrap();
    assert_eq!(diff.fallback_reason.as_deref(), Some("binary"));
}

#[test]
fn rejects_magic_paths() {
    let service = GitService::new();
    let root = tempfile::tempdir().unwrap();
    assert!(service
        .validate_path("missing", "owner", root.path(), 1, b":(glob)*")
        .is_err());
}

#[test]
fn missing_snapshots_are_rejected_before_path_use() {
    let service = GitService::new();
    let root = tempfile::tempdir().unwrap();
    assert!(service
        .validate_path("missing", "owner", root.path(), 7, b"file")
        .is_err());
}

#[test]
fn rejects_empty_write_batches() {
    let service = GitService::new();
    let root = tempfile::tempdir().unwrap();
    assert!(service
        .write("missing", "owner", root.path(), 1, &[], "stage")
        .is_err());
}

#[test]
fn clearing_workspace_state_does_not_revoke_owner() {
    let service = GitService::new();
    service.clear_workspace_state("owner");
    assert!(
        !service.revoked_owners.lock().unwrap().contains("owner"),
        "a workspace transition must not revoke its still-live owner"
    );
}
