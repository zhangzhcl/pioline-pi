// Git AI 快照截断、部分暂存确认令牌、后台分离式 Commit 与二进制 Diff 检测测试。

use std::path::Path;
use std::process::Command;
use std::sync::mpsc::Receiver;
use std::time::Duration;

use super::porcelain::bounded_ai_diff;
use super::{GitDetachedCommit, GitService};

fn spawn_test_commit(
    service: &GitService,
    snapshot_id: &str,
    root: &Path,
    message: &str,
) -> Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    service.commit_detached(GitDetachedCommit {
        snapshot_id: snapshot_id.to_string(),
        owner: "owner".into(),
        root: root.to_path_buf(),
        generation: 1,
        request_id: "req".into(),
        message: message.into(),
        notify: Some(Box::new(move |frame| {
            let _ = tx.send(frame);
        })),
    });
    rx
}

#[test]
fn bounds_ai_diff_by_chars_files_and_lines() {
    let one_file = "diff --git a/a b/a\n".repeat(81);
    let (lines, lines_truncated) = bounded_ai_diff(one_file.as_bytes());
    assert!(lines_truncated);
    assert!(lines.lines().count() <= 80);

    let many_files = (0..81).fold(String::new(), |mut out, index| {
        use std::fmt::Write as _;
        let _ = writeln!(out, "diff --git a/{index} b/{index}");
        out
    });
    let (_, files_truncated) = bounded_ai_diff(many_files.as_bytes());
    assert!(files_truncated);

    let oversized = "x".repeat(24_001);
    let (chars, chars_truncated) = bounded_ai_diff(oversized.as_bytes());
    assert!(chars_truncated);
    assert!(chars.chars().count() <= 24_000);
}

#[test]
fn partial_stage_commit_requires_confirmation_token() {
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
    assert!(run(&["add", "file.txt"]).status.success());
    std::fs::write(root.path().join("file.txt"), "three\n").unwrap();
    let service = GitService::new();
    let snapshot = service
        .prepare_ai_snapshot("owner", root.path(), 1)
        .unwrap();
    let error = service
        .prepare_commit(
            &snapshot.snapshot_id,
            "owner",
            root.path(),
            1,
            "test: partial",
            None,
        )
        .unwrap_err();
    let token = error
        .strip_prefix("confirmationRequired:")
        .unwrap()
        .to_string();
    assert!(service
        .prepare_commit(
            &snapshot.snapshot_id,
            "owner",
            root.path(),
            1,
            "test: partial",
            Some("wrong"),
        )
        .is_err());
    service
        .prepare_commit(
            &snapshot.snapshot_id,
            "owner",
            root.path(),
            1,
            "test: partial",
            Some(&token),
        )
        .unwrap();
    let rx = spawn_test_commit(
        &service,
        &snapshot.snapshot_id,
        root.path(),
        "test: partial",
    );
    let frame = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(
        frame.contains("\"status\":\"succeeded\""),
        "frame was: {frame}"
    );
    let outcomes = service.take_pending_outcomes("owner", root.path(), 1);
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].status, "succeeded");
    assert!(!outcomes[0].commit_oid.as_ref().unwrap().is_empty());
}

#[test]
fn detached_commit_captures_snapshot_before_waiting_for_write_slot() {
    let root = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        Command::new("git")
            .current_dir(root.path())
            .args(args)
            .output()
            .unwrap()
    };
    assert!(run(&["init"]).status.success());
    run(&["config", "core.hooksPath", ".git/hooks"]);
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
    assert!(run(&["add", "file.txt"]).status.success());
    let service = GitService::new();
    let snapshot = service
        .prepare_ai_snapshot("owner", root.path(), 1)
        .unwrap();
    service
        .prepare_commit(&snapshot.snapshot_id, "owner", root.path(), 1, "test", None)
        .unwrap();
    let slot = service.lock_for_write(root.path());
    let guard = slot.lock().unwrap();
    let rx = spawn_test_commit(&service, &snapshot.snapshot_id, root.path(), "test");
    std::thread::sleep(Duration::from_millis(20));
    service.clear_workspace_state("owner");
    drop(guard);
    let frame = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(
        frame.contains("\"status\":\"succeeded\""),
        "frame was: {frame}"
    );
}

