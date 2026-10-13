// Git Porcelain v2 状态解析、变更统计（numstat）与 AI Diff 截断。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::path::Path;

use super::process::{display_path, git};
use super::{GitChangeStats, GitCounts, GitStatusEntry, ParsedStatus, MAX_STATUS_ENTRIES};

fn record_value<'a>(record: &'a [u8], prefix: &[u8]) -> Option<&'a [u8]> {
    record.strip_prefix(prefix)
}

fn path_field(record: &[u8]) -> &[u8] {
    record.rsplit(|b| *b == b' ').next().unwrap_or_default()
}

fn unmerged_fields(record: &[u8]) -> Vec<&[u8]> {
    // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
    record.splitn(11, |b| *b == b' ').collect()
}

fn submodule_field(record: &[u8]) -> Option<String> {
    record
        .splitn(10, |b| *b == b' ')
        .nth(2)
        .filter(|value| value.starts_with(b"S"))
        .map(display_path)
}

fn rename_kind(record: &[u8]) -> &'static str {
    match record
        .splitn(10, |b| *b == b' ')
        .nth(8)
        .and_then(|value| value.first())
    {
        Some(b'C') => "copy",
        _ => "rename",
    }
}

fn xy(record: &[u8]) -> Option<String> {
    record
        .get(2..4)
        .map(|v| String::from_utf8_lossy(v).to_string())
}

fn changed_byte(record: &[u8], offset: usize) -> bool {
    record.get(offset).is_some_and(|b| *b != b'.')
}

pub(super) fn numstat(bytes: &[u8]) -> (u64, u64, usize) {
    let mut additions = 0;
    let mut deletions = 0;
    let mut binary = 0;
    for line in bytes.split(|b| *b == b'\n') {
        let mut fields = line.splitn(3, |b| *b == b'\t');
        let (Some(added), Some(deleted), Some(_)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if added == b"-" || deleted == b"-" {
            binary += 1;
            continue;
        }
        additions += std::str::from_utf8(added)
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        deletions += std::str::from_utf8(deleted)
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
    }
    (additions, deletions, binary)
}

pub(super) fn bounded_ai_diff(bytes: &[u8]) -> (String, bool) {
    const MAX_CHARS: usize = 24_000;
    const MAX_FILES: usize = 80;
    const MAX_LINES_PER_FILE: usize = 80;
    let source = String::from_utf8_lossy(bytes);
    let mut output = String::new();
    let mut output_chars = 0usize;
    let mut files = 0;
    let mut lines_in_file = 0;
    let mut truncated = false;
    for line in source.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            files += 1;
            lines_in_file = 0;
        }
        if files > MAX_FILES || lines_in_file >= MAX_LINES_PER_FILE {
            truncated = true;
            continue;
        }
        let line_chars = line.chars().count();
        if output_chars + line_chars > MAX_CHARS {
            truncated = true;
            break;
        }
        output.push_str(line);
        output_chars += line_chars;
        lines_in_file += 1;
    }
    (output, truncated)
}

pub(super) fn change_stats(root: &Path, head_state: &str, untracked: usize) -> GitChangeStats {
    let args = if head_state == "unborn" {
        vec!["--literal-pathspecs", "diff", "--cached", "--numstat", "--"]
    } else {
        vec!["--literal-pathspecs", "diff", "HEAD", "--numstat", "--"]
    };
    let (additions, deletions, binary_file_count) = git(root, &args)
        .map(|output| numstat(&output))
        .unwrap_or_default();
    GitChangeStats {
        basis: if head_state == "unborn" {
            "empty-tree-to-worktree"
        } else {
            "head-to-worktree"
        }
        .into(),
        additions,
        deletions,
        untracked_excluded_count: untracked,
        binary_file_count,
    }
}

