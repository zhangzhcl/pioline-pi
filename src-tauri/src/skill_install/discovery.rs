// ABOUTME: SKILL.md frontmatter parsing, ignore-file matching, path canonicalization,
// ABOUTME: and recursive skill discovery from a source directory.

use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::SkillDiagnostic;

type HmacSha256 = Hmac<Sha256>;

const IGNORE_FILE_NAMES: &[&str] = &[".gitignore", ".ignore", ".fdignore"];
const MAX_NAME_LENGTH: usize = 64;
const MAX_DESCRIPTION_LENGTH: usize = 1024;

#[derive(Clone, Debug)]
pub(super) struct DiscoveredSkill {
    pub(super) canonical_path: String,
    pub(super) file_path: PathBuf,
    pub(super) skill_dir: PathBuf,
    pub(super) name: String,
    pub(super) description: String,
}

#[derive(Clone, Debug)]
struct ParsedFrontmatter {
    name: Option<String>,
    description: Option<String>,
}

// ── Path helpers ──────────────────────────────────────────────────────

pub(super) fn to_posix(p: &str) -> String {
    p.replace(std::path::MAIN_SEPARATOR, "/")
}

pub(super) fn canonicalize_existing(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

// ── Length-delimited hashing (matches the TS lengthDelimited helper) ──

pub(super) fn length_delimited_hash(hasher: &mut Sha256, part: &str) {
    let bytes = part.as_bytes();
    hasher.update((bytes.len() as u32).to_be_bytes());
    hasher.update(bytes);
}

fn length_delimited_hmac(mac: &mut HmacSha256, part: &str) {
    let bytes = part.as_bytes();
    mac.update(&(bytes.len() as u32).to_be_bytes());
    mac.update(bytes);
}

pub(super) fn opaque_id(
    key: &str,
    source_id: &str,
    revision: &str,
    kind: &str,
    path: &str,
) -> String {
    let mut mac = HmacSha256::new_from_slice(key.as_bytes()).expect("HMAC key length");
    length_delimited_hmac(&mut mac, source_id);
    length_delimited_hmac(&mut mac, revision);
    length_delimited_hmac(&mut mac, kind);
    length_delimited_hmac(&mut mac, path);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

// ── Frontmatter parsing (minimal YAML subset for SKILL.md) ────────────

fn parse_frontmatter(content: &str) -> ParsedFrontmatter {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    if !normalized.starts_with("---") {
        return ParsedFrontmatter {
            name: None,
            description: None,
        };
    }
    let Some(rest) = normalized.get(3..) else {
        return ParsedFrontmatter {
            name: None,
            description: None,
        };
    };
    let end_marker = "\n---";
    let Some(end_index) = rest.find(end_marker) else {
        return ParsedFrontmatter {
            name: None,
            description: None,
        };
    };
    // Skip the leading newline after the opening --- line.
    let yaml_text = if rest.starts_with('\n') {
        &rest[1..end_index]
    } else {
        &rest[..end_index]
    };
    parse_yaml_frontmatter(yaml_text)
}

/// Parse only the `name` and `description` keys from a minimal YAML subset.
/// Full YAML is not needed; the TS original uses the `yaml` crate, but these
/// scalars cover the SKILL.md frontmatter fields used during installation scan.
fn parse_yaml_frontmatter(text: &str) -> ParsedFrontmatter {
    let mut name = None;
    let mut description = None;
    for line in text.lines() {
        let trimmed = line.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        // Strip surrounding quotes if present.
        let unquoted = if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            &value[1..value.len() - 1]
        } else {
            value
        };
        match key {
            "name" if !unquoted.is_empty() => name = Some(unquoted.to_string()),
            "description" if !unquoted.is_empty() => description = Some(unquoted.to_string()),
            _ => {}
        }
    }
    ParsedFrontmatter { name, description }
}

fn validate_skill_name(name: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if name.chars().count() > MAX_NAME_LENGTH {
        errors.push(format!(
            "name exceeds {} characters ({})",
            MAX_NAME_LENGTH,
            name.chars().count()
        ));
    }
    let valid = name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        errors
            .push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens)".into());
    }
    if name.starts_with('-') || name.ends_with('-') {
        errors.push("name must not start or end with a hyphen".into());
    }
    if name.contains("--") {
        errors.push("name must not contain consecutive hyphens".into());
    }
    errors
}

// ── Ignore-file matching (gitignore subset) ───────────────────────────

#[derive(Clone, Debug)]
struct IgnorePattern {
    negated: bool,
    pattern: String,
    dir_only: bool,
}

impl IgnorePattern {
    fn matches(&self, rel_posix: &str, is_dir: bool) -> bool {
        if self.dir_only && !is_dir {
            return false;
        }
        let target = if self.dir_only {
            rel_posix.trim_end_matches('/')
        } else {
            rel_posix
        };
        if target == self.pattern {
            return true;
        }
        if !self.pattern.contains('/') && target.rsplit('/').next() == Some(self.pattern.as_str()) {
            return true;
        }
        if target.ends_with(&format!("/{}", self.pattern)) {
            return true;
        }
        false
    }
}

struct IgnoreMatcher {
    patterns: Vec<IgnorePattern>,
}

impl IgnoreMatcher {
    fn build(root: &Path) -> Self {
        let mut patterns = Vec::new();
        Self::walk(root, root, &mut patterns);
        IgnoreMatcher { patterns }
    }

