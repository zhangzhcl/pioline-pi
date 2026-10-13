// Git 历史日志分页、单次提交详情与提交级文件 Diff 单元测试。

use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;

use super::history::{parse_diff_tree_name_status_z, validate_oid};
use super::{GitService, MAX_LOG_MESSAGE_BYTES};

fn test_repo() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let run = |args: &[&str]| {
        let output = StdCommand::new("git")
            .current_dir(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run(&["init", "-q", "-b", "main"]);
    run(&["config", "user.name", "Test"]);
    run(&["config", "user.email", "test@example.com"]);
    run(&["config", "core.autocrlf", "false"]);
    (dir, root)
}

fn test_commit(root: &Path, path: &str, content: &str, message: &str) -> String {
    std::fs::write(root.join(path), content).unwrap();
    let run = |args: &[&str]| {
        let output = StdCommand::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run(&["add", "-A"]);
    run(&["commit", "-q", "-m", message]);
    let output = StdCommand::new("git")
        .current_dir(root)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[test]
fn parses_diff_tree_name_status_z_flat_and_rename() {
    let files = parse_diff_tree_name_status_z(
        b"M\0a.txt\0A\0b.txt\0R100\0old.txt\0new.txt\0C75\0source\nname\0copy\"name\0\0",
    );
    assert_eq!(files.len(), 4);
    assert_eq!(files[0].status, "M");
    assert_eq!(files[0].path, "a.txt");
    assert_eq!(files[2].status, "R100");
    assert_eq!(files[2].path, "new.txt");
    assert_eq!(files[2].original_path.as_deref(), Some("old.txt"));
    assert_eq!(files[3].status, "C75");
    assert_eq!(files[3].original_path.as_deref(), Some("source\nname"));
    assert_eq!(files[3].path, "copy\"name");
}

#[test]
fn parses_diff_tree_name_status_z_empty_fields_and_missing_paths() {
    let files = parse_diff_tree_name_status_z(b"M\0A\0R50\0only-one\0\0");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].status, "M");
    assert_eq!(files[0].path, "A");
}

#[test]
fn validate_oid_rejects_injection_and_bad_shape() {
    assert!(validate_oid(&"0".repeat(40)).is_ok());
    assert!(validate_oid(&"0".repeat(64)).is_ok());
    assert!(validate_oid("; rm -rf /").is_err());
    assert!(validate_oid("abc").is_err());
    assert!(validate_oid(&"g".repeat(40)).is_err());
}

#[test]
#[cfg(unix)]
fn log_detail_and_commit_diff_preserve_empty_message_fields() {
    let (_dir, root) = test_repo();
    std::fs::write(root.join("line\nname.txt"), "one\n").unwrap();
    let output = StdCommand::new("git")
        .current_dir(&root)
        .args(["add", "-A"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let output = StdCommand::new("git")
        .current_dir(&root)
        .args(["commit", "-q", "--allow-empty-message", "-m", ""])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let root_oid = String::from_utf8(
        StdCommand::new("git")
            .current_dir(&root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned();
    let service = GitService::new();
    let page = service.log("owner", &root, 1, 50, None).unwrap();
    assert_eq!(page.commits.len(), 1);
    assert_eq!(page.commits[0].subject, "");
    let detail = service.log_detail("owner", &root, 1, &root_oid).unwrap();
    assert_eq!(detail.full_message, "");
    assert_eq!(detail.files[0].path, "line\nname.txt");
    let diff = service
        .commit_diff("owner", &root, 1, &root_oid, b"line\nname.txt")
        .unwrap();
    assert_eq!(diff.comparison, "commit");
    assert!(diff.raw_patch.contains("+one"));
    let response = serde_json::to_value(&diff).unwrap();
    assert!(response.get("snapshotId").is_none());
    assert!(service
        .commit_diff("owner", &root, 1, &root_oid, b"missing")
        .is_err());
}

#[test]
fn log_detail_trims_git_format_newline_but_preserves_message_body() {
    let (_dir, root) = test_repo();
    let message_path = root.join("message.txt");
    std::fs::write(&message_path, "subject\n\nbody\n").unwrap();
    let output = StdCommand::new("git")
        .current_dir(&root)
        .args(["commit", "--allow-empty", "-q", "-F", "message.txt"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let oid = String::from_utf8(
        StdCommand::new("git")
            .current_dir(&root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned();
    let detail = GitService::new()
        .log_detail("owner", &root, 1, &oid)
        .unwrap();
    assert_eq!(detail.full_message, "subject\n\nbody");
    assert!(!detail.full_message.ends_with(['\r', '\n']));
}

#[test]
fn log_detail_marks_oversized_message_as_truncated() {
    let (_dir, root) = test_repo();
    let message_path = root.join("message.txt");
    std::fs::write(
        &message_path,
        format!("{}\n", "x".repeat(MAX_LOG_MESSAGE_BYTES + 1)),
    )
    .unwrap();
    let output = StdCommand::new("git")
        .current_dir(&root)
        .args(["commit", "--allow-empty", "-q", "-F", "message.txt"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let oid = String::from_utf8(
        StdCommand::new("git")
            .current_dir(&root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned();
    let detail = GitService::new()
        .log_detail("owner", &root, 1, &oid)
        .unwrap();
    assert!(detail.message_truncated);
    assert!(detail.full_message.ends_with('…'));
}

#[test]
fn log_detail_and_commit_diff_detect_real_rename() {
    let (_dir, root) = test_repo();
    test_commit(&root, "old.txt", "content\n", "add old");
    let output = StdCommand::new("git")
        .current_dir(&root)
        .args(["mv", "old.txt", "new.txt"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let output = StdCommand::new("git")
        .current_dir(&root)
        .args(["commit", "-q", "-m", "rename"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let oid = String::from_utf8(
        StdCommand::new("git")
            .current_dir(&root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned();
    let service = GitService::new();
    let detail = service.log_detail("owner", &root, 1, &oid).unwrap();
    assert_eq!(detail.files.len(), 1);
    assert!(detail.files[0].status.starts_with('R'));
    assert_eq!(detail.files[0].original_path.as_deref(), Some("old.txt"));
    assert_eq!(detail.files[0].path, "new.txt");
    let diff = service
        .commit_diff("owner", &root, 1, &oid, b"new.txt")
        .unwrap();
    assert_eq!(diff.fallback_reason.as_deref(), Some("rename"));
}

#[test]
fn log_paginates_first_parent_and_stops_at_root() {
    let (_dir, root) = test_repo();
    let root_oid = test_commit(&root, "root.txt", "root\n", "root");
    let second_oid = test_commit(&root, "second.txt", "second\n", "second");
    let service = GitService::new();
    let first = service.log("owner", &root, 1, 1, None).unwrap();
    assert_eq!(first.commits[0].oid, second_oid);
    assert!(first.has_more);
    let second = service
        .log("owner", &root, 1, 1, Some(&second_oid))
        .unwrap();
    assert_eq!(second.commits[0].oid, root_oid);
    let end = service.log("owner", &root, 1, 1, Some(&root_oid)).unwrap();
    assert!(end.commits.is_empty());
    assert!(!end.has_more);
    let unknown = "0".repeat(40);
    assert!(service.log("owner", &root, 1, 1, Some(&unknown)).is_err());
}

#[test]
fn log_detail_and_commit_diff_use_first_parent_for_merges() {
    let (_dir, root) = test_repo();
    test_commit(&root, "base.txt", "base\n", "base");
    let run = |args: &[&str]| {
        let output = StdCommand::new("git")
            .current_dir(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run(&["checkout", "-q", "-b", "side"]);
    test_commit(&root, "side.txt", "side\n", "side");
    run(&["checkout", "-q", "main"]);
    test_commit(&root, "main.txt", "main\n", "main");
    run(&["merge", "-q", "--no-ff", "-m", "merge", "side"]);
    let merge_oid = String::from_utf8(
        StdCommand::new("git")
            .current_dir(&root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned();
    let service = GitService::new();
    let detail = service.log_detail("owner", &root, 1, &merge_oid).unwrap();
    let paths = detail
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<Vec<_>>();
    assert!(paths.contains(&"side.txt"));
    assert!(!paths.contains(&"main.txt"));
    let diff = service
        .commit_diff("owner", &root, 1, &merge_oid, b"side.txt")
        .unwrap();
    assert!(diff.raw_patch.contains("+side"));
    assert!(service
        .commit_diff("owner", &root, 1, &merge_oid, b"main.txt")
        .is_err());
}
