// Git 提交历史分页查询、单次提交详情解析与提交级文件 Diff。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::ffi::OsString;
use std::path::Path;

use super::process::{assert_workspace_root, git, git_os, path_arg};
use super::{
    CommitKind, GitCommitDiffResponse, GitLogDetailFile, GitLogDetailResponse, GitLogEntry,
    GitLogResponse, GitNameStatusFile, GitService, MAX_DIFF_BYTES, MAX_LOG_FILES,
    MAX_LOG_FILES_BYTES, MAX_LOG_LIMIT, MAX_LOG_MESSAGE_BYTES,
};

const LOG_LIST_FMT: &str = "%H%x00%h%x00%s%x00%an%x00%at";
const LOG_DETAIL_FMT: &str = "%H%x00%an%x00%at%x00%B";

impl GitService {
    pub fn log(
        &self,
        _owner: &str,
        root: &Path,
        _generation: u64,
        limit: usize,
        before: Option<&str>,
    ) -> Result<GitLogResponse, String> {
        assert_workspace_root(root)?;
        let limit = limit.clamp(1, MAX_LOG_LIMIT);
        if let Some(before) = before {
            validate_oid(before)?;
        }
        if git(root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).is_err() {
            return Ok(GitLogResponse {
                commits: Vec::new(),
                has_more: false,
            });
        }
        let mut args: Vec<OsString> = vec![
            "--no-pager".into(),
            "log".into(),
            "--first-parent".into(),
            format!("--max-count={limit}").into(),
            format!("--format={LOG_LIST_FMT}").into(),
            "-z".into(),
        ];
        if let Some(before) = before {
            let verify = format!("{before}^{{commit}}");
            if git(root, &["rev-parse", "--verify", "--quiet", &verify]).is_err() {
                return Err("unknown commit".into());
            }
            let parent = format!("{before}~1^{{commit}}");
            if git(root, &["rev-parse", "--verify", "--quiet", &parent]).is_err() {
                return Ok(GitLogResponse {
                    commits: Vec::new(),
                    has_more: false,
                });
            }
            args.push(format!("{before}~1").into());
        }
        let output = git_os(root, &args).map_err(|_| "log failed".to_string())?;
        let fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
        let mut commits = Vec::new();
        for group in fields.as_chunks::<5>().0 {
            commits.push(GitLogEntry {
                oid: String::from_utf8_lossy(group[0]).into_owned(),
                subject: String::from_utf8_lossy(group[2]).into_owned(),
                author_name: String::from_utf8_lossy(group[3]).into_owned(),
                author_time: String::from_utf8_lossy(group[4]).parse().unwrap_or(0),
            });
        }
        Ok(GitLogResponse {
            has_more: commits.len() == limit,
            commits,
        })
    }

    pub fn log_detail(
        &self,
        _owner: &str,
        root: &Path,
        _generation: u64,
        oid: &str,
    ) -> Result<GitLogDetailResponse, String> {
        assert_workspace_root(root)?;
        validate_oid(oid)?;
        let kind = commit_kind(root, oid)?;
        let args = vec![
            OsString::from("--no-pager"),
            OsString::from("log"),
            OsString::from("-1"),
            OsString::from(format!("--format={LOG_DETAIL_FMT}")),
            OsString::from("-z"),
            OsString::from(oid),
        ];
        let output = git_os(root, &args).map_err(|_| "log detail failed".to_string())?;
        let fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
        if fields.len() < 4 {
            return Err("malformed log detail".into());
        }
        let mut full_message = String::from_utf8_lossy(fields[3]).into_owned();
        while full_message.ends_with(['\r', '\n']) {
            full_message.pop();
        }
        let mut message_truncated = false;
        if full_message.len() > MAX_LOG_MESSAGE_BYTES {
            message_truncated = true;
            let mut end = MAX_LOG_MESSAGE_BYTES;
            while end > 0 && !full_message.is_char_boundary(end) {
                end -= 1;
            }
            full_message.truncate(end);
            full_message.push('…');
        }
        let mut files = Vec::new();
        let mut files_truncated = false;
        let mut files_bytes = 0;
        for file in name_status(root, kind, oid)? {
            let encoded_path = BASE64.encode(&file.path_bytes);
            let file_bytes = file.status.len()
                + file.path.len()
                + encoded_path.len()
                + file.original_path.as_deref().map_or(0, str::len);
            if files.len() >= MAX_LOG_FILES || files_bytes + file_bytes > MAX_LOG_FILES_BYTES {
                files_truncated = true;
                break;
            }
            files_bytes += file_bytes;
            files.push(GitLogDetailFile {
                status: file.status,
                path: file.path,
                path_bytes_base64: encoded_path,
                original_path: file.original_path,
            });
        }
        Ok(GitLogDetailResponse {
            oid: String::from_utf8_lossy(fields[0]).into_owned(),
            author_name: String::from_utf8_lossy(fields[1]).into_owned(),
            author_time: String::from_utf8_lossy(fields[2]).parse().unwrap_or(0),
            full_message,
            message_truncated,
            files_truncated,
            files,
        })
    }

