use super::{
    build_cost_dashboard, metadata_modified_at_ms, parse_session_id, parse_session_metrics,
    parse_session_summary_with_metadata, read_session_messages_from_path,
    read_session_tree_from_path, same_dir, search_session_file, CachedMetrics,
    CachedSessionSummary, CostDashboard, HostDataError, HostDataPlane, SessionMetrics,
    SessionSearchResult, SessionSummary, SessionTreeSnapshot,
};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Result of a best-effort batch delete: each requested session id lands in
/// exactly one of `deleted` / `errors` (ids that don't resolve to a session
/// file on disk count as errors too, mirroring "not found").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionsResult {
    pub deleted: Vec<String>,
    pub errors: Vec<String>,
}

/// Remove a session file trash-first: move it to the OS trash via the
/// `trash` CLI when available (matching Pi TUI's deleteSessionFile policy),
/// falling back to a permanent unlink otherwise. A missing `trash` binary
/// (e.g. Windows) simply fails the spawn and falls back to unlink.
pub(crate) fn remove_session_file_trash_first_with(
    path: &std::path::Path,
    spawn_trash: impl Fn(&std::path::Path) -> bool,
) -> std::io::Result<()> {
    // Trash reports success, or the file is already gone — both are success.
    if spawn_trash(path) || !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path)
}

