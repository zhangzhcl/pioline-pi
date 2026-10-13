use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;

#[path = "host_data/branch_tree.rs"]
pub mod branch_tree;
#[path = "host_data/files.rs"]
pub mod files;
#[path = "host_data/git_queries.rs"]
pub mod git_queries;
#[path = "host_data/sessions.rs"]
pub mod sessions;
#[path = "host_data/transcript_reader.rs"]
pub mod transcript_reader;

pub use branch_tree::{
    read_session_messages_from_path, read_session_tree_from_path, SessionTreeSnapshot,
};
#[cfg(test)]
use files::FileKind;
pub use files::WriteFileResult;
#[cfg(test)]
use git_queries::git_output;
#[cfg(test)]
use sessions::remove_session_file_trash_first_with;
pub use transcript_reader::{
    build_cost_dashboard, metadata_modified_at_ms, parse_session_id, parse_session_metrics,
    parse_session_summary_with_metadata, search_session_file, CostDashboard, SessionMetrics,
    SessionSearchResult, SessionSummary,
};

#[derive(Debug, Clone)]
pub(crate) struct CachedSessionSummary {
    pub(crate) modified_at_ms: u128,
    pub(crate) len: u64,
    pub(crate) summary: Option<SessionSummary>,
}

/// A folder the user opened as a workspace during this app session. Feeds the
/// sidebar's project groups so an opened folder is visible even before any of
/// its chats has produced a session file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredWorkspace {
    pub workspace_id: String,
    pub path: String,
    pub folder_name: String,
    pub is_default_workspace: bool,
}

/// Parsed-metrics cache entry for the cost dashboard scan. Session files
/// are append-only, so an unchanged `(mtime, len)` pair implies an unchanged
/// parse result.
#[derive(Debug, Clone)]
pub(crate) struct CachedMetrics {
    pub(crate) modified: SystemTime,
    pub(crate) len: u64,
    pub(crate) metrics: SessionMetrics,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostDataError {
    UnknownWorkspace,
    InvalidRelativePath,
    OutsideWorkspace,
    NotDirectory,
    NotFile,
    InvalidMentionQuery,
    Io(String),
}

#[derive(Clone, Default)]
pub struct HostDataPlane {
    pub(crate) workspace_roots: Arc<RwLock<HashMap<String, PathBuf>>>,
    pub(crate) session_root: Option<PathBuf>,
    pub(crate) session_summary_cache: Arc<RwLock<HashMap<PathBuf, CachedSessionSummary>>>,
    pub(crate) cost_metrics_cache: Arc<Mutex<HashMap<PathBuf, CachedMetrics>>>,
    pub(crate) session_path_index: Arc<RwLock<HashMap<String, PathBuf>>>,
}

impl HostDataPlane {
    pub fn new(workspace_roots: HashMap<String, PathBuf>) -> Result<Self, HostDataError> {
        let mut canonical = HashMap::new();
        for (workspace_id, root) in workspace_roots {
            let root = root
                .canonicalize()
                .map_err(|error| HostDataError::Io(error.to_string()))?;
            canonical.insert(workspace_id, root);
        }
        Ok(Self {
            workspace_roots: Arc::new(RwLock::new(canonical)),
            session_root: None,
            session_summary_cache: Arc::new(RwLock::new(HashMap::new())),
            cost_metrics_cache: Arc::new(Mutex::new(HashMap::new())),
            session_path_index: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    pub fn with_session_root(mut self, session_root: PathBuf) -> Self {
        self.session_root = Some(session_root);
        self
    }

    /// Register (or update) a workspace root at runtime. Used when the user
    /// opens a new folder as a workspace after startup.
    pub fn register_workspace(&self, workspace_id: &str, root: &Path) -> Result<(), HostDataError> {
        let root = root
            .canonicalize()
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        self.workspace_roots
            .write()
            .map_err(|_| HostDataError::Io("workspace registry poisoned".into()))?
            .insert(workspace_id.to_string(), root);
        Ok(())
    }

    pub(crate) fn workspace_root(&self, workspace_id: &str) -> Result<PathBuf, HostDataError> {
        self.workspace_roots
            .read()
            .map_err(|_| HostDataError::Io("workspace registry poisoned".into()))?
            .get(workspace_id)
            .cloned()
            .ok_or(HostDataError::UnknownWorkspace)
    }

    /// Return the registered filesystem root (working directory) for a
    /// workspace, so a runtime can be lazily resumed with the correct cwd.
    pub fn workspace_root_path(&self, workspace_id: &str) -> Result<PathBuf, HostDataError> {
        self.workspace_root(workspace_id)
    }

    /// The stable workspace id of the always-registered default (home)
    /// workspace.
    pub fn default_workspace_id(&self) -> Option<String> {
        let roots = self.workspace_roots.read().ok()?;
        roots
            .iter()
            .find(|(_, root)| is_home_project_path(root))
            .map(|(workspace_id, _)| workspace_id.clone())
    }

    /// Workspaces registered at runtime (every folder opened as a workspace in
    /// this app session).
    pub fn registered_workspaces(&self) -> Vec<RegisteredWorkspace> {
        let Ok(roots) = self.workspace_roots.read() else {
            return Vec::new();
        };
        let mut workspaces: Vec<RegisteredWorkspace> = roots
            .iter()
            .map(|(workspace_id, root)| RegisteredWorkspace {
                workspace_id: workspace_id.clone(),
                path: root.to_string_lossy().into_owned(),
                folder_name: root.file_name().map_or_else(
                    || root.to_string_lossy().into_owned(),
                    |value| value.to_string_lossy().into_owned(),
                ),
                is_default_workspace: is_home_project_path(root),
            })
            .collect();
        workspaces.sort_by(|a, b| a.path.cmp(&b.path));
        workspaces
    }
}

/// Compare two directories, preferring canonicalized equality but falling back
/// to a raw path comparison when a directory no longer exists on disk.
pub(crate) fn same_dir(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => left == right,
    }
}

/// True when `project_path` is the user's home directory — the default
/// workspace every window opens with, not a project the user chose.
pub(crate) fn is_home_project_path(project_path: &Path) -> bool {
    match dirs::home_dir() {
        Some(home) => same_dir(&home, project_path),
        None => false,
    }
}

/// True when `project_path` lives under Picot's `~/.picot/remotes` anchor root,
/// i.e. it represents a remote host workspace rather than a local project.
pub(crate) fn is_remote_project_path(project_path: &Path) -> bool {
    let Ok(root) = crate::remote_workspace::remotes_root() else {
        return false;
    };
    let root = root.canonicalize().unwrap_or(root);
    project_path.starts_with(&root)
}

#[cfg(test)]
#[path = "host_data/tests.rs"]
mod tests;
