// ABOUTME: Executes owner-scoped Git status and diff reads against host-derived workspaces.
// ABOUTME: Snapshot records bind raw paths to a generation so browser data cannot authorize Git access.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod commit;
mod history;
mod porcelain;
mod process;
mod status_write;
#[cfg(test)]
mod tests_commit;
#[cfg(test)]
mod tests_history;
#[cfg(test)]
mod tests_status_write;

pub use process::is_git_unavailable;

pub const MAX_STATUS_ENTRIES: usize = 1_200;
pub const GIT_NOT_FOUND: &str = "git_not_found";
pub const PUSH_DETACHED_HEAD: &str = "push_detached_head";
pub const PUSH_NO_REMOTE: &str = "push_no_remote";
pub const MAX_LOG_LIMIT: usize = 200;
pub const MAX_LOG_FILES: usize = 2_000;
pub const MAX_LOG_MESSAGE_BYTES: usize = 32 * 1024;
pub const MAX_LOG_FILES_BYTES: usize = 256 * 1024;

pub(crate) static NEXT_SNAPSHOT_ID: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(1);
pub(crate) const SNAPSHOT_TTL: Duration = Duration::from_secs(300);
pub(crate) const MAX_SNAPSHOTS_PER_OWNER: usize = 8;
pub(crate) const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const COMMIT_DEADLINE: Duration = Duration::from_secs(300);
pub(crate) const PUSH_DEADLINE: Duration = Duration::from_secs(120);
pub(crate) const MAX_PUSH_OUTPUT_BYTES: usize = 4 * 1024;
pub(crate) const OUTCOME_TTL: Duration = Duration::from_secs(600);
pub(crate) const MAX_STDOUT_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_STDERR_BYTES: usize = 64 * 1024;
pub(crate) const GIT_READ_DEADLINE: Duration = Duration::from_secs(10);
pub(crate) const GIT_WRITE_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSnapshot {
    pub snapshot_id: String,
    pub head_state: String,
    pub head_oid: Option<String>,
    pub index_tree_oid: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub change_stats: GitChangeStats,
    pub counts: GitCounts,
    pub entries: Vec<GitStatusEntry>,
    pub returned_entry_count: usize,
    pub total_entry_count: usize,
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitCounts {
    pub staged: usize,
    pub changes: usize,
    pub untracked: usize,
    pub conflicted: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitChangeStats {
    pub basis: String,
    pub additions: u64,
    pub deletions: u64,
    pub untracked_excluded_count: usize,
    pub binary_file_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub record_type: String,
    pub xy: Option<String>,
    pub entry_kind: String,
    pub display_path: String,
    pub path_bytes_base64: String,
    pub original_display_path: Option<String>,
    pub original_path_bytes_base64: Option<String>,
    pub submodule: Option<String>,
    pub unmerged_modes: Option<Vec<String>>,
    pub unmerged_object_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResponse {
    pub snapshot_id: String,
    pub comparison: String,
    pub path_bytes_base64: String,
    pub raw_patch: String,
    pub truncated: bool,
    pub fallback_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitPushOutcome {
    pub remote: String,
    pub branch: String,
    pub set_upstream: bool,
    pub output: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitAiSnapshot {
    pub snapshot_id: String,
    pub head_state: String,
    pub head_oid: Option<String>,
    pub index_tree_oid: Option<String>,
    pub staged_diff: String,
    pub staged_diff_truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedStatus {
    pub entries: Vec<GitStatusEntry>,
    pub counts: GitCounts,
    pub total_entry_count: usize,
    pub truncated: bool,
    pub head_state: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitPathIdentity {
    pub group: String,
    pub path_bytes: Vec<u8>,
    pub original_path_bytes: Option<Vec<u8>>,
}

#[derive(Clone, Debug)]
pub(crate) struct SnapshotRecord {
    pub(crate) owner: String,
    pub(crate) root: PathBuf,
    pub(crate) generation: u64,
    pub(crate) created: Instant,
    pub(crate) entries: Vec<GitStatusEntry>,
    pub(crate) head_oid: Option<String>,
    pub(crate) index_tree_oid: Option<String>,
    pub(crate) partial_stage_token: Option<String>,
    pub(crate) partial_stage_token_created: Option<Instant>,
}

#[derive(Clone, Default)]
pub struct GitService {
    pub(crate) snapshots: Arc<Mutex<HashMap<String, SnapshotRecord>>>,
    pub(crate) write_slots: Arc<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>>,
    pub(crate) outcomes: Arc<Mutex<HashMap<String, PendingGitOutcome>>>,
    pub(crate) revoked_owners: Arc<Mutex<std::collections::HashSet<String>>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingGitOutcome {
    pub owner: String,
    pub root: String,
    pub generation: u64,
    pub request_id: String,
    pub status: String,
    pub commit_oid: Option<String>,
    pub hook_changed_tree: bool,
    pub error: Option<String>,
    #[serde(skip)]
    pub created: Option<Instant>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDiffResponse {
    pub comparison: String,
    pub path_bytes_base64: String,
    pub raw_patch: String,
    pub truncated: bool,
    pub fallback_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitNameStatusFile {
    pub status: String,
    pub path: String,
    pub path_bytes: Vec<u8>,
    pub original_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub oid: String,
    pub subject: String,
    pub author_name: String,
    pub author_time: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLogResponse {
    pub commits: Vec<GitLogEntry>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLogDetailFile {
    pub status: String,
    pub path: String,
    pub path_bytes_base64: String,
    pub original_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLogDetailResponse {
    pub oid: String,
    pub author_name: String,
    pub author_time: i64,
    pub full_message: String,
    pub message_truncated: bool,
    pub files_truncated: bool,
    pub files: Vec<GitLogDetailFile>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitKind {
    Root,
    Linear,
    Merge,
}

#[derive(Clone, Copy)]
pub struct GitDiffRequest<'a> {
    pub snapshot_id: &'a str,
    pub owner: &'a str,
    pub root: &'a Path,
    pub generation: u64,
    pub group: &'a str,
    pub path_bytes: &'a [u8],
    pub comparison: &'a str,
}

pub struct GitDetachedCommit {
    pub snapshot_id: String,
    pub owner: String,
    pub root: PathBuf,
    pub generation: u64,
    pub request_id: String,
    pub message: String,
    pub notify: Option<Box<dyn FnOnce(String) + Send>>,
}
