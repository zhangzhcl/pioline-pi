// ABOUTME: Pi package listing, installation, settings toggling, and manifest resource inspection.

use super::PiLaunchResolver;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// A single configured pi package source with its resolved install path.
/// `scope` is "global" (user) or "project" (local to a workspace).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PiPackageInfo {
    pub source: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_path: Option<String>,
    /// True when the package entry is disabled (object form with all-empty resource arrays).
    pub disabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Number of resolved extensions/skills/prompts/themes contributed by this
    /// package (read from its `pi` manifest or conventional dirs when installed).
    #[serde(skip_serializing_if = "PackageResourceCounts::is_zero")]
    pub counts: PackageResourceCounts,
    /// The individual resolved resources (entry file per extension/skill/prompt/theme).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub resources: Vec<ResourceEntry>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PackageResourceCounts {
    pub extensions: usize,
    pub skills: usize,
    pub prompts: usize,
    pub themes: usize,
}

impl PackageResourceCounts {
    pub(crate) fn is_zero(&self) -> bool {
        self.extensions == 0 && self.skills == 0 && self.prompts == 0 && self.themes == 0
    }

    pub(crate) fn from_resources(resources: &[ResourceEntry]) -> Self {
        let mut counts = PackageResourceCounts::default();
        for entry in resources {
            match entry.kind.as_str() {
                "extension" => counts.extensions += 1,
                "skill" => counts.skills += 1,
                "prompt" => counts.prompts += 1,
                "theme" => counts.themes += 1,
                _ => {}
            }
        }
        counts
    }
}

/// A single resolved resource contributed by an installed package — one entry
/// per extension/skill/prompt/theme, with the file (or skill dir) it resolves to.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEntry {
    pub kind: String,
    pub name: String,
    pub relative_path: String,
}

impl PiLaunchResolver {
    /// Parse `pi list` output into a list of configured packages with their
    /// resolved install paths and scope.
    pub fn list_pi_packages(&self) -> Result<Vec<PiPackageInfo>, String> {
        let output = self.run_pi_command(&["list"])?;
        let mut packages: Vec<PiPackageInfo> = Vec::new();
        let mut scope = "global";
        for line in output.lines() {
            let leading = line.len() - line.trim_start().len();
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("No packages installed.") {
                continue;
            }
            if trimmed.ends_with(':') {
                let lower = trimmed.to_ascii_lowercase();
                if lower.starts_with("project") {
                    scope = "project";
                } else if lower.starts_with("user") || lower.starts_with("global") {
                    scope = "global";
                }
                continue;
            }
            if leading >= 4 && !packages.is_empty() {
                let value = trimmed.strip_prefix('-').map_or(trimmed, str::trim);
                if !value.is_empty() && packages.last().unwrap().installed_path.is_none() {
                    packages.last_mut().unwrap().installed_path = Some(value.to_string());
                }
                continue;
            }
            let source = trimmed.strip_prefix('-').map_or(trimmed, str::trim);
            if source.is_empty() {
                continue;
            }
            packages.push(PiPackageInfo {
                source: source.to_string(),
                scope: scope.to_string(),
                installed_path: None,
                disabled: false,
                package_name: None,
                version: None,
                description: None,
                counts: PackageResourceCounts::default(),
                resources: Vec::new(),
            });
        }
        for pkg in &mut packages {
            if let Some(path) = pkg.installed_path.as_deref() {
                let metadata = read_package_metadata(path);
                pkg.package_name = metadata.name;
                pkg.version = metadata.version;
                pkg.description = metadata.description;
                pkg.resources = read_package_resources(path);
                pkg.counts = PackageResourceCounts::from_resources(&pkg.resources);
            }
        }
        Ok(packages)
    }

    pub fn install_pi_package(&self, source: &str, local: bool) -> Result<(), String> {
        if local {
            self.run_pi_command(&["install", source, "-l"]).map(|_| ())
        } else {
            self.run_pi_command(&["install", source]).map(|_| ())
        }
    }

