use super::super::HostDataPlane;
use super::isolated_workspace;
use std::collections::HashMap;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn deletes_sessions_by_id_across_projects_and_reports_missing_ids_as_errors() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-delete-{nonce}"));
    let workspace = temp.join("workspace");
    let other = temp.join("other");
    let sessions_a = temp.join("sessions/project-a");
    let sessions_b = temp.join("sessions/project-b");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&other).unwrap();
    fs::create_dir_all(&sessions_a).unwrap();
    fs::create_dir_all(&sessions_b).unwrap();
    let file_a = sessions_a.join("a.jsonl");
    let file_b = sessions_b.join("b.jsonl");
    fs::write(
        &file_a,
        format!(
            "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello\"}}}}\n",
            serde_json::to_string(&workspace.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    fs::write(
        &file_b,
        format!(
            "{{\"type\":\"session\",\"id\":\"session-b\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"other project\"}}}}\n",
            serde_json::to_string(&other.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
        .unwrap()
        .with_session_root(temp.join("sessions"));

    let result = data
        .delete_sessions(&[
            "session-a".to_owned(),
            "session-b".to_owned(),
            "missing".to_owned(),
        ])
        .unwrap();
    assert_eq!(result.deleted, vec!["session-a", "session-b"]);
    assert_eq!(result.errors, vec!["missing"]);
    assert!(!file_a.exists());
    assert!(!file_b.exists());
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn deletes_session_files_that_are_not_visible_session_summaries() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-delete-hidden-{nonce}"));
    let workspace = temp.join("workspace");
    let sessions = temp.join("sessions/project");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    let file = sessions.join("empty.jsonl");
    fs::write(
        &file,
        format!(
            "{{\"type\":\"session\",\"id\":\"session-empty\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"session_info\",\"name\":\"New thread\"}}\n",
            serde_json::to_string(&workspace.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
        .unwrap()
        .with_session_root(temp.join("sessions"));

    assert!(data.list_all_sessions("workspace-a").unwrap().is_empty());
    let result = data.delete_sessions(&["session-empty".to_owned()]).unwrap();

    assert_eq!(result.deleted, vec!["session-empty"]);
    assert!(result.errors.is_empty());
    assert!(!file.exists());
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn deletes_every_session_file_with_a_matching_id() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-delete-duplicates-{nonce}"));
    let workspace = temp.join("workspace");
    let sessions_a = temp.join("sessions/project-a");
    let sessions_b = temp.join("sessions/project-b");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&sessions_a).unwrap();
    fs::create_dir_all(&sessions_b).unwrap();
    let file_a = sessions_a.join("a.jsonl");
    let file_b = sessions_b.join("b.jsonl");
    let contents = format!(
        "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello\"}}}}\n",
        serde_json::to_string(&workspace.to_string_lossy()).unwrap()
    );
    fs::write(&file_a, &contents).unwrap();
    fs::write(&file_b, &contents).unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
        .unwrap()
        .with_session_root(temp.join("sessions"));

    let result = data.delete_sessions(&["session-a".to_owned()]).unwrap();

    assert_eq!(result.deleted, vec!["session-a"]);
    assert!(result.errors.is_empty());
    assert!(!file_a.exists());
    assert!(!file_b.exists());
    assert!(data.list_all_sessions("workspace-a").unwrap().is_empty());
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn resolves_the_file_path_for_a_saved_session_in_the_workspace() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-resolve-{nonce}"));
    let workspace = temp.join("workspace");
    let other = temp.join("other");
    let sessions = temp.join("sessions/project");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&other).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    let included = sessions.join("included.jsonl");
    fs::write(
        &included,
        format!(
            "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello\"}}}}\n",
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

    assert_eq!(
        data.resolve_session_path("workspace-a", "session-a")
            .unwrap(),
        Some(included)
    );
    assert_eq!(
        data.resolve_session_path("workspace-a", "session-b")
            .unwrap(),
        None
    );
    assert_eq!(
        data.resolve_session_path("workspace-a", "missing").unwrap(),
        None
    );
    fs::remove_dir_all(temp).unwrap();
}

#[cfg(unix)]
#[test]
fn resolve_session_path_reuses_the_index_without_rescanning_the_directory() {
    use std::os::unix::fs::PermissionsExt;

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-resolve-index-{nonce}"));
    let workspace = temp.join("workspace");
    let sessions = temp.join("sessions");
    let project = sessions.join("project");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&project).unwrap();
    let write_session = |file: &str, id: &str| {
        fs::write(
            project.join(file),
            format!(
                "{{\"type\":\"session\",\"id\":\"{id}\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello\"}}}}\n",
                serde_json::to_string(&workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
    };
    write_session("a.jsonl", "session-a");
    let included_b = project.join("b.jsonl");
    write_session("b.jsonl", "session-b");
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
        .unwrap()
        .with_session_root(sessions.clone());

    assert!(data
        .resolve_session_path("workspace-a", "session-a")
        .unwrap()
        .is_some());

    let mut perms = fs::metadata(&project).unwrap().permissions();
    perms.set_mode(0o111);
    fs::set_permissions(&project, perms.clone()).unwrap();

    let resolved = data.resolve_session_path("workspace-a", "session-b");
    perms.set_mode(0o755);
    fs::set_permissions(&project, perms).unwrap();
    assert_eq!(resolved.unwrap(), Some(included_b));

    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn searches_only_the_registered_workspace_and_returns_snippets() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-search-{nonce}"));
    let workspace = temp.join("workspace");
    let other = temp.join("other");
    let sessions = temp.join("sessions/project");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&other).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    fs::write(
        sessions.join("included.jsonl"),
        format!(
            "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"please refactor the widget factory\"}}}}\n",
            serde_json::to_string(&workspace.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    fs::write(
        sessions.join("excluded.jsonl"),
        format!(
            "{{\"type\":\"session\",\"id\":\"session-b\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"refactor this too\"}}}}\n",
            serde_json::to_string(&other.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
        .unwrap()
        .with_session_root(temp.join("sessions"));

    let results = data.search_sessions("workspace-a", "widget").unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].session_id, "session-a");
    assert!(results[0].matches[0].snippet.contains("widget"));

    assert!(
        data.search_sessions("workspace-a", "refactor")
            .unwrap()
            .len()
            == 1
    );
    assert!(data.search_sessions("missing", "widget").is_err());
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn builds_cost_dashboard_across_all_projects() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-cost-{nonce}"));
    let workspace = temp.join("workspace");
    let other = temp.join("other");
    let sessions = temp.join("sessions/project");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&other).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    fs::write(
        sessions.join("included.jsonl"),
        format!(
            "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hi\"}}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"model\":\"gpt-5\",\"usage\":{{\"input\":10,\"output\":20,\"cost\":{{\"total\":0.5}}}},\"content\":[{{\"type\":\"toolCall\",\"name\":\"bash\"}}]}}}}\n",
            serde_json::to_string(&workspace.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    fs::write(
        sessions.join("excluded.jsonl"),
        format!(
            "{{\"type\":\"session\",\"id\":\"session-b\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"model\":\"gpt-5\",\"usage\":{{\"cost\":{{\"total\":99.0}}}}}}}}\n",
            serde_json::to_string(&other.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
        .unwrap()
        .with_session_root(temp.join("sessions"));

    let dashboard = data.cost_dashboard("workspace-a").unwrap();
    assert_eq!(dashboard.summary.session_count, 2);
    assert_eq!(dashboard.summary.total_cost, 99.5);
    assert_eq!(dashboard.summary.total_tokens, 30);
    assert_eq!(dashboard.by_model[0].name, "gpt-5");
    assert_eq!(dashboard.by_tool[0].name, "bash");
    assert_eq!(dashboard.top_sessions[0].id, "session-b");
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn cost_dashboard_reuses_parsed_metrics_until_a_file_changes() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("picot-host-cost-cache-{nonce}"));
    let workspace = temp.join("workspace");
    let sessions = temp.join("sessions/project");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    let session_path = sessions.join("session-a.jsonl");
    fs::write(
        &session_path,
        format!(
            "{{\"type\":\"session\",\"id\":\"session-a\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"model\":\"gpt-5\",\"usage\":{{\"input\":10,\"output\":20,\"cost\":{{\"total\":1.0}}}}}}}}\n",
            serde_json::to_string(&workspace.to_string_lossy()).unwrap(),
        ),
    )
    .unwrap();
    let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
        .unwrap()
        .with_session_root(temp.join("sessions"));

    let first = data.cost_dashboard("workspace-a").unwrap();
    assert_eq!(first.summary.total_cost, 1.0);
    assert_eq!(data.cached_metrics_len(), 1);

    let second = data.cost_dashboard("workspace-a").unwrap();
    assert_eq!(second.summary.total_cost, 1.0);
    assert_eq!(data.cached_metrics_len(), 1);

    let mut updated = fs::read_to_string(&session_path).unwrap();
    updated.push_str(
        "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"model\":\"gpt-5\",\"usage\":{\"input\":1,\"output\":2,\"cost\":{\"total\":2.0}}}}\n",
    );
    fs::write(&session_path, updated).unwrap();
    let third = data.cost_dashboard("workspace-a").unwrap();
    assert_eq!(third.summary.total_cost, 3.0);
    assert_eq!(data.cached_metrics_len(), 1);

    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn opens_convertible_preview_input_inside_the_registered_workspace() {
    let (temp, data, workspace) = isolated_workspace("document");
    fs::write(workspace.join("report.docx"), b"document bytes").unwrap();

    let source = data
        .read_convertible_file("workspace-a", "report.docx")
        .unwrap()
        .unwrap();
    assert_eq!(source.suffix, "docx");
    assert_eq!(source.bytes, b"document bytes");
    assert!(data
        .read_convertible_file("workspace-a", "notes.csv")
        .unwrap()
        .is_none());
    fs::remove_dir_all(temp).unwrap();
}