#[test]
fn detached_commit_keeps_expected_tree_after_workspace_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        Command::new("git")
            .current_dir(root.path())
            .args(args)
            .output()
            .unwrap()
    };
    assert!(run(&["init"]).status.success());
    run(&["config", "core.hooksPath", ".git/hooks"]);
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
    let hook = root.path().join(".git/hooks/pre-commit");
    std::fs::create_dir_all(root.path().join(".git/hooks")).unwrap();
    std::fs::write(&hook, "#!/bin/sh\nsleep 0.2\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(root.path().join("file.txt"), "two\n").unwrap();
    assert!(run(&["add", "file.txt"]).status.success());
    let service = GitService::new();
    let snapshot = service
        .prepare_ai_snapshot("owner", root.path(), 1)
        .unwrap();
    service
        .prepare_commit(&snapshot.snapshot_id, "owner", root.path(), 1, "test", None)
        .unwrap();
    let rx = spawn_test_commit(&service, &snapshot.snapshot_id, root.path(), "test");
    std::thread::sleep(Duration::from_millis(50));
    service.clear_workspace_state("owner");
    let frame = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(
        frame.contains("\"status\":\"succeeded\""),
        "frame was: {frame}"
    );
    assert!(
        frame.contains("\"hookChangedTree\":false"),
        "workspace cleanup must not erase the detached commit expected tree: {frame}"
    );
}

#[test]
fn revoked_owner_commit_outcome_is_dropped() {
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
    let service = GitService::new();
    let snapshot = service
        .prepare_ai_snapshot("owner", root.path(), 1)
        .unwrap();
    service
        .prepare_commit(&snapshot.snapshot_id, "owner", root.path(), 1, "test", None)
        .unwrap();
    service.clear_owner("owner");
    let rx = spawn_test_commit(&service, &snapshot.snapshot_id, root.path(), "test");
    let _frame = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let outcomes = service.take_pending_outcomes("owner", root.path(), 1);
    assert!(outcomes.is_empty(), "revoked owner outcome must be dropped");
}

#[test]
fn commit_failure_preserves_hook_stderr() {
    let root = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        Command::new("git")
            .current_dir(root.path())
            .args(args)
            .output()
            .unwrap()
    };
    assert!(run(&["init"]).status.success());
    run(&["config", "core.hooksPath", ".git/hooks"]);
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
    let hook = root.path().join(".git/hooks/pre-commit");
    std::fs::create_dir_all(root.path().join(".git/hooks")).unwrap();
    std::fs::write(&hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(root.path().join("file.txt"), "two\n").unwrap();
    assert!(run(&["add", "file.txt"]).status.success());
    let service = GitService::new();
    let snapshot = service
        .prepare_ai_snapshot("owner", root.path(), 1)
        .unwrap();
    service
        .prepare_commit(&snapshot.snapshot_id, "owner", root.path(), 1, "test", None)
        .unwrap();
    let rx = spawn_test_commit(&service, &snapshot.snapshot_id, root.path(), "test");
    let frame = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(
        frame.contains("\"status\":\"failed\""),
        "expected failed, got: {frame}"
    );
    assert!(
        frame.contains("hook says no"),
        "expected hook stderr preserved, got: {frame}"
    );
}

#[test]
fn per_root_write_locks_do_not_block_other_workspaces() {
    let service = GitService::new();
    let root_a = tempfile::tempdir().unwrap();
    let root_b = tempfile::tempdir().unwrap();
    let slot_a = service.lock_for_write(root_a.path());
    let _guard_a = slot_a.lock().unwrap();
    let slot_b = service.lock_for_write(root_b.path());
    let guard_b = slot_b.try_lock();
    assert!(
        guard_b.is_ok(),
        "different workspace root should not be blocked"
    );
}

#[test]
fn commit_detached_rejects_stale_index_after_prepare() {
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
    assert!(run(&["add", "file.txt"]).status.success());
    let service = GitService::new();
    let snapshot = service
        .prepare_ai_snapshot("owner", root.path(), 1)
        .unwrap();
    service
        .prepare_commit(
            &snapshot.snapshot_id,
            "owner",
            root.path(),
            1,
            "test: commit",
            None,
        )
        .unwrap();
    std::fs::write(root.path().join("other.txt"), "x\n").unwrap();
    assert!(run(&["add", "other.txt"]).status.success());
    let rx = spawn_test_commit(&service, &snapshot.snapshot_id, root.path(), "test: commit");
    let frame = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(
        frame.contains("\"status\":\"failed\""),
        "expected stale rejection, got: {frame}"
    );
}

#[test]
fn commit_detached_succeeds_for_unborn_repository() {
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
    let service = GitService::new();
    let snapshot = service
        .prepare_ai_snapshot("owner", root.path(), 1)
        .unwrap();
    service
        .prepare_commit(
            &snapshot.snapshot_id,
            "owner",
            root.path(),
            1,
            "test: unborn",
            None,
        )
        .unwrap();
    let rx = spawn_test_commit(&service, &snapshot.snapshot_id, root.path(), "test: unborn");
    let frame = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(
        frame.contains("\"status\":\"succeeded\""),
        "expected succeeded for unborn first commit, got: {frame}"
    );
    assert!(root.path().join(".git/HEAD").exists());
}
