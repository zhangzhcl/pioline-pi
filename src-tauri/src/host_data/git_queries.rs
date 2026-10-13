use std::path::Path;
use std::process::Command;

use serde::Serialize;

use super::files::safe_join;
use super::{HostDataError, HostDataPlane};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub git_branch: Option<String>,
    /// Whether the workspace root is inside a git work tree.
    pub is_git: bool,
    /// Top-level directory name of the git repository (e.g. "picot").
    pub repository: String,
    /// Current branch name (empty string in detached HEAD).
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub is_git_repository: bool,
    pub files: Vec<GitFileStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatResult {
    pub is_git_repository: bool,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub supported: bool,
    pub status: Option<String>,
    pub patch: Option<String>,
}

/// Parse a number from `git diff --shortstat` output for a given keyword.
/// e.g. `parse_shortstat_num("3 files changed, 10 insertions(+)", "insertion")` -> 10
fn parse_shortstat_num(line: &str, keyword: &str) -> u32 {
    line.split(',')
        .find_map(|part| {
            let part = part.trim();
            if part.contains(keyword) {
                part.split_whitespace().next().and_then(|n| n.parse().ok())
            } else {
                None
            }
        })
        .unwrap_or(0)
}

fn classify_git_status(x: char, y: char) -> (&'static str, &'static str) {
    if matches!((x, y), ('D', 'D') | ('A', 'A')) || x == 'U' || y == 'U' {
        ("conflict", "C")
    } else if x == '?' && y == '?' {
        ("untracked", "U")
    } else if x == 'D' || y == 'D' {
        ("deleted", "D")
    } else if x == 'R' || y == 'R' {
        ("renamed", "R")
    } else if x == 'A' || y == 'A' {
        ("added", "A")
    } else {
        ("modified", "M")
    }
}

/// Git is optional. Spawn failures (missing binary, stripped GUI PATH) must
/// not become host I/O errors — Picot should keep running without git.
pub(crate) fn git_output(mut command: Command) -> Option<std::process::Output> {
    command.output().ok()
}

fn git_command_at(root: &Path) -> Command {
    let mut command = Command::new("git");
    crate::windows_child::hide_console(&mut command);
    command
        .current_dir(root)
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0");
    command
}

fn git_at(root: &Path, args: &[&str]) -> Option<std::process::Output> {
    let mut command = git_command_at(root);
    command.args(args);
    git_output(command)
}

fn empty_git_status() -> GitStatusResult {
    GitStatusResult {
        is_git_repository: false,
        files: vec![],
    }
}

fn empty_git_stat() -> GitStatResult {
    GitStatResult {
        is_git_repository: false,
        files_changed: 0,
        insertions: 0,
        deletions: 0,
    }
}

fn empty_workspace_git(path: String) -> WorkspaceInfo {
    WorkspaceInfo {
        path,
        git_branch: None,
        is_git: false,
        repository: String::new(),
        branch: String::new(),
    }
}

