// ABOUTME: Unit tests for skill directory discovery, candidate tree construction,
// ABOUTME: and atomic settings.json link installation.

use super::*;
use crate::skill_source_registry::SkillSourceBinding;
use crate::window_owner::OwnerId;
use serde_json::Value;
use std::fs;
use std::path::Path;
use tempfile::tempdir;

fn binding(source_dir: &Path, secret: &str) -> (SkillSourceBinding, InstallContext) {
    let binding = SkillSourceBinding {
        source_id: "src-1".into(),
        canonical_path: source_dir.to_path_buf(),
        owner_id: OwnerId::from_client_id("client-1"),
        window_label: "client-1".into(),
        workspace_root: source_dir.to_path_buf(),
        workspace_port: 0,
        workspace_generation: 0,
    };
    let context = InstallContext {
        agent_dir: source_dir.to_path_buf(),
        cwd: source_dir.to_path_buf(),
        install_secret: secret.into(),
    };
    (binding, context)
}

fn write_skill(dir: &Path, name: &str, description: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n# {name}\n"),
    )
    .unwrap();
}

#[test]
fn scan_finds_single_skill_with_description() {
    let tmp = tempdir().unwrap();
    // SKILL.md at the source root itself -> one top-level candidate.
    write_skill(tmp.path(), "release-notes", "Cut a release");
    let (binding, context) = binding(tmp.path(), "secret");
    let scan = scan_install_source(&binding, &context);
    assert!(scan.diagnostics.is_empty(), "{:?}", scan.diagnostics);
    assert_eq!(scan.tree.len(), 1);
    match &scan.tree[0] {
        SkillTreeNode::Candidate(c) => {
            assert_eq!(c.name, "release-notes");
            assert_eq!(c.description, "Cut a release");
        }
        other => panic!("expected candidate, got {other:?}"),
    }
    assert_eq!(scan.default_selection.len(), 1);
    assert!(!scan.scan_revision.is_empty());
}

#[test]
fn scan_builds_nested_groups_and_dedupes_by_canonical() {
    let tmp = tempdir().unwrap();
    write_skill(&tmp.path().join("group-a/skill-one"), "skill-one", "First");
    write_skill(&tmp.path().join("group-a/skill-two"), "skill-two", "Second");
    write_skill(
        &tmp.path().join("group-b/skill-three"),
        "skill-three",
        "Third",
    );
    let (binding, context) = binding(tmp.path(), "secret");
    let scan = scan_install_source(&binding, &context);
    // Top level: two groups.
    assert_eq!(scan.tree.len(), 2, "{:?}", scan.tree);
    let group_names: Vec<_> = scan
        .tree
        .iter()
        .filter_map(|n| match n {
            SkillTreeNode::Group(g) => Some(g.name.clone()),
            _ => None,
        })
        .collect();
    assert!(group_names.contains(&"group-a".to_string()));
    assert!(group_names.contains(&"group-b".to_string()));
    // defaultSelection covers all 3 skills.
    assert_eq!(scan.default_selection.len(), 3);
}

#[test]
fn scan_rejects_skill_without_description() {
    let tmp = tempdir().unwrap();
    let skill_dir = tmp.path().join("no-desc");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: no-desc\n---\nbody\n",
    )
    .unwrap();
    let (binding, context) = binding(tmp.path(), "secret");
    let scan = scan_install_source(&binding, &context);
    assert!(scan.tree.is_empty(), "no candidate should surface");
    assert!(
        scan.diagnostics
            .iter()
            .any(|d| d.message.contains("description is required")),
        "{:?}",
        scan.diagnostics
    );
}

#[test]
fn install_appends_relative_entries_and_skips_existing() {
    let tmp = tempdir().unwrap();
    let agent = tmp.path().join("agent");
    let source = tmp.path().join("source");
    write_skill(&source.join("notes"), "release-notes", "Cut a release");

    // Pre-seed global settings with the skill already configured so the
    // install must skip it.
    fs::create_dir_all(&agent).unwrap();
    fs::write(
        agent.join("settings.json"),
        format!(
            "{{\"skills\":[\"{}\"]}}\n",
            source.join("notes").to_string_lossy().replace('\\', "/")
        ),
    )
    .unwrap();

    let binding = SkillSourceBinding {
        source_id: "src-1".into(),
        canonical_path: source,
        owner_id: OwnerId::from_client_id("client-1"),
        window_label: "client-1".into(),
        workspace_root: tmp.path().to_path_buf(),
        workspace_port: 0,
        workspace_generation: 0,
    };
    let context = InstallContext {
        agent_dir: agent,
        cwd: tmp.path().to_path_buf(),
        install_secret: "secret".into(),
    };
    // First scan to get a valid revision.
    let scan = scan_install_source(&binding, &context);
    let selection = scan.default_selection.clone();
    let result = install_links(
        &binding,
        "global",
        &scan.scan_revision,
        &selection,
        &context,
    )
    .expect("install should succeed");
    // Already configured -> skipped, nothing added.
    assert!(
        result.added_entries.is_empty(),
        "{:?}",
        result.added_entries
    );
    assert!(!result.skipped_entries.is_empty());
    assert!(!result.settings_changed);
}

#[test]
fn install_writes_new_skill_entry_atomically() {
    let tmp = tempdir().unwrap();
    let agent = tmp.path().join("agent");
    let source = tmp.path().join("source");
    write_skill(&source.join("fresh"), "fresh-skill", "A brand new skill");

    let binding = SkillSourceBinding {
        source_id: "src-2".into(),
        canonical_path: source,
        owner_id: OwnerId::from_client_id("client-2"),
        window_label: "client-2".into(),
        workspace_root: tmp.path().to_path_buf(),
        workspace_port: 0,
        workspace_generation: 0,
    };
    let context = InstallContext {
        agent_dir: agent.clone(),
        cwd: tmp.path().to_path_buf(),
        install_secret: "secret".into(),
    };
    let scan = scan_install_source(&binding, &context);
    let result = install_links(
        &binding,
        "global",
        &scan.scan_revision,
        &scan.default_selection,
        &context,
    )
    .expect("install should succeed");
    assert!(!result.added_entries.is_empty());
    assert!(result.settings_changed);
    // settings.json now contains a skills array with at least one entry.
    let written: Value =
        serde_json::from_str(&fs::read_to_string(agent.join("settings.json")).unwrap()).unwrap();
    let skills = written.get("skills").and_then(|v| v.as_array()).unwrap();
    assert!(skills.iter().any(|v| v.as_str().unwrap().contains("fresh")));
}

#[test]
fn install_rejects_stale_revision() {
    let tmp = tempdir().unwrap();
    let source = tmp.path().join("source");
    write_skill(&source.join("a"), "a", "desc a");
    let binding = SkillSourceBinding {
        source_id: "src-3".into(),
        canonical_path: source,
        owner_id: OwnerId::from_client_id("client-3"),
        window_label: "client-3".into(),
        workspace_root: tmp.path().to_path_buf(),
        workspace_port: 0,
        workspace_generation: 0,
    };
    let context = InstallContext {
        agent_dir: tmp.path().join("agent"),
        cwd: tmp.path().to_path_buf(),
        install_secret: "secret".into(),
    };
    let result = install_links(&binding, "global", "stale-revision", &[], &context);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("changed"));
}