fn remove_session_file_trash_first(path: &std::path::Path) -> std::io::Result<()> {
    remove_session_file_trash_first_with(path, |target| {
        let mut command = std::process::Command::new("trash");
        crate::windows_child::hide_console(&mut command);
        command
            .arg(target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}

fn session_jsonl_paths(session_root: &Path) -> Result<Vec<PathBuf>, HostDataError> {
    let mut paths = Vec::new();
    for project in std::fs::read_dir(session_root)
        .map_err(|error| HostDataError::Io(error.to_string()))?
        .filter_map(Result::ok)
    {
        if !project.file_type().is_ok_and(|ft| ft.is_dir()) {
            continue;
        }
        for file in std::fs::read_dir(project.path())
            .map_err(|error| HostDataError::Io(error.to_string()))?
            .filter_map(Result::ok)
        {
            if !file.file_type().is_ok_and(|ft| ft.is_file()) {
                continue;
            }
            let path = file.path();
            if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
                paths.push(path);
            }
        }
    }
    Ok(paths)
}

impl HostDataPlane {
    /// Resolve the on-disk session file for a saved session that belongs to a
    /// workspace. Used to lazily resume a runtime when a historical session is
    /// opened from the sidebar and no live runtime exists for it yet.
    pub fn resolve_session_path(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<Option<PathBuf>, HostDataError> {
        let workspace = self.workspace_root(workspace_id)?;
        let workspace = workspace.as_path();
        let Some(session_root) = &self.session_root else {
            return Ok(None);
        };
        if !session_root.is_dir() {
            return Ok(None);
        }

        // Fast path: a session id we've already seen (from an earlier scan or
        // lookup) resolves straight to its file, no directory walk needed.
        // Still re-verified against the live summary (cheap: a single stat +
        // cache hit in the common case) since a session file can be deleted
        // or moved between calls.
        if let Some(cached_path) = self.indexed_session_path(session_id)? {
            let hit = matches!(
                self.cached_session_summary(&cached_path),
                Ok(Some(summary))
                    if summary.id == session_id
                        && same_dir(workspace, Path::new(&summary.project_path))
            );
            if hit {
                return Ok(Some(cached_path));
            }
            self.forget_indexed_session_path(session_id);
        }

        for path in session_jsonl_paths(session_root)? {
            let Some(summary) = self.cached_session_summary(&path)? else {
                continue;
            };
            self.remember_indexed_session_path(summary.id.clone(), path.clone());
            if summary.id == session_id && same_dir(workspace, Path::new(&summary.project_path)) {
                return Ok(Some(path));
            }
        }
        Ok(None)
    }

    /// Read session messages directly from the on-disk JSONL file, bypassing
    /// the Pi runtime process. Returns messages in the same format that Pi's
    /// `get_messages` command returns.
    pub fn read_session_messages(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<Vec<serde_json::Value>, HostDataError> {
        let path = self
            .resolve_session_path(workspace_id, session_id)?
            .ok_or_else(|| HostDataError::Io(format!("session {session_id} not found")))?;
        read_session_messages_from_path(&path)
    }

    /// Full session JSONL tree snapshot for the Info panel: every id-carrying
    /// entry verbatim plus the derived active leaf.
    pub fn read_session_tree(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<SessionTreeSnapshot, HostDataError> {
        let path = self
            .resolve_session_path(workspace_id, session_id)?
            .ok_or_else(|| HostDataError::Io(format!("session {session_id} not found")))?;
        read_session_tree_from_path(&path)
    }

    pub fn list_sessions(&self, workspace_id: &str) -> Result<Vec<SessionSummary>, HostDataError> {
        let workspace = self.workspace_root(workspace_id)?;
        let mut sessions = self.collect_sessions(Some(workspace.as_path()))?;
        for session in &mut sessions {
            workspace_id.clone_into(&mut session.workspace_id);
            session.is_current_workspace = true;
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.activity_at_ms));
        Ok(sessions)
    }

    /// List saved sessions across *all* projects, not just the current
    /// workspace, so the sidebar can group them by project.
    pub fn list_all_sessions(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<SessionSummary>, HostDataError> {
        let current = self
            .workspace_root(workspace_id)
            .ok()
            .map(|root| (workspace_id, root));
        self.list_all_sessions_with_current(current)
    }

    /// List saved sessions for the targetless `/app` launcher.
    pub fn list_launcher_sessions(&self) -> Result<Vec<SessionSummary>, HostDataError> {
        self.list_all_sessions_with_current(None)
    }

    fn list_all_sessions_with_current(
        &self,
        current: Option<(&str, PathBuf)>,
    ) -> Result<Vec<SessionSummary>, HostDataError> {
        let mut sessions = self.collect_sessions(None)?;
        if let Some((workspace_id, root)) = current {
            for session in &mut sessions {
                if same_dir(&root, Path::new(&session.project_path)) {
                    workspace_id.clone_into(&mut session.workspace_id);
                    session.is_current_workspace = true;
                }
            }
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.activity_at_ms));
        Ok(sessions)
    }

    /// Permanently delete the on-disk `.jsonl` files for the given session
    /// ids, searching across every project.
    pub fn delete_sessions(
        &self,
        session_ids: &[String],
    ) -> Result<DeleteSessionsResult, HostDataError> {
        let mut result = DeleteSessionsResult::default();
        if session_ids.is_empty() {
            return Ok(result);
        }
        let Some(session_root) = &self.session_root else {
            result.errors = session_ids.to_vec();
            return Ok(result);
        };
        if !session_root.is_dir() {
            result.errors = session_ids.to_vec();
            return Ok(result);
        }
        let requested: HashSet<&str> = session_ids.iter().map(String::as_str).collect();
        let mut deleted = HashSet::new();
        let mut failed = HashSet::new();
        for path in session_jsonl_paths(session_root)? {
            let Some(session_id) = parse_session_id(&path)? else {
                continue;
            };
            if !requested.contains(session_id.as_str()) {
                continue;
            }
            match remove_session_file_trash_first(&path) {
                Ok(()) => {
                    self.forget_indexed_session_path(&session_id);
                    deleted.insert(session_id);
                }
                Err(_) => {
                    failed.insert(session_id);
                }
            }
        }
        for id in session_ids {
            if deleted.contains(id) && !failed.contains(id) {
                result.deleted.push(id.clone());
            } else {
                result.errors.push(id.clone());
            }
        }
        Ok(result)
    }

    fn collect_sessions(
        &self,
        workspace_filter: Option<&Path>,
    ) -> Result<Vec<SessionSummary>, HostDataError> {
        let Some(session_root) = &self.session_root else {
            return Ok(Vec::new());
        };
        if !session_root.is_dir() {
            return Ok(Vec::new());
        }
        let mut sessions = Vec::new();
        for project in std::fs::read_dir(session_root)
            .map_err(|error| HostDataError::Io(error.to_string()))?
            .filter_map(Result::ok)
        {
            if !project.file_type().is_ok_and(|ft| ft.is_dir()) {
                continue;
            }
            let Ok(files) = std::fs::read_dir(project.path()) else {
                continue;
            };
            for file in files.filter_map(Result::ok) {
                let path = file.path();
                let is_regular_file = file.file_type().is_ok_and(|file_type| file_type.is_file());
                if !is_regular_file
                    || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
                {
                    continue;
                }
                let Ok(Some(summary)) = self.cached_session_summary(&path) else {
                    continue;
                };
                self.remember_indexed_session_path(summary.id.clone(), path.clone());
                if let Some(filter) = workspace_filter {
                    if !same_dir(filter, Path::new(&summary.project_path)) {
                        continue;
                    }
                }
                sessions.push(summary);
            }
        }
        Ok(sessions)
    }

    fn indexed_session_path(&self, session_id: &str) -> Result<Option<PathBuf>, HostDataError> {
        Ok(self
            .session_path_index
            .read()
            .map_err(|_| HostDataError::Io("session path index poisoned".into()))?
            .get(session_id)
            .cloned())
    }

    fn remember_indexed_session_path(&self, session_id: String, path: PathBuf) {
        if let Ok(mut index) = self.session_path_index.write() {
            index.insert(session_id, path);
        }
    }

    fn forget_indexed_session_path(&self, session_id: &str) {
        if let Ok(mut index) = self.session_path_index.write() {
            index.remove(session_id);
        }
    }

    fn cached_session_summary(&self, path: &Path) -> Result<Option<SessionSummary>, HostDataError> {
        let metadata =
            std::fs::metadata(path).map_err(|error| HostDataError::Io(error.to_string()))?;
        let modified_at_ms = metadata_modified_at_ms(&metadata);
        let len = metadata.len();
        let cached = self
            .session_summary_cache
            .read()
            .map_err(|_| HostDataError::Io("session summary cache poisoned".into()))?
            .get(path)
            .filter(|cached| cached.modified_at_ms == modified_at_ms && cached.len == len)
            .cloned();
        if let Some(cached) = cached {
            return Ok(cached.summary);
        }

        let summary = parse_session_summary_with_metadata(path, modified_at_ms)?;
        self.session_summary_cache
            .write()
            .map_err(|_| HostDataError::Io("session summary cache poisoned".into()))?
            .insert(
                path.to_path_buf(),
                CachedSessionSummary {
                    modified_at_ms,
                    len,
                    summary: summary.clone(),
                },
            );
        Ok(summary)
    }

    pub fn search_sessions(
        &self,
        workspace_id: &str,
        query: &str,
    ) -> Result<Vec<SessionSearchResult>, HostDataError> {
        const MAX_RESULTS: usize = 30;
        let workspace = self.workspace_root(workspace_id)?;
        let workspace = workspace.as_path();
        let Some(session_root) = &self.session_root else {
            return Ok(Vec::new());
        };
        let query = query.trim().to_lowercase();
        if query.len() < 2 || !session_root.is_dir() {
            return Ok(Vec::new());
        }
        let mut results = Vec::new();
        for path in session_jsonl_paths(session_root)? {
            if results.len() >= MAX_RESULTS {
                return Ok(results);
            }
            if let Some(result) = search_session_file(&path, workspace, &query)? {
                results.push(result);
            }
        }
        Ok(results)
    }

    pub fn cost_dashboard(&self, workspace_id: &str) -> Result<CostDashboard, HostDataError> {
        let _ = self.workspace_root(workspace_id)?;
        let Some(session_root) = &self.session_root else {
            return Ok(CostDashboard::default());
        };
        if !session_root.is_dir() {
            return Ok(CostDashboard::default());
        }
        let metrics = self.scan_cost_metrics(session_root)?;
        Ok(build_cost_dashboard(metrics))
    }

    fn scan_cost_metrics(&self, session_root: &Path) -> Result<Vec<SessionMetrics>, HostDataError> {
        let mut candidates = Vec::new();
        for path in session_jsonl_paths(session_root)? {
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            candidates.push((path, modified, meta.len()));
        }
        let mut metrics_all = Vec::new();
        let mut misses = Vec::new();
        {
            let cache = self
                .cost_metrics_cache
                .lock()
                .map_err(|_| HostDataError::Io("cost metrics cache poisoned".into()))?;
            for (path, modified, len) in &candidates {
                match cache.get(path) {
                    Some(cached) if cached.modified == *modified && cached.len == *len => {
                        metrics_all.push(cached.metrics.clone());
                    }
                    _ => misses.push((path.clone(), *modified, *len)),
                }
            }
        }
        misses.sort_by_key(|&(_, _, len)| std::cmp::Reverse(len));
        let workers = std::thread::available_parallelism()
            .map_or(1, std::num::NonZero::get)
            .clamp(1, 8);
        let chunk_size = misses.len().div_ceil(workers).max(1);
        let mut parsed: Vec<(PathBuf, SystemTime, u64, SessionMetrics)> = Vec::new();
        std::thread::scope(|scope| -> Result<(), HostDataError> {
            let handles: Vec<_> = misses
                .chunks(chunk_size)
                .map(|chunk| {
                    scope.spawn(move || {
                        let mut chunk_metrics = Vec::with_capacity(chunk.len());
                        for (path, modified, len) in chunk {
                            if let Some(metrics) = parse_session_metrics(path, None)? {
                                chunk_metrics.push((path.clone(), *modified, *len, metrics));
                            }
                        }
                        Ok(chunk_metrics)
                    })
                })
                .collect();
            for handle in handles {
                let chunk_metrics = handle
                    .join()
                    .map_err(|_| HostDataError::Io("cost scan worker panicked".into()))??;
                parsed.extend(chunk_metrics);
            }
            Ok(())
        })?;
        if !parsed.is_empty() {
            let mut cache = self
                .cost_metrics_cache
                .lock()
                .map_err(|_| HostDataError::Io("cost metrics cache poisoned".into()))?;
            for (path, modified, len, metrics) in &parsed {
                cache.insert(
                    path.clone(),
                    CachedMetrics {
                        modified: *modified,
                        len: *len,
                        metrics: metrics.clone(),
                    },
                );
            }
        }
        metrics_all.extend(parsed.into_iter().map(|(_, _, _, metrics)| metrics));
        Ok(metrics_all)
    }

    #[cfg(test)]
    pub(crate) fn cached_metrics_len(&self) -> usize {
        self.cost_metrics_cache
            .lock()
            .map_or(0, |cache| cache.len())
    }
}
