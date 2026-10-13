// ABOUTME: Cross-process settings.json lock, legacy skills migration, atomic
// ABOUTME: settings writes, and skill link installation.

use crate::skill_source_registry::SkillSourceBinding;
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use super::discovery::{canonicalize_existing, to_posix};
use super::{
    scan_install_source, InstallCandidateSelection, InstallContext, SkillInstallCandidate,
    SkillInstallResult, SkillInstallScan, SkillTreeNode,
};

const SETTINGS_LOCK_STALE_MS: u64 = 10_000;
const SETTINGS_LOCK_RETRY_DELAY_MS: u64 = 20;
const SETTINGS_LOCK_MAX_ATTEMPTS: usize = 750; // ~15s ceiling

fn settings_lock_dir(settings_path: &Path) -> PathBuf {
    let mut s = settings_path.as_os_str().to_string_lossy().into_owned();
    s.push_str(".lock");
    PathBuf::from(s)
}

/// Cross-process settings lock compatible with Pi's proper-lockfile mkdir
/// strategy. Acquires an empty directory at `<settings>.lock`, clearing
/// stale holders (mtime older than 10s) like Pi does.
fn with_settings_lock<R>(settings_path: &Path, critical: impl FnOnce() -> R) -> Result<R, String> {
    let lock_dir = settings_lock_dir(settings_path);
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create settings dir: {e}"))?;
    }
    for _ in 0..SETTINGS_LOCK_MAX_ATTEMPTS {
        match fs::create_dir(&lock_dir) {
            Ok(()) => {
                let result = critical();
                let _ = fs::remove_dir(&lock_dir);
                return Ok(result);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // Staleness check.
                match fs::metadata(&lock_dir) {
                    Ok(meta) => {
                        let mtime = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map_or(0, |d| d.as_millis() as u64);
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or(0, |d| d.as_millis() as u64);
                        if now.saturating_sub(mtime) > SETTINGS_LOCK_STALE_MS {
                            let _ = fs::remove_dir(&lock_dir);
                            continue;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(format!("Settings lock stat failed: {error}")),
                }
                std::thread::sleep(std::time::Duration::from_millis(
                    SETTINGS_LOCK_RETRY_DELAY_MS,
                ));
            }
            Err(error) => return Err(format!("Cannot acquire settings lock: {error}")),
        }
    }
    Err(format!(
        "Timed out waiting for settings lock: {}",
        lock_dir.display()
    ))
}

/// Read Pi settings as a JSON object, migrating the legacy
/// `{ skills: { enableSkillCommands, customDirectories } }` shape (mirrors
/// migrateLegacySkills in skill-inventory.ts).
fn read_settings_object(settings_path: &Path) -> Result<Map<String, Value>, String> {
    if !settings_path.exists() {
        return Ok(Map::new());
    }
    let text = fs::read_to_string(settings_path)
        .map_err(|e| format!("Cannot read settings {}: {e}", settings_path.display()))?;
    let parsed: Value = serde_json::from_str(&text).map_err(|e| {
        format!(
            "Pi settings at {} must be valid JSON: {e}",
            settings_path.display()
        )
    })?;
    let Value::Object(mut obj) = parsed else {
        return Err(format!(
            "Pi settings must be a JSON object: {}",
            settings_path.display()
        ));
    };
    migrate_legacy_skills(&mut obj);
    Ok(obj)
}

fn migrate_legacy_skills(settings: &mut Map<String, Value>) {
    let Some(skills) = settings.get("skills").cloned() else {
        return;
    };
    let Some(skills_obj) = skills.as_object() else {
        return;
    };
    if let Some(enable) = skills_obj.get("enableSkillCommands") {
        if !settings.contains_key("enableSkillCommands") {
            settings.insert("enableSkillCommands".into(), enable.clone());
        }
    }
    if let Some(custom) = skills_obj
        .get("customDirectories")
        .and_then(|v| v.as_array())
    {
        let dirs: Vec<Value> = custom
            .iter()
            .filter(|v| v.as_str().is_some())
            .cloned()
            .collect();
        if dirs.is_empty() {
            settings.remove("skills");
        } else {
            settings.insert("skills".into(), Value::Array(dirs));
        }
    } else {
        settings.remove("skills");
    }
}

fn write_settings_atomically(settings_path: &Path, next: &Value) -> Result<(), String> {
    let dir = settings_path.parent().unwrap_or_else(|| Path::new(""));
    fs::create_dir_all(dir).map_err(|e| format!("Cannot create settings dir: {e}"))?;
    let tmp = dir.join(format!(
        ".picot-skills-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let pretty = serde_json::to_string_pretty(next).map_err(|e| e.to_string())?;
    if let Err(error) = fs::write(&tmp, format!("{pretty}\n")) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Cannot write settings: {error}"));
    }
    if let Err(error) = fs::rename(&tmp, settings_path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "Cannot replace settings {}: {error}",
            settings_path.display()
        ));
    }
    Ok(())
}

