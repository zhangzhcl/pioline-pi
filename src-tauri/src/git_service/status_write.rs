// Git 状态快照查询、文件暂存/取消暂存/丢弃、工作区差异（Diff）与远端推送（Push）。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;
use std::sync::{Arc, Mutex, TryLockError};
use std::time::Instant;

use super::porcelain::{change_stats, parse_porcelain_v2_z};
use super::process::{
    assert_workspace_root, bounded_push_output, display_path, git, git_command, git_os, path_arg,
    run_git,
};
use super::{
    GitDiffRequest, GitDiffResponse, GitPathIdentity, GitPushOutcome, GitService, GitStatusEntry,
    GitStatusSnapshot, SnapshotRecord, MAX_DIFF_BYTES, MAX_SNAPSHOTS_PER_OWNER, MAX_STATUS_ENTRIES,
    NEXT_SNAPSHOT_ID, PUSH_DEADLINE, PUSH_DETACHED_HEAD, PUSH_NO_REMOTE, SNAPSHOT_TTL,
};

impl GitService {
    pub fn new() -> Self {
        Self {
            snapshots: Arc::new(Mutex::new(HashMap::new())),
            write_slots: Arc::new(Mutex::new(HashMap::new())),
            outcomes: Arc::new(Mutex::new(HashMap::new())),
            revoked_owners: Arc::new(Mutex::new(std::collections::HashSet::new())),
        }
    }

