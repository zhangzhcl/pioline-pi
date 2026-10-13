use super::{git_output, is_remote_project_path, FileKind, HostDataError, HostDataPlane};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[path = "session_lifecycle_tests.rs"]
mod session_lifecycle_tests;

fn isolated_workspace(label: &str) -> (std::path::PathBuf, HostDataPlane, std::path::PathBuf) {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-{label}-{nonce}"));
    let workspace = temp.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let data =
        HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace.clone())])).unwrap();
    (temp, data, workspace)
}

#[test]
fn missing_git_binary_is_treated_as_unavailable() {
    let mut command = Command::new("picot-missing-git-binary-for-tests");
    command.arg("--version");
    assert!(git_output(command).is_none());
}

#[test]
fn recognizes_remote_workspace_anchor_paths() {
    let root = crate::remote_workspace::remotes_root().expect("remotes root");
    assert!(is_remote_project_path(
        &root.join("ubuntu@10.0.0.5").join("proj")
    ));
    assert!(!is_remote_project_path(
        &std::env::temp_dir().join("picot-local-project")
    ));
}

#[test]
fn workspace_info_without_git_metadata_still_returns_the_path() {
    let (temp, data, workspace) = isolated_workspace("git-optional-info");
    let info = data.workspace_info("workspace-a").unwrap();
    assert_eq!(
        info.path,
        workspace.canonicalize().unwrap().to_string_lossy()
    );
    assert!(!info.is_git);
    assert!(info.git_branch.is_none());
    assert!(info.repository.is_empty());
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn git_status_and_stat_without_a_repository_are_empty_not_errors() {
    let (temp, data, _) = isolated_workspace("git-optional-status");
    let status = data.git_status("workspace-a").unwrap();
    assert!(!status.is_git_repository);
    assert!(status.files.is_empty());
    let stat = data.git_stat("workspace-a").unwrap();
    assert!(!stat.is_git_repository);
    assert_eq!(stat.files_changed, 0);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn lists_registered_workspace_files_and_rejects_escape_paths() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-data-{nonce}"));
    let workspace = temp.join("workspace");
    fs::create_dir_all(workspace.join("src")).unwrap();
    fs::write(workspace.join("README.md"), "read me").unwrap();
    fs::write(workspace.join(".hidden"), "dotfile").unwrap();
    fs::write(temp.join("secret.txt"), "secret").unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)])).unwrap();

    let entries = data.list_files("workspace-a", "", false).unwrap();
    assert_eq!(entries[0].name, "src");
    assert_eq!(entries[0].kind, FileKind::Directory);
    assert_eq!(entries[1].relative_path, "README.md");
    assert_eq!(
        data.list_files("workspace-a", "../", false),
        Err(HostDataError::InvalidRelativePath)
    );
    assert_eq!(
        data.list_files("missing", "", false),
        Err(HostDataError::UnknownWorkspace)
    );
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn list_files_hides_dotfiles_by_default_and_shows_them_when_opted_in() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-hidden-{nonce}"));
    let workspace = temp.join("workspace");
    fs::create_dir_all(workspace.join(".git")).unwrap();
    fs::write(workspace.join(".env"), "dotfile").unwrap();
    fs::write(workspace.join("visible.txt"), "visible").unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)])).unwrap();

    let hidden = data
        .list_files("workspace-a", "", false)
        .unwrap()
        .into_iter()
        .map(|entry| entry.name)
        .collect::<Vec<_>>();
    assert_eq!(hidden, vec!["visible.txt"]);

    let shown = data
        .list_files("workspace-a", "", true)
        .unwrap()
        .into_iter()
        .map(|entry| entry.name)
        .collect::<Vec<_>>();
    assert_eq!(shown, vec![".git", ".env", "visible.txt"]);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn read_session_messages_preserves_user_and_assistant_entry_ids() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-messages-{nonce}"));
    let workspace = temp.join("workspace");
    let sessions = temp.join("sessions/project");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    fs::write(
        sessions.join("session-a.jsonl"),
        format!(
            "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n\
             {{\"type\":\"message\",\"id\":\"user-1\",\"parentId\":null,\"message\":{{\"role\":\"user\",\"content\":\"hello\"}}}}\n\
             {{\"type\":\"message\",\"id\":\"assistant-1\",\"parentId\":\"user-1\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"hi\"}}]}}}}\n\
             {{\"type\":\"message\",\"id\":\"inactive-user\",\"parentId\":\"assistant-1\",\"message\":{{\"role\":\"user\",\"content\":\"inactive\"}}}}\n\
             {{\"type\":\"message\",\"id\":\"active-user\",\"parentId\":\"assistant-1\",\"message\":{{\"role\":\"user\",\"content\":\"active\"}}}}\n\
             {{\"type\":\"message\",\"id\":\"active-assistant\",\"parentId\":\"active-user\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"current branch\"}}]}}}}\n",
            serde_json::to_string(&workspace.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
        .unwrap()
        .with_session_root(temp.join("sessions"));

    let messages = data
        .read_session_messages("workspace-a", "session-a")
        .unwrap();

    assert_eq!(
        messages,
        vec![
            json!({ "role": "user", "content": "hello", "entryId": "user-1" }),
            json!({ "role": "assistant", "content": [{ "type": "text", "text": "hi" }], "entryId": "assistant-1" }),
            json!({ "role": "user", "content": "active", "entryId": "active-user" }),
            json!({ "role": "assistant", "content": [{ "type": "text", "text": "current branch" }], "entryId": "active-assistant" }),
        ]
    );
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn read_session_tree_returns_full_entries_and_derived_leaf() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-tree-{nonce}"));
    let workspace = temp.join("workspace");
    let sessions = temp.join("sessions/project");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    let cwd = serde_json::to_string(&workspace.to_string_lossy()).unwrap();
    let lines: Vec<String> = vec![
        format!("{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{cwd}}}"),
        "{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"q1\"}}".into(),
        "{\"type\":\"message\",\"id\":\"tr1\",\"parentId\":\"u1\",\"message\":{\"role\":\"toolResult\",\"content\":[]}}".into(),
        "{\"type\":\"compaction\",\"id\":\"c1\",\"parentId\":\"tr1\"}".into(),
        "{\"type\":\"message\",\"id\":\"a1\",\"parentId\":\"c1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ans\"}]}}".into(),
        "{\"type\":\"message\",\"id\":\"u2\",\"parentId\":\"a1\",\"message\":{\"role\":\"user\",\"content\":\"q2\"}}".into(),
        "{\"type\":\"message\",\"id\":\"u3\",\"parentId\":\"a1\",\"message\":{\"role\":\"user\",\"content\":\"side\"}}".into(),
        "{\"type\":\"message\",\"id\":\"a3\",\"parentId\":\"u3\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"side-ans\"}]}}".into(),
    ];
    fs::write(sessions.join("session-a.jsonl"), lines.join("\n") + "\n").unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
        .unwrap()
        .with_session_root(temp.join("sessions"));

    let tree = data.read_session_tree("workspace-a", "session-a").unwrap();

    let ids: Vec<&str> = tree
        .entries
        .iter()
        .map(|entry| entry["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec!["session-a", "u1", "tr1", "c1", "a1", "u2", "u3", "a3"]
    );
    assert_eq!(tree.leaf_id.as_deref(), Some("a3"));

    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn read_session_tree_missing_session_errors() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-tree-missing-{nonce}"));
    let workspace = temp.join("workspace");
    let sessions = temp.join("sessions/project");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
        .unwrap()
        .with_session_root(temp.join("sessions"));

    let result = data.read_session_tree("workspace-a", "nope");
    assert!(result.is_err());
    fs::remove_dir_all(temp).unwrap();
}

#[cfg(unix)]
#[test]
fn rejects_symlinks_that_resolve_outside_the_workspace() {
    use std::os::unix::fs::symlink;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-data-link-{nonce}"));
    let workspace = temp.join("workspace");
    let outside = temp.join("outside");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&outside).unwrap();
    symlink(&outside, workspace.join("escape")).unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)])).unwrap();
    assert_eq!(
        data.list_files("workspace-a", "escape", false),
        Err(HostDataError::OutsideWorkspace)
    );
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn lists_only_sessions_owned_by_the_registered_workspace_and_skips_unknown_entries() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-sessions-{nonce}"));
    let workspace = temp.join("workspace");
    let other = temp.join("other");
    let sessions = temp.join("sessions/project");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&other).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    fs::write(
        sessions.join("included.jsonl"),
        format!(
            "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"future_entry\",\"payload\":true}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello from session\"}}}}\n",
            serde_json::to_string(&workspace.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    fs::write(
        sessions.join("excluded.jsonl"),
        format!(
            "{{\"type\":\"session\",\"id\":\"session-b\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"private\"}}}}\n",
            serde_json::to_string(&other.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
        .unwrap()
        .with_session_root(temp.join("sessions"));

    let listed = data.list_sessions("workspace-a").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, "session-a");
    assert!(listed[0].is_current_workspace);
    assert_eq!(listed[0].workspace_id, "workspace-a");
    assert_eq!(
        listed[0].first_message.as_deref(),
        Some("hello from session")
    );

    let all = data.list_all_sessions("workspace-a").unwrap();
    assert_eq!(all.len(), 2);
    let current = all.iter().find(|s| s.id == "session-a").unwrap();
    assert!(current.is_current_workspace);
    assert_eq!(current.workspace_id, "workspace-a");
    let foreign = all.iter().find(|s| s.id == "session-b").unwrap();
    assert!(!foreign.is_current_workspace);
    assert!(foreign.workspace_id.is_empty());
    assert!(foreign.project_path.ends_with("other"));
    assert_eq!(foreign.project_name, "other");

    let launcher = data.list_launcher_sessions().unwrap();
    assert_eq!(launcher.len(), 2);
    assert!(launcher
        .iter()
        .all(|session| !session.is_current_workspace && session.workspace_id.is_empty()));
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn list_all_sessions_orders_by_user_activity_not_file_mtime() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-session-activity-{nonce}"));
    let older_workspace = temp.join("older-workspace");
    let newer_workspace = temp.join("newer-workspace");
    let sessions = temp.join("sessions/project");
    fs::create_dir_all(&older_workspace).unwrap();
    fs::create_dir_all(&newer_workspace).unwrap();
    fs::create_dir_all(&sessions).unwrap();

    let older_file = sessions.join("older.jsonl");
    fs::write(
        &older_file,
        format!(
            "{{\"type\":\"session\",\"id\":\"older\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":{}}}\n\
             {{\"type\":\"message\",\"timestamp\":\"2026-01-01T00:00:01.000Z\",\"message\":{{\"role\":\"user\",\"timestamp\":1767225601000,\"content\":\"older activity\"}}}}\n",
            serde_json::to_string(&older_workspace.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    fs::write(
        sessions.join("newer.jsonl"),
        format!(
            "{{\"type\":\"session\",\"id\":\"newer\",\"timestamp\":\"2026-01-02T00:00:00.000Z\",\"cwd\":{}}}\n\
             {{\"type\":\"message\",\"timestamp\":\"2026-01-02T00:00:01.000Z\",\"message\":{{\"role\":\"user\",\"timestamp\":1767312001000,\"content\":\"newer activity\"}}}}\n",
            serde_json::to_string(&newer_workspace.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::OpenOptions::new()
        .append(true)
        .open(&older_file)
        .unwrap()
        .write_all(b"{\"type\":\"session_info\",\"name\":\"Touched title\"}\n")
        .unwrap();

    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), older_workspace)]))
        .unwrap()
        .with_session_root(temp.join("sessions"));

    let all = data.list_all_sessions("workspace-a").unwrap();
    assert_eq!(
        all.iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>(),
        vec!["newer", "older"]
    );
    assert!(all[1].modified_at_ms > all[0].modified_at_ms);
    assert!(all[0].activity_at_ms > all[1].activity_at_ms);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn reads_session_name_appended_after_many_messages() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-session-name-{nonce}"));
    let workspace = temp.join("workspace");
    let sessions = temp.join("sessions/project");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    let mut file = format!(
        "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n",
        serde_json::to_string(&workspace.to_string_lossy()).unwrap(),
    );
    file.push_str(
        "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"first turn\"}}\n",
    );
    for _ in 0..60 {
        file.push_str(
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"work\"}}\n",
        );
    }
    file.push_str("{\"type\":\"session_info\",\"name\":\"Generated title\"}\n");
    fs::write(sessions.join("long.jsonl"), file).unwrap();

    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
        .unwrap()
        .with_session_root(temp.join("sessions"));

    let all = data.list_all_sessions("workspace-a").unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, "session-a");
    assert_eq!(all[0].name.as_deref(), Some("Generated title"));
    assert_eq!(all[0].first_message.as_deref(), Some("first turn"));
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn list_all_sessions_skips_unreadable_session_files() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-sessions-unreadable-{nonce}"));
    let workspace = temp.join("workspace");
    let sessions = temp.join("sessions/project");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    fs::write(
        sessions.join("included.jsonl"),
        format!(
            "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello from session\"}}}}\n",
            serde_json::to_string(&workspace.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    let broken = sessions.join("broken.jsonl");
    fs::write(&broken, "").unwrap();
    fs::remove_file(&broken).unwrap();
    fs::create_dir(&broken).unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
        .unwrap()
        .with_session_root(temp.join("sessions"));

    let all = data.list_all_sessions("workspace-a").unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, "session-a");
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn remove_session_file_trash_first_prefers_trash_and_falls_back_to_unlink() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-trash-first-{nonce}"));
    fs::create_dir_all(&temp).unwrap();
    let file = temp.join("session.jsonl");
    fs::write(&file, "{}").unwrap();

    assert!(super::remove_session_file_trash_first_with(&file, |_| true).is_ok());
    assert!(file.exists());

    assert!(super::remove_session_file_trash_first_with(&file, |_| false).is_ok());
    assert!(!file.exists());

    assert!(super::remove_session_file_trash_first_with(&file, |_| false).is_ok());

    fs::remove_dir_all(temp).unwrap();
}