/// 解析 `git status --porcelain=v2 -z` 输出，以 NUL 分隔记录。
pub fn parse_porcelain_v2_z(bytes: &[u8]) -> ParsedStatus {
    let records: Vec<&[u8]> = bytes.split(|b| *b == 0).filter(|r| !r.is_empty()).collect();
    let mut entries = Vec::new();
    let mut counts = GitCounts::default();
    let mut total_entry_count = 0;
    let mut index = 0;
    let mut head_state = "unborn".to_string();
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = None;
    let mut behind = None;
    while index < records.len() {
        if let Some(value) = record_value(records[index], b"# branch.oid ") {
            head_state = if value == b"(initial)" {
                "unborn"
            } else {
                "attached"
            }
            .into();
            index += 1;
            continue;
        }
        if let Some(value) = record_value(records[index], b"# branch.head ") {
            if value == b"(detached)" {
                head_state = "detached".into();
            } else if !value.is_empty() {
                branch = Some(display_path(value));
            }
            index += 1;
            continue;
        }
        if let Some(value) = record_value(records[index], b"# branch.upstream ") {
            upstream = Some(display_path(value));
            index += 1;
            continue;
        }
        if let Some(value) = record_value(records[index], b"# branch.ab ") {
            let mut fields = value.split(|b| *b == b' ');
            ahead = fields
                .next()
                .and_then(|v| v.strip_prefix(b"+"))
                .and_then(|v| std::str::from_utf8(v).ok())
                .and_then(|v| v.parse().ok());
            behind = fields
                .next()
                .and_then(|v| v.strip_prefix(b"-"))
                .and_then(|v| std::str::from_utf8(v).ok())
                .and_then(|v| v.parse().ok());
            index += 1;
            continue;
        }
        let record = records[index];
        let kind = record.first().copied().unwrap_or_default();
        let keep_entry = entries.len() < MAX_STATUS_ENTRIES;
        let (maybe_entry, staged, worktree) = match kind {
            b'?' | b'!' => {
                let entry = keep_entry.then(|| {
                    let path = record.get(2..).unwrap_or_default();
                    GitStatusEntry {
                        record_type: (kind as char).to_string(),
                        xy: None,
                        entry_kind: if kind == b'?' { "untracked" } else { "ignored" }.into(),
                        display_path: display_path(path),
                        path_bytes_base64: BASE64.encode(path),
                        original_display_path: None,
                        original_path_bytes_base64: None,
                        submodule: None,
                        unmerged_modes: None,
                        unmerged_object_ids: None,
                    }
                });
                (entry, false, false)
            }
            b'1' => {
                let staged = changed_byte(record, 2);
                let worktree = changed_byte(record, 3);
                let entry = keep_entry.then(|| {
                    let path = path_field(record);
                    GitStatusEntry {
                        record_type: "1".into(),
                        xy: xy(record),
                        entry_kind: "ordinary".into(),
                        display_path: display_path(path),
                        path_bytes_base64: BASE64.encode(path),
                        original_display_path: None,
                        original_path_bytes_base64: None,
                        submodule: submodule_field(record),
                        unmerged_modes: None,
                        unmerged_object_ids: None,
                    }
                });
                (entry, staged, worktree)
            }
            b'2' => {
                let original = records.get(index + 1).copied().unwrap_or_default();
                index += 1;
                let entry = keep_entry.then(|| {
                    let path = path_field(record);
                    GitStatusEntry {
                        record_type: "2".into(),
                        xy: xy(record),
                        entry_kind: rename_kind(record).into(),
                        display_path: display_path(path),
                        path_bytes_base64: BASE64.encode(path),
                        original_display_path: Some(display_path(original)),
                        original_path_bytes_base64: Some(BASE64.encode(original)),
                        submodule: submodule_field(record),
                        unmerged_modes: None,
                        unmerged_object_ids: None,
                    }
                });
                (entry, true, true)
            }
            b'u' => {
                let entry = keep_entry.then(|| {
                    let fields = unmerged_fields(record);
                    let path = fields.get(10).copied().unwrap_or_default();
                    GitStatusEntry {
                        record_type: "u".into(),
                        xy: xy(record),
                        entry_kind: "unmerged".into(),
                        display_path: display_path(path),
                        path_bytes_base64: BASE64.encode(path),
                        original_display_path: None,
                        original_path_bytes_base64: None,
                        submodule: submodule_field(record),
                        unmerged_modes: Some(
                            fields
                                .iter()
                                .skip(3)
                                .take(3)
                                .map(|value| display_path(value))
                                .collect(),
                        ),
                        unmerged_object_ids: Some(
                            fields
                                .iter()
                                .skip(7)
                                .take(3)
                                .map(|value| display_path(value))
                                .collect(),
                        ),
                    }
                });
                (entry, false, false)
            }
            _ => {
                index += 1;
                continue;
            }
        };
        total_entry_count += 1;
        counts.staged += staged as usize;
        counts.changes += worktree as usize;
        counts.untracked += (kind == b'?') as usize;
        counts.conflicted += (kind == b'u') as usize;
        if let Some(entry) = maybe_entry {
            entries.push(entry);
        }
        index += 1;
    }
    ParsedStatus {
        total_entry_count,
        truncated: total_entry_count > MAX_STATUS_ENTRIES,
        entries,
        counts,
        head_state,
        branch,
        upstream,
        ahead,
        behind,
    }
}
