// AI 提交消息快照准备、预提交确认校验、后台分离式 Commit 与重连结果恢复。

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

use super::porcelain::bounded_ai_diff;
use super::process::{assert_workspace_root, display_path, git, git_command, run_git};
use super::{
    GitAiSnapshot, GitDetachedCommit, GitService, PendingGitOutcome, COMMIT_DEADLINE, OUTCOME_TTL,
};

impl GitService {
    pub fn prepare_ai_snapshot(
        &self,
        owner: &str,
        root: &Path,
        generation: u64,
    ) -> Result<GitAiSnapshot, String> {
        const MAX_RETRIES: usize = 3;
        for _attempt in 0..MAX_RETRIES {
            let tree_before = git(root, &["write-tree"])
                .ok()
                .map(|v| display_path(&v).trim().to_owned());
            let status = self.status(owner, root, generation)?;
            if status.counts.staged == 0 {
                return Err("no staged changes".into());
            }
            if status.counts.conflicted > 0 {
                return Err("conflicted changes".into());
            }
            let diff = git(
                root,
                &[
                    "--literal-pathspecs",
                    "diff",
                    "--cached",
                    "--binary",
                    "--no-color",
                    "--",
                ],
            )?;
            let tree_after = git(root, &["write-tree"])
                .ok()
                .map(|v| display_path(&v).trim().to_owned());
            if tree_before != tree_after || status.index_tree_oid != tree_before {
                continue;
            }
            let (staged_diff, staged_diff_truncated) = bounded_ai_diff(&diff);
            return Ok(GitAiSnapshot {
                snapshot_id: status.snapshot_id,
                head_state: status.head_state,
                head_oid: status.head_oid,
                index_tree_oid: status.index_tree_oid,
                staged_diff,
                staged_diff_truncated,
            });
        }
        Err("staged diff did not stabilize".into())
    }

    /// 同步预提交校验：若存在部分暂存（partial-stage）文件则返回 `confirmationRequired:<token>`。
    pub fn prepare_commit(
        &self,
        snapshot_id: &str,
        owner: &str,
        root: &Path,
        generation: u64,
        message: &str,
        confirmation_token: Option<&str>,
    ) -> Result<(), String> {
        if message.trim().is_empty() || message.len() > 64 * 1024 {
            return Err("invalid commit message".into());
        }
        assert_workspace_root(root)?;
        let snapshot = self.snapshot_for(snapshot_id, owner, root, generation)?;
        let current_head = git(root, &["rev-parse", "--verify", "HEAD"])
            .ok()
            .map(|v| display_path(&v).trim().to_owned());
        let current_tree = git(root, &["write-tree"])
            .ok()
            .map(|v| display_path(&v).trim().to_owned());
        if current_head != snapshot.head_oid || current_tree != snapshot.index_tree_oid {
            return Err("stale snapshot".into());
        }
        let partial = snapshot.entries.iter().any(|entry| {
            entry
                .xy
                .as_deref()
                .is_some_and(|xy| xy.as_bytes().first().is_some_and(|v| *v != b'.'))
                && entry
                    .xy
                    .as_deref()
                    .is_some_and(|xy| xy.as_bytes().get(1).is_some_and(|v| *v != b'.'))
        });
        if partial {
            let mut store = self.snapshots.lock().unwrap();
            let record = store.get_mut(snapshot_id).ok_or("stale snapshot")?;
            if confirmation_token.is_none() {
                let token = Uuid::new_v4().simple().to_string();
                record.partial_stage_token = Some(token.clone());
                record.partial_stage_token_created = Some(Instant::now());
                drop(store);
                return Err(format!("confirmationRequired:{token}"));
            }
            if record.partial_stage_token.as_deref() != confirmation_token
                || record
                    .partial_stage_token_created
                    .is_none_or(|created| created.elapsed() > Duration::from_secs(60))
            {
                return Err("invalid confirmation token".into());
            }
            record.partial_stage_token = None;
            record.partial_stage_token_created = None;
        }
        Ok(())
    }