impl HostDataPlane {
    pub fn git_status(&self, workspace_id: &str) -> Result<GitStatusResult, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        let Some(output) = git_at(
            &root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        ) else {
            return Ok(empty_git_status());
        };
        if !output.status.success() {
            return Ok(empty_git_status());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let records: Vec<&str> = text.split('\0').collect();
        let mut files = Vec::new();
        let mut index = 0;
        while index < records.len() {
            let record = records[index];
            index += 1;
            if record.len() < 4 {
                continue;
            }
            let bytes = record.as_bytes();
            let x = bytes[0] as char;
            let y = bytes[1] as char;
            let path = record[3..].to_owned();
            let original_path = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
                let original = records
                    .get(index)
                    .filter(|value| !value.is_empty())
                    .map(|value| (*value).to_owned());
                if original.is_some() {
                    index += 1;
                }
                original
            } else {
                None
            };
            let (status, code) = classify_git_status(x, y);
            files.push(GitFileStatus {
                path,
                original_path,
                status: status.into(),
                code: code.into(),
            });
        }
        Ok(GitStatusResult {
            is_git_repository: true,
            files,
        })
    }

    pub fn git_file_diff(
        &self,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<GitDiffResult, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        let _ = safe_join(&root, relative_path)?;
        let status = self
            .git_status(workspace_id)?
            .files
            .into_iter()
            .find(|file| file.path == relative_path);
        let Some(file) = status else {
            return Ok(GitDiffResult {
                supported: false,
                status: None,
                patch: None,
            });
        };
        let mut command = git_command_at(&root);
        if file.status == "untracked" {
            let absolute = safe_join(&root, relative_path)?;
            command
                .args([
                    "diff",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-index",
                    "/dev/null",
                ])
                .arg(absolute);
        } else {
            command.args([
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--unified=3",
                "HEAD",
                "--",
            ]);
            if let Some(original) = &file.original_path {
                command.arg(original);
            }
            command.arg(relative_path);
        }
        let Some(output) = git_output(command) else {
            return Ok(GitDiffResult {
                supported: false,
                status: None,
                patch: None,
            });
        };
        // git diff --no-index reports differences with exit status 1.
        if !output.status.success() && output.status.code() != Some(1) {
            return Ok(GitDiffResult {
                supported: false,
                status: None,
                patch: None,
            });
        }
        let patch = String::from_utf8_lossy(&output.stdout).into_owned();
        let supported = patch.contains("\n@@ ");
        Ok(GitDiffResult {
            supported,
            status: Some(file.status),
            patch: supported.then_some(patch),
        })
    }

    pub fn git_stat(&self, workspace_id: &str) -> Result<GitStatResult, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        // Check if this is a git repo first
        let Some(check) = git_at(&root, &["rev-parse", "--is-inside-work-tree"]) else {
            return Ok(empty_git_stat());
        };
        if !check.status.success() {
            return Ok(empty_git_stat());
        }
        // git diff --shortstat HEAD gives: " N files changed, X insertions(+), Y deletions(-)"
        // If HEAD doesn't exist (initial commit), fall back to diffing against empty tree
        let Some(output) = git_at(&root, &["diff", "--shortstat", "HEAD"]) else {
            return Ok(empty_git_stat());
        };
        let line = String::from_utf8_lossy(&output.stdout);
        let line = line.trim();
        // Parse: "3 files changed, 10 insertions(+), 2 deletions(-)"
        let files_changed = parse_shortstat_num(line, "file");
        let insertions = parse_shortstat_num(line, "insertion");
        let deletions = parse_shortstat_num(line, "deletion");
        Ok(GitStatResult {
            is_git_repository: true,
            files_changed,
            insertions,
            deletions,
        })
    }

    /// Return the workspace path and its current git metadata (repository
    /// name + branch) for the sidebar hover quick-info card. The JSON shape
    /// (`{ isGit, repository, branch, path, gitBranch }`) matches the
    /// `/api/workspace-info` contract consumed by `WorkspaceQuickInfo`.
    pub fn workspace_info(&self, workspace_id: &str) -> Result<WorkspaceInfo, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        Ok(Self::workspace_info_from_root(&root))
    }

    /// Variant that accepts an on-disk workspace path directly (used by
    /// the sidebar which only knows the projectPath, not the internal
    /// workspace ID). The path is canonicalized before running git.
    pub fn workspace_info_by_path(
        &self,
        workspace_path: &str,
    ) -> Result<WorkspaceInfo, HostDataError> {
        let root =
            std::fs::canonicalize(workspace_path).map_err(|e| HostDataError::Io(e.to_string()))?;
        Ok(Self::workspace_info_from_root(&root))
    }

    fn workspace_info_from_root(root: &std::path::Path) -> WorkspaceInfo {
        let path = root.to_string_lossy().into_owned();
        let Some(rev_parse) = git_at(
            root,
            &["rev-parse", "--is-inside-work-tree", "--show-toplevel"],
        ) else {
            return empty_workspace_git(path);
        };
        if !rev_parse.status.success() {
            return empty_workspace_git(path);
        }
        let rev_parse_out = String::from_utf8_lossy(&rev_parse.stdout);
        let mut lines = rev_parse_out.lines();
        if lines.next().map(str::trim) != Some("true") {
            return empty_workspace_git(path);
        }
        // Repository name = top-level directory name of the worktree root.
        let repo_path = lines.next().map(str::trim).unwrap_or("");
        if repo_path.is_empty() {
            return empty_workspace_git(path);
        }
        let repository = std::path::Path::new(repo_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        // Branch name (None in detached HEAD for git_branch, empty string for branch).
        let branch_out = git_at(root, &["rev-parse", "--abbrev-ref", "HEAD"])
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty() && s != "HEAD");
        let branch = branch_out.clone().unwrap_or_default();
        WorkspaceInfo {
            path,
            git_branch: branch_out,
            is_git: true,
            repository,
            branch,
        }
    }
}