    /// 获取指定工作区根目录的独占写锁引用，超出容量上限时淘汰空闲槽位。
    pub(super) fn lock_for_write(&self, root: &Path) -> Arc<Mutex<()>> {
        const MAX_WRITE_SLOTS: usize = 64;
        let mut slots = self.write_slots.lock().unwrap();
        if slots.len() > MAX_WRITE_SLOTS {
            if let Some(victim) = slots
                .iter()
                .filter(|(_, arc)| Arc::strong_count(arc) <= 1)
                .min_by_key(|(path, _)| path.to_string_lossy().len())
                .map(|(path, _)| path.clone())
            {
                slots.remove(&victim);
            }
        }
        slots
            .entry(root.to_path_buf())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub fn status(
        &self,
        owner: &str,
        root: &Path,
        generation: u64,
    ) -> Result<GitStatusSnapshot, String> {
        assert_workspace_root(root)?;
        let output = git(root, &["status", "--porcelain=v2", "-z", "--branch"])?;
        let parsed = parse_porcelain_v2_z(&output);
        let id = format!(
            "git-{}",
            NEXT_SNAPSHOT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let head_oid = git(root, &["rev-parse", "--verify", "HEAD"])
            .ok()
            .map(|bytes| display_path(&bytes).trim().to_string())
            .filter(|value| !value.is_empty());
        let index_tree_oid = git(root, &["write-tree"])
            .ok()
            .map(|bytes| display_path(&bytes).trim().to_string())
            .filter(|value| !value.is_empty());
        let stats = change_stats(root, &parsed.head_state, parsed.counts.untracked);
        {
            let mut store = self.snapshots.lock().unwrap();
            Self::prune_store(&mut store, owner);
            store.insert(
                id.clone(),
                SnapshotRecord {
                    owner: owner.into(),
                    root: root.to_path_buf(),
                    generation,
                    created: Instant::now(),
                    entries: parsed.entries.clone(),
                    head_oid: head_oid.clone(),
                    index_tree_oid: index_tree_oid.clone(),
                    partial_stage_token: None,
                    partial_stage_token_created: None,
                },
            );
            Self::enforce_limit_store(&mut store, owner);
        }
        Ok(GitStatusSnapshot {
            snapshot_id: id,
            head_state: parsed.head_state,
            head_oid,
            index_tree_oid,
            branch: parsed.branch,
            upstream: parsed.upstream,
            ahead: parsed.ahead,
            behind: parsed.behind,
            change_stats: stats,
            counts: parsed.counts,
            returned_entry_count: parsed.entries.len(),
            total_entry_count: parsed.total_entry_count,
            truncated: parsed.truncated,
            entries: parsed.entries,
        })
    }

    pub(super) fn snapshot_for(
        &self,
        snapshot_id: &str,
        owner: &str,
        root: &Path,
        generation: u64,
    ) -> Result<SnapshotRecord, String> {
        let store = self.snapshots.lock().unwrap();
        let record = store.get(snapshot_id).ok_or("stale snapshot")?;
        if record.owner != owner
            || record.root != root
            || record.generation != generation
            || record.created.elapsed() > SNAPSHOT_TTL
        {
            return Err("stale snapshot".into());
        }
        let snapshot = record.clone();
        drop(store);
        Ok(snapshot)
    }

    pub(super) fn belongs_to_group(&self, entry: &GitStatusEntry, group: &str) -> bool {
        match group {
            "conflicted" => entry.entry_kind == "unmerged",
            "untracked" => entry.entry_kind == "untracked",
            "staged" => entry
                .xy
                .as_deref()
                .is_some_and(|xy| xy.as_bytes().first().is_some_and(|value| *value != b'.')),
            "changes" => entry
                .xy
                .as_deref()
                .is_some_and(|xy| xy.as_bytes().get(1).is_some_and(|value| *value != b'.')),
            _ => false,
        }
    }

    #[cfg(test)]
    pub fn validate_path(
        &self,
        snapshot_id: &str,
        owner: &str,
        root: &Path,
        generation: u64,
        path_bytes: &[u8],
    ) -> Result<(), String> {
        let _ = self.validated_entry(snapshot_id, owner, root, generation, path_bytes)?;
        Ok(())
    }

    fn validated_entry(
        &self,
        snapshot_id: &str,
        owner: &str,
        root: &Path,
        generation: u64,
        path_bytes: &[u8],
    ) -> Result<(String, GitStatusEntry), String> {
        let mut store = self.snapshots.lock().unwrap();
        let record = store.get(snapshot_id).ok_or("stale snapshot")?;
        if record.owner != owner
            || record.root != root
            || record.generation != generation
            || record.created.elapsed() > SNAPSHOT_TTL
        {
            store.remove(snapshot_id);
            return Err("stale snapshot".into());
        }
        if path_bytes.starts_with(b":(") {
            return Err("unauthorized path".into());
        }
        let path_base64 = BASE64.encode(path_bytes);
        let entry = record
            .entries
            .iter()
            .find(|entry| entry.path_bytes_base64 == path_base64)
            .cloned()
            .ok_or("unauthorized path")?;
        Ok((path_base64, entry))
    }

    pub fn write(
        &self,
        snapshot_id: &str,
        owner: &str,
        root: &Path,
        generation: u64,
        entries: &[GitPathIdentity],
        operation: &str,
    ) -> Result<(), String> {
        if entries.is_empty() || entries.len() > MAX_STATUS_ENTRIES {
            return Err("invalid path batch".into());
        }
        assert_workspace_root(root)?;
        let write_slot = self.lock_for_write(root);
        let _slot = match write_slot.try_lock() {
            Ok(slot) => slot,
            Err(TryLockError::WouldBlock) => return Err("busy".into()),
            Err(TryLockError::Poisoned(_)) => return Err("write slot unavailable".into()),
        };
        let snapshot = self.snapshot_for(snapshot_id, owner, root, generation)?;
        let fresh = parse_porcelain_v2_z(&git(root, &["status", "--porcelain=v2", "-z"])?).entries;
        for entry in entries {
            let entry_base64 = BASE64.encode(&entry.path_bytes);
            let orig_base64 = entry
                .original_path_bytes
                .as_deref()
                .map(|b| BASE64.encode(b));
            let old = snapshot
                .entries
                .iter()
                .find(|item| item.path_bytes_base64 == entry_base64)
                .ok_or("stale path")?;
            let current = fresh
                .iter()
                .find(|item| item.path_bytes_base64 == entry_base64)
                .ok_or("stale path")?;
            let allowed = matches!(
                (operation, entry.group.as_str()),
                ("stage", "changes" | "untracked" | "conflicted")
                    | ("unstage", "staged")
                    | ("discard", "changes")
            );
            let conflict_resolution_stage = operation == "stage"
                && entry.group == "conflicted"
                && self.belongs_to_group(old, "conflicted")
                && matches!(current.entry_kind.as_str(), "unmerged" | "ordinary")
                && !matches!(current.entry_kind.as_str(), "untracked" | "ignored");
            if !allowed
                || !self.belongs_to_group(old, &entry.group)
                || (!conflict_resolution_stage && !self.belongs_to_group(current, &entry.group))
                || (!conflict_resolution_stage && old.xy != current.xy)
                || (!conflict_resolution_stage && old.entry_kind != current.entry_kind)
                || (!conflict_resolution_stage && old.submodule != current.submodule)
                || old.original_path_bytes_base64 != orig_base64
                || current.original_path_bytes_base64 != orig_base64
            {
                return Err("stale path".into());
            }
        }
        let paths = entries
            .iter()
            .flat_map(|entry| {
                std::iter::once(entry.path_bytes.clone()).chain(entry.original_path_bytes.clone())
            })
            .collect::<Vec<_>>();
        let mut args = vec![OsString::from("--literal-pathspecs")];
        match operation {
            "stage" => args.extend([OsString::from("add"), OsString::from("-A")]),
            "unstage" => args.push(OsString::from("reset")),
            "discard" => args.extend([OsString::from("checkout")]),
            _ => return Err("unsupported Git write".into()),
        }
        args.push(OsString::from("--"));
        args.extend(paths.iter().map(|path| path_arg(path)));
        let _ = git_os(root, &args)?;
        Ok(())
    }

    /// 推送当前分支到已配置上游或默认远端（非交互模式）。
    pub fn push(&self, root: &Path) -> Result<GitPushOutcome, String> {
        assert_workspace_root(root)?;
        let write_slot = self.lock_for_write(root);
        let _slot = match write_slot.try_lock() {
            Ok(slot) => slot,
            Err(TryLockError::WouldBlock) => return Err("busy".into()),
            Err(TryLockError::Poisoned(_)) => return Err("write slot unavailable".into()),
        };
        let status =
            parse_porcelain_v2_z(&git(root, &["status", "--porcelain=v2", "-z", "--branch"])?);
        let branch = match (status.head_state.as_str(), status.branch.clone()) {
            ("attached", Some(branch)) if !branch.is_empty() => branch,
            _ => return Err(PUSH_DETACHED_HEAD.into()),
        };
        let remotes = String::from_utf8_lossy(&git(root, &["remote"])?)
            .lines()
            .map(|line| line.trim().to_owned())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        if remotes.is_empty() {
            return Err(PUSH_NO_REMOTE.into());
        }
        let (remote, args, set_upstream) = match status.upstream.as_deref() {
            Some(upstream) if !upstream.is_empty() => {
                let remote = upstream
                    .split_once('/')
                    .map(|(head, _)| head.to_owned())
                    .filter(|candidate| remotes.iter().any(|known| known == candidate))
                    .unwrap_or_else(|| remotes[0].clone());
                (remote, vec![OsString::from("push")], false)
            }
            _ => {
                let remote = if remotes.iter().any(|known| known == "origin") {
                    "origin".to_owned()
                } else {
                    remotes[0].clone()
                };
                (
                    remote.clone(),
                    vec![
                        OsString::from("push"),
                        OsString::from("--set-upstream"),
                        OsString::from(remote),
                        OsString::from("HEAD"),
                    ],
                    true,
                )
            }
        };
        let mut command = git_command(root, args);
        command.env("GIT_ASKPASS", "").env("SSH_ASKPASS", "");
        let user_ssh_command = std::env::var_os("GIT_SSH_COMMAND").is_some()
            || std::env::var_os("GIT_SSH").is_some()
            || git(root, &["config", "--get", "core.sshCommand"]).is_ok();
        if !user_ssh_command {
            command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
        }
        let (_stdout, stderr, success) = run_git(command, PUSH_DEADLINE)?;
        let output = bounded_push_output(&stderr);
        if success {
            Ok(GitPushOutcome {
                remote,
                branch,
                set_upstream,
                output,
            })
        } else if output.is_empty() {
            Err("push failed".into())
        } else {
            Err(output)
        }
    }

    pub fn diff(&self, request: GitDiffRequest<'_>) -> Result<GitDiffResponse, String> {
        let GitDiffRequest {
            snapshot_id,
            owner,
            root,
            generation,
            group,
            path_bytes,
            comparison,
        } = request;
        let (path_base64, entry) =
            self.validated_entry(snapshot_id, owner, root, generation, path_bytes)?;
        let expected_comparison = match group {
            "staged" => "staged",
            "changes" => "changes",
            "untracked" => "untracked",
            _ => return Err("unsupported diff group".into()),
        };
        if !self.belongs_to_group(&entry, group) || comparison != expected_comparison {
            return Err("unauthorized diff".into());
        }
        let path = path_arg(path_bytes);
        let args: Vec<OsString> = match comparison {
            "staged" => vec![
                "--literal-pathspecs".into(),
                "diff".into(),
                "--cached".into(),
                "--".into(),
                path,
            ],
            "changes" => vec![
                "--literal-pathspecs".into(),
                "diff".into(),
                "--".into(),
                path,
            ],
            "untracked" => vec![
                "--literal-pathspecs".into(),
                "diff".into(),
                "--no-index".into(),
                "/dev/null".into(),
                path,
            ],
            _ => return Err("unsupported comparison".into()),
        };
        let mut patch = git_os(root, &args)?;
        let truncated = patch.len() > MAX_DIFF_BYTES;
        patch.truncate(MAX_DIFF_BYTES);
        let patch_str = String::from_utf8_lossy(&patch);
        let is_binary_marker = patch_str.contains("Binary files ")
            || patch_str.contains("GIT binary patch")
            || patch_str.contains("Binary files a/")
            || patch.contains(&0);
        let fallback_reason = if entry.submodule.is_some() {
            Some("submodule".to_string())
        } else if entry.entry_kind == "unmerged" {
            Some("conflict".to_string())
        } else if is_binary_marker {
            Some("binary".to_string())
        } else if entry.entry_kind == "rename" || entry.entry_kind == "copy" {
            Some(entry.entry_kind.clone())
        } else {
            None
        };
        Ok(GitDiffResponse {
            snapshot_id: snapshot_id.into(),
            comparison: comparison.into(),
            path_bytes_base64: path_base64,
            raw_patch: patch_str.into_owned(),
            truncated,
            fallback_reason,
        })
    }

    #[cfg(test)]
    pub fn clear_owner_snapshots(&self, owner: &str) {
        self.snapshots
            .lock()
            .unwrap()
            .retain(|_, record| record.owner != owner);
    }

    #[cfg(test)]
    pub fn clear_workspace_state(&self, owner: &str) {
        self.clear_owner_snapshots(owner);
    }

    #[cfg(test)]
    pub fn clear_owner(&self, owner: &str) {
        self.clear_workspace_state(owner);
        self.outcomes
            .lock()
            .unwrap()
            .retain(|_, outcome| outcome.owner != owner);
        self.revoked_owners
            .lock()
            .unwrap()
            .insert(owner.to_string());
    }

    fn prune_store(store: &mut HashMap<String, SnapshotRecord>, owner: &str) {
        store.retain(|_, record| record.owner != owner || record.created.elapsed() <= SNAPSHOT_TTL);
    }

    fn enforce_limit_store(store: &mut HashMap<String, SnapshotRecord>, owner: &str) {
        while store
            .values()
            .filter(|record| record.owner == owner)
            .count()
            > MAX_SNAPSHOTS_PER_OWNER
        {
            if let Some(id) = store
                .iter()
                .filter(|(_, record)| record.owner == owner)
                .min_by_key(|(_, record)| record.created)
                .map(|(id, _)| id.clone())
            {
                store.remove(&id);
            }
        }
    }
}