    pub fn remove_pi_package(&self, source: &str, local: bool) -> Result<(), String> {
        if local {
            self.run_pi_command(&["remove", source, "-l"]).map(|_| ())
        } else {
            self.run_pi_command(&["remove", source]).map(|_| ())
        }
    }

    /// Update a single installed package (or pi itself when `source` is empty).
    pub fn update_pi_package(&self, source: &str) -> Result<(), String> {
        let source = source.trim();
        if source.is_empty() {
            self.run_pi_command(&["update", "--extensions"]).map(|_| ())
        } else {
            self.run_pi_command(&["update", source]).map(|_| ())
        }
    }
}

/// Locate the settings.json file for a given scope. Global is
/// `~/.pi/agent/settings.json`; project is `<cwd>/.pi/settings.json`.
pub fn settings_path(scope: &str, cwd: &str) -> Result<PathBuf, String> {
    if scope == "project" {
        let cwd = cwd.trim_end_matches('/');
        let cwd = Path::new(cwd);
        let path = cwd.join(".pi").join("settings.json");
        if !cwd.is_dir() {
            return Err(format!(
                "Workspace directory does not exist: {}",
                cwd.display()
            ));
        }
        Ok(path)
    } else {
        let agent_dir = crate::pi_agent_dir::agent_dir()
            .ok_or_else(|| "Could not resolve Pi agent directory".to_string())?;
        Ok(agent_dir.join("settings.json"))
    }
}

fn read_packages(
    path: &Path,
) -> Result<
    (
        serde_json::Map<String, serde_json::Value>,
        Vec<serde_json::Value>,
    ),
    String,
> {
    let root: serde_json::Map<String, serde_json::Value> = if path.exists() {
        serde_json::from_str(
            &std::fs::read_to_string(path)
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))?,
        )
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?
    } else {
        serde_json::Map::new()
    };
    let packages = root
        .get("packages")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok((root, packages))
}

fn write_settings(
    path: &Path,
    root: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let mut json = serde_json::to_string_pretty(root)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    json.push('\n');
    std::fs::write(path, json).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

fn entry_source(entry: &serde_json::Value) -> Option<String> {
    match entry {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(obj) => obj
            .get("source")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        _ => None,
    }
}

fn resourced_entry(source: &str) -> serde_json::Value {
    serde_json::json!({
        "source": source,
        "extensions": [],
        "skills": [],
        "prompts": [],
        "themes": []
    })
}

fn is_disabled_entry(entry: &serde_json::Value) -> bool {
    let serde_json::Value::Object(obj) = entry else {
        return false;
    };
    ["extensions", "skills", "prompts", "themes"]
        .iter()
        .all(|key| {
            obj.get(*key)
                .and_then(serde_json::Value::as_array)
                .is_some_and(Vec::is_empty)
        })
}

/// Set a configured package's disabled state by editing the `packages` array
/// in the settings file for the given scope. Returns true when a change was made.
pub fn set_package_disabled(
    scope: &str,
    cwd: &str,
    source: &str,
    disabled: bool,
) -> Result<bool, String> {
    let path = settings_path(scope, cwd)?;
    let (mut root, packages) = read_packages(&path)?;
    let source = source.trim();
    let index = packages
        .iter()
        .position(|entry| entry_source(entry).as_deref() == Some(source));
    let Some(index) = index else {
        return Err(format!("Package not configured: {source}"));
    };
    if packages[index] == serde_json::Value::String(source.to_string()) && !disabled {
        return Ok(false);
    }
    let mut next = packages;
    if disabled {
        next[index] = resourced_entry(source);
    } else if is_disabled_entry(&next[index]) {
        next[index] = serde_json::Value::String(source.to_string());
    } else {
        return Ok(false);
    }
    root.insert("packages".to_string(), serde_json::Value::Array(next));
    write_settings(&path, &root)?;
    Ok(true)
}

pub struct PackageMetadata {
    pub name: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
}

/// Read package.json metadata from an installed package path.
pub fn read_package_metadata(installed_path: &str) -> PackageMetadata {
    let path = Path::new(installed_path);
    let package_json = if path.is_dir() {
        path.join("package.json")
    } else {
        path.parent().unwrap_or(path).join("package.json")
    };
    let empty = || PackageMetadata {
        name: None,
        version: None,
        description: None,
    };
    let Ok(contents) = std::fs::read_to_string(&package_json) else {
        return empty();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return empty();
    };
    let name = parsed
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let version = parsed
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let description = parsed
        .get("description")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    PackageMetadata {
        name,
        version,
        description,
    }
}

fn resource_name(relative_path: &str) -> String {
    Path::new(relative_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(relative_path)
        .to_string()
}

fn dir_file_resources(
    dir: &Path,
    dir_name: &str,
    kind: &str,
    extensions: &[&str],
) -> Vec<ResourceEntry> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut resources: Vec<ResourceEntry> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str())?;
            if !extensions.contains(&ext) {
                return None;
            }
            let file_name = path.file_name()?.to_str()?.to_string();
            Some(ResourceEntry {
                kind: kind.to_string(),
                name: resource_name(&file_name),
                relative_path: format!("{dir_name}/{file_name}"),
            })
        })
        .collect();
    resources.sort_by(|a, b| a.name.cmp(&b.name));
    resources
}