    pub fn commit_diff(
        &self,
        _owner: &str,
        root: &Path,
        _generation: u64,
        oid: &str,
        path_bytes: &[u8],
    ) -> Result<GitCommitDiffResponse, String> {
        assert_workspace_root(root)?;
        validate_oid(oid)?;
        let kind = commit_kind(root, oid)?;
        let file = name_status(root, kind, oid)?
            .into_iter()
            .find(|file| file.path_bytes == path_bytes)
            .ok_or("unauthorized commit path")?;
        let path = path_arg(path_bytes);
        let args = match kind {
            CommitKind::Root => vec![
                "--literal-pathspecs".into(),
                "--no-pager".into(),
                "diff-tree".into(),
                "-p".into(),
                "--root".into(),
                oid.into(),
                "--".into(),
                path,
            ],
            CommitKind::Linear => vec![
                "--literal-pathspecs".into(),
                "--no-pager".into(),
                "diff-tree".into(),
                "-p".into(),
                oid.into(),
                "--".into(),
                path,
            ],
            CommitKind::Merge => {
                let parent = format!("{oid}^1");
                vec![
                    "--literal-pathspecs".into(),
                    "--no-pager".into(),
                    "diff".into(),
                    parent.into(),
                    oid.into(),
                    "--".into(),
                    path,
                ]
            }
        };
        let mut patch = git_os(root, &args)?;
        let truncated = patch.len() > MAX_DIFF_BYTES;
        patch.truncate(MAX_DIFF_BYTES);
        let has_nul = patch.contains(&0);
        let patch_text = String::from_utf8_lossy(&patch);
        let fallback_reason = if patch_text.contains("Binary files ")
            || patch_text.contains("GIT binary patch")
            || has_nul
        {
            Some("binary".to_string())
        } else if file.status.starts_with('R') {
            Some("rename".to_string())
        } else if file.status.starts_with('C') {
            Some("copy".to_string())
        } else {
            None
        };
        Ok(GitCommitDiffResponse {
            comparison: "commit".into(),
            path_bytes_base64: BASE64.encode(path_bytes),
            raw_patch: patch_text.into_owned(),
            truncated,
            fallback_reason,
        })
    }
}

/// 解析 `git diff-tree --name-status -r -z` 与 `git diff --name-status -r -z`。
pub fn parse_diff_tree_name_status_z(bytes: &[u8]) -> Vec<GitNameStatusFile> {
    let tokens: Vec<&[u8]> = bytes
        .split(|b| *b == 0)
        .filter(|token| !token.is_empty())
        .collect();
    let mut files = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        let is_status = matches!(token, b"M" | b"A" | b"D" | b"T" | b"U" | b"X" | b"B")
            || matches!(token.first(), Some(b'R' | b'C'))
                && token.len() > 1
                && token[1..].iter().all(u8::is_ascii_digit);
        if !is_status {
            index += 1;
            continue;
        }
        let is_rename_or_copy = matches!(token.first(), Some(b'R' | b'C'));
        let path_count = if is_rename_or_copy { 2 } else { 1 };
        if index + path_count >= tokens.len() {
            index += 1;
            continue;
        }
        let original = if is_rename_or_copy {
            Some(tokens[index + 1].to_vec())
        } else {
            None
        };
        let path = tokens[index + path_count].to_vec();
        files.push(GitNameStatusFile {
            status: String::from_utf8_lossy(token).into_owned(),
            path: String::from_utf8_lossy(&path).into_owned(),
            path_bytes: path,
            original_path: original
                .as_deref()
                .map(|value| String::from_utf8_lossy(value).into_owned()),
        });
        index += path_count + 1;
    }
    files
}

pub fn validate_oid(oid: &str) -> Result<(), String> {
    if (oid.len() != 40 && oid.len() != 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid oid".into());
    }
    Ok(())
}

pub fn commit_kind(root: &Path, oid: &str) -> Result<CommitKind, String> {
    validate_oid(oid)?;
    let verify = format!("{oid}^{{commit}}");
    if git(root, &["rev-parse", "--verify", "--quiet", &verify]).is_err() {
        return Err("unknown commit".into());
    }
    let parents = git(root, &["log", "-1", "--format=%P", oid])?;
    Ok(
        match String::from_utf8_lossy(&parents).split_whitespace().count() {
            0 => CommitKind::Root,
            1 => CommitKind::Linear,
            _ => CommitKind::Merge,
        },
    )
}

fn name_status(root: &Path, kind: CommitKind, oid: &str) -> Result<Vec<GitNameStatusFile>, String> {
    let output = match kind {
        CommitKind::Root => git_os(
            root,
            &[
                "--literal-pathspecs".into(),
                "--no-pager".into(),
                "diff-tree".into(),
                "--no-commit-id".into(),
                "--name-status".into(),
                "-M".into(),
                "-C".into(),
                "-r".into(),
                "-z".into(),
                "--root".into(),
                oid.into(),
            ],
        )?,
        CommitKind::Linear => git_os(
            root,
            &[
                "--literal-pathspecs".into(),
                "--no-pager".into(),
                "diff-tree".into(),
                "--no-commit-id".into(),
                "--name-status".into(),
                "-M".into(),
                "-C".into(),
                "-r".into(),
                "-z".into(),
                oid.into(),
            ],
        )?,
        CommitKind::Merge => {
            let parent = format!("{oid}^1");
            git_os(
                root,
                &[
                    "--literal-pathspecs".into(),
                    "--no-pager".into(),
                    "diff".into(),
                    "--name-status".into(),
                    "-M".into(),
                    "-C".into(),
                    "-r".into(),
                    "-z".into(),
                    parent.into(),
                    oid.into(),
                ],
            )?
        }
    };
    Ok(parse_diff_tree_name_status_z(&output))
}
