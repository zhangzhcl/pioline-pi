// ABOUTME: Rust port of extensions/skill-discovery.ts + skill-installation.ts.
// ABOUTME: Scans a chosen directory for SKILL.md candidates, builds an opaque
// ABOUTME: candidate tree keyed by the install secret, and links selected
// ABOUTME: candidates into Pi's settings.json under a cross-process lock.

mod discovery;
mod settings_store;
#[cfg(test)]
mod tests;

pub use self::settings_store::install_links;

use crate::skill_source_registry::SkillSourceBinding;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;

use self::discovery::{
    canonicalize_existing, discover_skills_from_root, length_delimited_hash, opaque_id, to_posix,
    DiscoveredSkill,
};

// ── Public types (serde shapes match the TS originals for the frontend) ──

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDiagnostic {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallCandidate {
    pub kind: &'static str,
    pub id: String,
    pub name: String,
    pub description: String,
    pub display_canonical_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallGroup {
    pub kind: &'static str,
    pub id: String,
    pub name: String,
    pub children: Vec<SkillTreeNode>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum SkillTreeNode {
    Group(SkillInstallGroup),
    Candidate(SkillInstallCandidate),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCandidateSelection {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallScan {
    pub source_id: String,
    pub display_canonical_source_path: String,
    pub scan_revision: String,
    pub tree: Vec<SkillTreeNode>,
    pub default_selection: Vec<InstallCandidateSelection>,
    pub diagnostics: Vec<SkillDiagnostic>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallResult {
    pub scan: SkillInstallScan,
    pub added_entries: Vec<String>,
    pub skipped_entries: Vec<String>,
    pub settings_changed: bool,
    pub runtime_restart_required: bool,
}

/// Context the host reconstructs for a scan/install: the on-disk paths the
/// operation needs plus the install secret that keys opaque candidate IDs.
#[derive(Clone, Debug)]
pub struct InstallContext {
    /// Pi agent dir (~/.pi/agent), the global settings base.
    pub agent_dir: PathBuf,
    /// Current workspace cwd, the project settings base parent.
    pub cwd: PathBuf,
    /// Host install secret; keys opaque candidate IDs so the browser cannot
    /// forge them.
    pub install_secret: String,
}

impl InstallContext {
    pub(super) fn base_dir(&self, scope: &str) -> PathBuf {
        if scope == "global" {
            self.agent_dir.clone()
        } else {
            self.cwd.join(".pi")
        }
    }
}

// ── Revision + tree building ──────────────────────────────────────────

fn tree_path(skill: &DiscoveredSkill, source: &str) -> Vec<String> {
    let rel = to_posix(
        &skill
            .skill_dir
            .strip_prefix(source)
            .unwrap_or(&skill.skill_dir)
            .to_string_lossy(),
    );
    if rel.is_empty() {
        Vec::new()
    } else {
        rel.split('/')
            .filter(|p| !p.is_empty())
            .map(String::from)
            .collect()
    }
}

fn build_revision(
    source: &str,
    skills: &[DiscoveredSkill],
    memberships: &BTreeSet<String>,
) -> String {
    let mut hash = Sha256::new();
    length_delimited_hash(&mut hash, "root");
    length_delimited_hash(&mut hash, source);
    let mut sorted: Vec<&DiscoveredSkill> = skills.iter().collect();
    sorted.sort_by(|a, b| a.canonical_path.cmp(&b.canonical_path));
    for skill in sorted {
        length_delimited_hash(&mut hash, "candidate");
        length_delimited_hash(&mut hash, &skill.canonical_path);
        let content = fs::read_to_string(&skill.file_path).unwrap_or_default();
        let mut content_hash = Sha256::new();
        content_hash.update(content.as_bytes());
        length_delimited_hash(&mut hash, &hex::encode(content_hash.finalize()));
        length_delimited_hash(&mut hash, &skill.name);
        length_delimited_hash(&mut hash, &skill.description);
    }
    for membership in memberships {
        length_delimited_hash(&mut hash, "group");
        length_delimited_hash(&mut hash, membership);
    }
    hex::encode(hash.finalize())
}

fn empty_scan(source_id: &str, canonical: &str, revision_suffix: &str) -> SkillInstallScan {
    let mut hash = Sha256::new();
    length_delimited_hash(&mut hash, "root");
    length_delimited_hash(&mut hash, canonical);
    length_delimited_hash(&mut hash, revision_suffix);
    SkillInstallScan {
        source_id: source_id.to_string(),
        display_canonical_source_path: canonical.to_string(),
        scan_revision: hex::encode(hash.finalize()),
        tree: Vec::new(),
        default_selection: Vec::new(),
        diagnostics: Vec::new(),
    }
}

/// Scan a chosen source directory and return an opaque candidate tree.
/// Mirrors scanSkillInstallSource in skill-installation.ts.
pub fn scan_install_source(
    binding: &SkillSourceBinding,
    context: &InstallContext,
) -> SkillInstallScan {
    let canonical_source = canonicalize_existing(&binding.canonical_path);
    let canonical_str = canonical_source.to_string_lossy().into_owned();
    let Ok(meta) = fs::metadata(&canonical_source) else {
        let mut scan = empty_scan(&binding.source_id, &canonical_str, "missing");
        scan.diagnostics.push(SkillDiagnostic {
            path: Some(canonical_str),
            message: "source directory is not accessible".into(),
        });
        return scan;
    };
    if !meta.is_dir() {
        let mut scan = empty_scan(&binding.source_id, &canonical_str, "file");
        scan.diagnostics.push(SkillDiagnostic {
            path: Some(canonical_str),
            message: "source is not a directory".into(),
        });
        return scan;
    }
    let mut diagnostics = Vec::new();
    let mut skills = discover_skills_from_root(&canonical_source, &mut diagnostics);
    // Build group membership set (all ancestor prefixes of each skill path).
    let mut memberships: BTreeSet<String> = BTreeSet::new();
    for skill in &skills {
        let parts = tree_path(skill, &canonical_str);
        for i in 1..parts.len() {
            memberships.insert(parts[..i].join("/"));
        }
    }
    let revision = build_revision(&canonical_str, &skills, &memberships);

    let mut tree: Vec<SkillTreeNode> = Vec::new();
    let mut groups: HashMap<String, SkillInstallGroup> = HashMap::new();
    let mut default_selection: Vec<InstallCandidateSelection> = Vec::new();

    fn ensure_group(
        path_parts: &[String],
        groups: &mut HashMap<String, SkillInstallGroup>,
        tree: &mut Vec<SkillTreeNode>,
        key: &str,
        source_id: &str,
        revision: &str,
    ) -> SkillInstallGroup {
        let path = path_parts.join("/");
        if let Some(existing) = groups.get(&path) {
            return existing.clone();
        }
        let group = SkillInstallGroup {
            kind: "group",
            id: opaque_id(key, source_id, revision, "group", &path),
            name: path_parts.last().cloned().unwrap_or_default(),
            children: Vec::new(),
        };
        groups.insert(path.clone(), group.clone());
        if path_parts.len() == 1 {
            tree.push(SkillTreeNode::Group(group));
        } else {
            let parent = ensure_group(
                &path_parts[..path_parts.len() - 1],
                groups,
                tree,
                key,
                source_id,
                revision,
            );
            if let Some(SkillTreeNode::Group(parent_node)) = tree
                .iter_mut()
                .find(|n| matches!(n, SkillTreeNode::Group(g) if g.id == parent.id))
            {
                parent_node.children.push(SkillTreeNode::Group(group));
            }
        }
        groups.get(&path).cloned().unwrap()
    }

    skills.sort_by(|a, b| a.canonical_path.cmp(&b.canonical_path));
    for skill in &skills {
        let parts = tree_path(skill, &canonical_str);
        let id = opaque_id(
            &context.install_secret,
            &binding.source_id,
            &revision,
            "skill",
            &skill.canonical_path,
        );
        let candidate = SkillInstallCandidate {
            kind: "skill",
            id: id.clone(),
            name: skill.name.clone(),
            description: skill.description.clone(),
            display_canonical_path: canonicalize_existing(&skill.skill_dir)
                .to_string_lossy()
                .into_owned(),
        };
        if parts.is_empty() {
            tree.push(SkillTreeNode::Candidate(candidate));
        } else {
            let group = ensure_group(
                &parts,
                &mut groups,
                &mut tree,
                &context.install_secret,
                &binding.source_id,
                &revision,
            );
            if let Some(SkillTreeNode::Group(group_node)) = tree
                .iter_mut()
                .find(|n| matches!(n, SkillTreeNode::Group(g) if g.id == group.id))
            {
                group_node
                    .children
                    .push(SkillTreeNode::Candidate(candidate));
            }
        }
        default_selection.push(InstallCandidateSelection {
            kind: "skill".into(),
            id,
        });
    }
    SkillInstallScan {
        source_id: binding.source_id.clone(),
        display_canonical_source_path: canonical_str,
        scan_revision: revision,
        tree,
        default_selection,
        diagnostics,
    }
}