fn settings_skills(settings_path: &Path, _base_dir: &Path) -> Result<Vec<String>, String> {
    let obj = read_settings_object(settings_path)?;
    let skills = obj.get("skills").and_then(|v| v.as_array());
    Ok(skills
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

fn existing_canonical_path(entry: &str, base_dir: &Path) -> PathBuf {
    let target = base_dir.join(entry);
    canonicalize_existing(&target)
}

/// Collect all descendant candidates of a tree node.
fn flatten_candidates(node: &SkillTreeNode) -> Vec<&SkillInstallCandidate> {
    match node {
        SkillTreeNode::Candidate(c) => vec![c],
        SkillTreeNode::Group(g) => g.children.iter().flat_map(flatten_candidates).collect(),
    }
}

fn node_by_id(tree: &[SkillTreeNode]) -> HashMap<String, &SkillTreeNode> {
    let mut nodes = HashMap::new();
    fn visit<'a>(items: &'a [SkillTreeNode], nodes: &mut HashMap<String, &'a SkillTreeNode>) {
        for item in items {
            match item {
                SkillTreeNode::Group(g) => {
                    nodes.insert(g.id.clone(), item);
                    visit(&g.children, nodes);
                }
                SkillTreeNode::Candidate(c) => {
                    nodes.insert(c.id.clone(), item);
                }
            }
        }
    }
    visit(tree, &mut nodes);
    nodes
}

fn common_directory(paths: &[PathBuf]) -> Result<PathBuf, String> {
    if paths.is_empty() {
        return Err("Invalid skill install selection".into());
    }
    if paths.len() == 1 {
        return Ok(paths[0].clone());
    }
    let first = &paths[0];
    let components: Vec<Vec<_>> = paths
        .iter()
        .map(|p| p.components().collect::<Vec<_>>())
        .collect();
    let mut common: Vec<_> = Vec::new();
    for index in 0.. {
        let next = components[0].get(index);
        if next.is_none() || components.iter().any(|c| c.get(index) != next) {
            break;
        }
        common.push(next.unwrap());
    }
    let result: PathBuf = common.iter().collect();
    if result.as_os_str().is_empty() {
        Ok(first.clone())
    } else {
        Ok(result)
    }
}

/// Build the additions/skipped preview from a scan + selection. Mirrors
/// buildSkillInstallPreview in skill-installation.ts.
fn build_install_preview(
    scan: &SkillInstallScan,
    _scope: &str,
    selection: &[InstallCandidateSelection],
    base_dir: &Path,
) -> Result<(Vec<String>, Vec<String>), String> {
    let nodes = node_by_id(&scan.tree);
    let mut selected_paths: BTreeSet<PathBuf> = BTreeSet::new();
    for item in selection {
        let node = nodes
            .get(&item.id)
            .ok_or_else(|| "Invalid skill install selection".to_string())?;
        match node {
            SkillTreeNode::Candidate(c) => {
                selected_paths.insert(PathBuf::from(&c.display_canonical_path));
            }
            SkillTreeNode::Group(_g) => {
                let paths: Vec<PathBuf> = flatten_candidates(node)
                    .iter()
                    .map(|c| PathBuf::from(&c.display_canonical_path))
                    .collect();
                selected_paths.insert(common_directory(&paths)?);
            }
        }
        // Validate kind matches (TS: node.kind !== item.kind).
        let kind = match node {
            SkillTreeNode::Candidate(_) => "skill",
            SkillTreeNode::Group(_) => "group",
        };
        if kind != item.kind {
            return Err("Invalid skill install selection".into());
        }
    }
    let settings_path = base_dir.join("settings.json");
    let existing = settings_skills(&settings_path, base_dir)?;
    let configured: HashSet<PathBuf> = existing
        .iter()
        .filter(|e| !e.starts_with('!') && !e.starts_with('+') && !e.starts_with('-'))
        .map(|e| existing_canonical_path(e, base_dir))
        .collect();

    let mut additions = Vec::new();
    let mut skipped = Vec::new();
    for path in &selected_paths {
        if configured.contains(path) {
            skipped.push(path.to_string_lossy().into_owned());
            continue;
        }
        let encoded = to_posix(
            &path
                .strip_prefix(base_dir)
                .unwrap_or(path)
                .to_string_lossy(),
        );
        if encoded.is_empty() || encoded.starts_with("../") || encoded == ".." {
            additions.push(if encoded.is_empty() {
                path.to_string_lossy().into_owned()
            } else {
                encoded
            });
        } else {
            additions.push(format!("./{encoded}"));
        }
    }
    Ok((additions, skipped))
}

/// Install selected skill links into Pi's settings.json. Mirrors
/// installSkillLinks in skill-installation.ts: rescans to verify the
/// revision is fresh, takes the cross-process settings lock, builds the
/// preview, appends missing entries atomically.
pub fn install_links(
    binding: &SkillSourceBinding,
    scope: &str,
    scan_revision: &str,
    selection: &[InstallCandidateSelection],
    context: &InstallContext,
) -> Result<SkillInstallResult, String> {
    let base_dir = context.base_dir(scope);
    let settings_path = base_dir.join("settings.json");

    // Rescan OUTSIDE the lock to verify freshness.
    let fresh_scan = scan_install_source(binding, context);
    if fresh_scan.scan_revision != scan_revision || fresh_scan.source_id != binding.source_id {
        return Err("Skill install source changed; rescan and confirm again".into());
    }

    with_settings_lock(&settings_path, || -> Result<SkillInstallResult, String> {
        let (additions, skipped) = build_install_preview(&fresh_scan, scope, selection, &base_dir)?;
        let original = read_settings_object(&settings_path)?;
        let current_skills: Vec<Value> = original
            .get("skills")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|v| v.as_str().is_some())
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if !additions.is_empty() {
            let mut next = original;
            let mut merged = current_skills;
            for addition in &additions {
                merged.push(Value::String(addition.clone()));
            }
            next.insert("skills".into(), Value::Array(merged));
            write_settings_atomically(&settings_path, &Value::Object(next))?;
        }
        Ok(SkillInstallResult {
            scan: fresh_scan,
            added_entries: additions,
            skipped_entries: skipped,
            settings_changed: false,
            runtime_restart_required: true,
        })
    })?
    .map(|mut result| {
        result.settings_changed = !result.added_entries.is_empty();
        result
    })
}