    fn walk(dir: &Path, root: &Path, out: &mut Vec<IgnorePattern>) {
        let rel_dir = dir.strip_prefix(root).unwrap_or_else(|_| Path::new(""));
        let prefix = if rel_dir.as_os_str().is_empty() {
            String::new()
        } else {
            format!("{}/", to_posix(&rel_dir.to_string_lossy()))
        };
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for name in IGNORE_FILE_NAMES {
            let p = dir.join(name);
            if !p.exists() {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&p) {
                for line in text.lines() {
                    if let Some(pat) = Self::parse_line(line, &prefix) {
                        out.push(pat);
                    }
                }
            }
        }
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            let full = entry.path();
            if full.is_dir() {
                Self::walk(&full, root, out);
            }
        }
    }

    fn parse_line(line: &str, prefix: &str) -> Option<IgnorePattern> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }
        if trimmed.starts_with('#') && !trimmed.starts_with("\\#") {
            return None;
        }
        let mut pattern = line.to_string();
        let mut negated = false;
        if let Some(stripped) = pattern.strip_prefix('!') {
            negated = true;
            pattern = stripped.to_string();
        } else if let Some(stripped) = pattern.strip_prefix("\\!") {
            pattern = stripped.to_string();
        }
        if let Some(stripped) = pattern.strip_prefix('/') {
            pattern = stripped.to_string();
        }
        let dir_only = pattern.ends_with('/');
        if dir_only {
            pattern.pop();
        }
        if pattern.is_empty() {
            return None;
        }
        let full = format!("{prefix}{pattern}");
        Some(IgnorePattern {
            negated,
            pattern: full,
            dir_only,
        })
    }

    fn ignores(&self, rel_posix: &str, is_dir: bool) -> bool {
        let mut ignored = false;
        for pat in &self.patterns {
            if pat.matches(rel_posix, is_dir) {
                ignored = !pat.negated;
            }
        }
        ignored
    }
}

// ── Skill discovery (mirrors discoverSkillsFromRoot) ──────────────────

fn push_skill(
    file_path: &Path,
    diagnostics: &mut Vec<SkillDiagnostic>,
    out: &mut Vec<DiscoveredSkill>,
) {
    let canonical = canonicalize_existing(file_path);
    let raw = match fs::read_to_string(file_path) {
        Ok(text) => text,
        Err(error) => {
            diagnostics.push(SkillDiagnostic {
                path: Some(file_path.to_string_lossy().into_owned()),
                message: error.to_string(),
            });
            return;
        }
    };
    let frontmatter = parse_frontmatter(&raw);
    let skill_dir = file_path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .to_path_buf();
    let description = frontmatter
        .description
        .unwrap_or_default()
        .trim()
        .to_string();
    let name = frontmatter.name.unwrap_or_else(|| {
        skill_dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    if description.is_empty() {
        diagnostics.push(SkillDiagnostic {
            path: Some(file_path.to_string_lossy().into_owned()),
            message: "description is required".into(),
        });
        return;
    }
    if description.chars().count() > MAX_DESCRIPTION_LENGTH {
        diagnostics.push(SkillDiagnostic {
            path: Some(file_path.to_string_lossy().into_owned()),
            message: format!("description exceeds {MAX_DESCRIPTION_LENGTH} characters"),
        });
    }
    for err in validate_skill_name(&name) {
        diagnostics.push(SkillDiagnostic {
            path: Some(file_path.to_string_lossy().into_owned()),
            message: err,
        });
    }
    out.push(DiscoveredSkill {
        canonical_path: canonical.to_string_lossy().into_owned(),
        file_path: file_path.to_path_buf(),
        skill_dir,
        name,
        description,
    });
}

pub(super) fn discover_skills_from_root(
    root: &Path,
    diagnostics: &mut Vec<SkillDiagnostic>,
) -> Vec<DiscoveredSkill> {
    if !root.exists() {
        return Vec::new();
    }
    let mut out = Vec::new();
    // A configured plain entry may point at a single skill file.
    if root.is_file() {
        if root.extension().and_then(|e| e.to_str()) != Some("md") {
            diagnostics.push(SkillDiagnostic {
                path: Some(root.to_string_lossy().into_owned()),
                message: "configured skill file must be Markdown".into(),
            });
            return out;
        }
        push_skill(root, diagnostics, &mut out);
        return out;
    }
    let matcher = IgnoreMatcher::build(root);
    fn collect(
        dir: &Path,
        root: &Path,
        matcher: &IgnoreMatcher,
        diagnostics: &mut Vec<SkillDiagnostic>,
        out: &mut Vec<DiscoveredSkill>,
    ) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let names: Vec<_> = entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        // SKILL.md in this dir -> one skill, stop recursion under it.
        if names.iter().any(|n| n == "SKILL.md") {
            let full = dir.join("SKILL.md");
            if full.is_file() {
                let rel = to_posix(&full.strip_prefix(root).unwrap_or(&full).to_string_lossy());
                if !matcher.ignores(&rel, false) {
                    push_skill(&full, diagnostics, out);
                }
            }
            return;
        }
        for name in &names {
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            let full = dir.join(name);
            let Ok(meta) = fs::metadata(&full) else {
                continue;
            };
            let rel = to_posix(&full.strip_prefix(root).unwrap_or(&full).to_string_lossy());
            if meta.is_dir() && !matcher.ignores(&format!("{rel}/"), true) {
                collect(&full, root, matcher, diagnostics, out);
            }
        }
    }
    collect(root, root, &matcher, diagnostics, &mut out);
    dedupe_by_canonical(&mut out)
}

fn dedupe_by_canonical(skills: &mut Vec<DiscoveredSkill>) -> Vec<DiscoveredSkill> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for s in skills.drain(..) {
        if seen.insert(s.canonical_path.clone()) {
            out.push(s);
        }
    }
    out
}