    /// 启动宿主托管的分离式后台提交任务（5 分钟硬超时，支持断线重连恢复结果）。
    pub fn commit_detached(&self, commit: GitDetachedCommit) {
        let GitDetachedCommit {
            snapshot_id,
            owner,
            root,
            generation,
            request_id,
            message,
            notify,
        } = commit;
        let captured_snapshot = self
            .snapshot_for(&snapshot_id, &owner, &root, generation)
            .ok();
        let snapshots = self.snapshots.clone();
        let outcomes = self.outcomes.clone();
        let revoked_owners = self.revoked_owners.clone();
        let write_slot = self.lock_for_write(&root);
        thread::spawn(move || {
            let _slot = write_slot.lock().unwrap();
            let record_failed = |reason: String| {
                record_outcome(
                    &outcomes,
                    &revoked_owners,
                    PendingGitOutcome {
                        owner: owner.clone(),
                        root: root.to_string_lossy().to_string(),
                        generation,
                        request_id: request_id.clone(),
                        status: "failed".into(),
                        commit_oid: None,
                        hook_changed_tree: false,
                        error: Some(reason),
                        created: Some(Instant::now()),
                    },
                )
            };
            let Some(snapshot) = captured_snapshot else {
                let frame = record_failed("stale snapshot".into());
                if let Some(notify) = notify {
                    notify(frame);
                }
                return;
            };
            let current_head = git(&root, &["rev-parse", "--verify", "HEAD"])
                .ok()
                .map(|v| display_path(&v).trim().to_owned());
            let current_tree = git(&root, &["write-tree"])
                .ok()
                .map(|v| display_path(&v).trim().to_owned());
            if current_head != snapshot.head_oid || current_tree != snapshot.index_tree_oid {
                let frame = record_failed("stale snapshot".into());
                if let Some(notify) = notify {
                    notify(frame);
                }
                snapshots.lock().unwrap().remove(&snapshot_id);
                return;
            }
            let expected_tree = snapshot.index_tree_oid;
            let initial_head = current_head;
            let temp = match tempfile::Builder::new()
                .prefix("picot-git-message-")
                .tempfile()
            {
                Ok(temp) => temp,
                Err(error) => {
                    let frame = record_failed(error.to_string());
                    if let Some(notify) = notify {
                        notify(frame);
                    }
                    snapshots.lock().unwrap().remove(&snapshot_id);
                    return;
                }
            };
            if let Err(error) = fs::write(temp.path(), message.as_bytes()) {
                let frame = record_failed(error.to_string());
                if let Some(notify) = notify {
                    notify(frame);
                }
                snapshots.lock().unwrap().remove(&snapshot_id);
                return;
            }
            let args = [
                OsString::from("commit"),
                OsString::from("-F"),
                temp.path().as_os_str().to_owned(),
            ];
            let started = Instant::now();
            let commit_result = run_git(git_command(&root, args.iter().cloned()), COMMIT_DEADLINE);
            let _elapsed = started.elapsed();
            let (commit_ok, stderr_text) = match commit_result {
                Ok((_stdout, stderr, success)) => {
                    (success, String::from_utf8_lossy(&stderr).to_string())
                }
                Err(error) => (false, error),
            };
            let timed_out = stderr_text.contains("timed out");
            let current_head = git(&root, &["rev-parse", "--verify", "HEAD"])
                .ok()
                .map(|v| display_path(&v).trim().to_owned());
            let actual_tree = git(&root, &["rev-parse", "HEAD^{tree}"])
                .ok()
                .map(|v| display_path(&v).trim().to_owned());
            let hook_changed_tree = actual_tree.is_some() && actual_tree != expected_tree;
            let (status, commit_oid, error) =
                if commit_ok && current_head.is_some() && current_head != initial_head {
                    ("succeeded", current_head, None)
                } else if !commit_ok && !timed_out && current_head == initial_head {
                    let trimmed = stderr_text.trim();
                    (
                        "failed",
                        None,
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed.to_string())
                        },
                    )
                } else {
                    (
                        "outcomeUnknown",
                        None,
                        if stderr_text.trim().is_empty() {
                            None
                        } else {
                            Some(stderr_text.trim().to_string())
                        },
                    )
                };
            let frame = record_outcome(
                &outcomes,
                &revoked_owners,
                PendingGitOutcome {
                    owner,
                    root: root.to_string_lossy().to_string(),
                    generation,
                    request_id,
                    status: status.to_string(),
                    commit_oid,
                    hook_changed_tree,
                    error,
                    created: Some(Instant::now()),
                },
            );
            if let Some(notify) = notify {
                notify(frame);
            }
            snapshots.lock().unwrap().remove(&snapshot_id);
        });
    }

    /// 消费并返回匹配 `owner + root + generation` 的所有待恢复提交结果。
    #[cfg(test)]
    pub fn take_pending_outcomes(
        &self,
        owner: &str,
        root: &Path,
        generation: u64,
    ) -> Vec<PendingGitOutcome> {
        let root_string = root.to_string_lossy().to_string();
        let mut store = self.outcomes.lock().unwrap();
        store.retain(|_, existing| {
            existing
                .created
                .is_some_and(|created| created.elapsed() <= OUTCOME_TTL)
        });
        let matching_keys: Vec<String> = store
            .iter()
            .filter(|(_, outcome)| {
                outcome.owner == owner
                    && outcome.root == root_string
                    && outcome.generation == generation
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut results = Vec::new();
        for key in matching_keys {
            if let Some(outcome) = store.remove(&key) {
                results.push(outcome);
            }
        }
        results.sort_by_key(|a| a.created);
        results
    }
}

pub(super) fn record_outcome(
    outcomes: &Arc<Mutex<HashMap<String, PendingGitOutcome>>>,
    revoked_owners: &Arc<Mutex<std::collections::HashSet<String>>>,
    outcome: PendingGitOutcome,
) -> String {
    let key = format!(
        "{}\0{}\0{}\0{}",
        outcome.owner, outcome.root, outcome.generation, outcome.request_id
    );
    let frame = serde_json::json!({
        "type": "git_commit_result",
        "requestId": outcome.request_id,
        "workspaceGeneration": outcome.generation,
        "status": outcome.status,
        "commitOid": outcome.commit_oid,
        "hookChangedTree": outcome.hook_changed_tree,
        "error": outcome.error
    });
    let serialized = serde_json::to_string(&frame).unwrap_or_else(|_| {
        "{\"type\":\"git_commit_result\",\"status\":\"outcomeUnknown\"}".into()
    });
    let mut store = outcomes.lock().unwrap();
    if revoked_owners.lock().unwrap().contains(&outcome.owner) {
        return serialized;
    }
    store.retain(|_, existing| {
        existing
            .created
            .is_some_and(|created| created.elapsed() <= OUTCOME_TTL)
    });
    store.insert(key, outcome);
    serialized
}