fn skill_resources(skills_dir: &Path) -> Vec<ResourceEntry> {
    let Ok(entries) = std::fs::read_dir(skills_dir) else {
        return Vec::new();
    };
    let mut resources = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("SKILL.md").is_file() {
            let Some(dir_name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            resources.push(ResourceEntry {
                kind: "skill".to_string(),
                name: dir_name.to_string(),
                relative_path: format!("skills/{dir_name}/SKILL.md"),
            });
        } else if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
            let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            resources.push(ResourceEntry {
                kind: "skill".to_string(),
                name: resource_name(file_name),
                relative_path: format!("skills/{file_name}"),
            });
        }
    }
    resources.sort_by(|a, b| a.name.cmp(&b.name));
    resources
}

/// Resolve the individual extensions/skills/prompts/themes a package
/// contributes, used for the management detail view. Reads the package `pi`
/// manifest when present, or falls back to conventional directories.
pub fn read_package_resources(installed_path: &str) -> Vec<ResourceEntry> {
    let path = Path::new(installed_path);
    let root = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent().unwrap_or(path).to_path_buf()
    };

    if let Ok(contents) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&contents) {
            if let Some(manifest) = parsed.get("pi").and_then(serde_json::Value::as_object) {
                let entries_from = |key: &str, kind: &str| -> Vec<ResourceEntry> {
                    manifest
                        .get(key)
                        .and_then(serde_json::Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(serde_json::Value::as_str)
                                .map(|value| ResourceEntry {
                                    kind: kind.to_string(),
                                    name: resource_name(value),
                                    relative_path: value.to_string(),
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                };
                let mut resources = Vec::new();
                resources.extend(entries_from("extensions", "extension"));
                resources.extend(entries_from("skills", "skill"));
                resources.extend(entries_from("prompts", "prompt"));
                resources.extend(entries_from("themes", "theme"));
                if !resources.is_empty() {
                    return resources;
                }
            }
        }
    }

    let mut resources = Vec::new();
    resources.extend(dir_file_resources(
        &root.join("extensions"),
        "extensions",
        "extension",
        &["ts", "js"],
    ));
    resources.extend(skill_resources(&root.join("skills")));
    resources.extend(dir_file_resources(
        &root.join("prompts"),
        "prompts",
        "prompt",
        &["md"],
    ));
    resources.extend(dir_file_resources(
        &root.join("themes"),
        "themes",
        "theme",
        &["json"],
    ));
    resources
}
