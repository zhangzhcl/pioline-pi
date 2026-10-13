use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{is_home_project_path, is_remote_project_path, HostDataError};

#[path = "cost_metrics.rs"]
mod cost_metrics;

pub use cost_metrics::{
    build_cost_dashboard, parse_session_metrics, CostDashboard, SessionMetrics,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub timestamp: String,
    pub name: Option<String>,
    pub first_message: Option<String>,
    pub workspace_id: String,
    /// Absolute working directory the session was created in (its "project").
    pub project_path: String,
    /// Human-friendly project label (last path component of `project_path`).
    pub project_name: String,
    /// True when `project_path` is an anchor under `~/.picot/remotes`, i.e. the
    /// session runs against a remote host over SSH rather than a local folder.
    /// The sidebar renders a "remote" badge on such workspace groups.
    pub is_remote: bool,
    /// True when `project_path` is the user's home directory — the default
    /// workspace every window opens with. The sidebar labels this group
    /// "Sessions" instead of the home folder name, which is not a project.
    pub is_default_workspace: bool,
    /// True when this session belongs to the workspace the sidebar is showing.
    pub is_current_workspace: bool,
    /// Absolute path to the persisted JSONL session file.
    pub file_path: String,
    pub file_name: String,
    /// Filesystem mtime for cache invalidation/debugging only. UI recency uses
    /// `activity_at_ms` so a read-only resume/touch does not reorder projects.
    pub modified_at_ms: u128,
    /// Last user-message timestamp when available; falls back to the session
    /// header timestamp, then filesystem mtime for legacy/incomplete files.
    pub activity_at_ms: u128,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchMatch {
    pub role: String,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchResult {
    pub session_id: String,
    pub session_name: Option<String>,
    pub session_timestamp: String,
    pub first_message: Option<String>,
    pub file_name: String,
    pub matches: Vec<SessionSearchMatch>,
}

pub fn find_chars(haystack: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

pub fn search_session_file(
    path: &Path,
    workspace: &Path,
    query: &str,
) -> Result<Option<SessionSearchResult>, HostDataError> {
    const MAX_MATCHES_PER_SESSION: usize = 3;
    let file = std::fs::File::open(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let needle: Vec<char> = query.chars().collect();
    let mut session_id = None;
    let mut session_timestamp = String::new();
    let mut session_name = None;
    let mut first_message = None;
    let mut cwd = None;
    let mut matches = Vec::new();
    loop {
        line.clear();
        let Ok(bytes) = reader.read_line(&mut line) else {
            continue;
        };
        if bytes == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        match entry.get("type").and_then(serde_json::Value::as_str) {
            Some("session") => {
                session_id = entry
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                entry
                    .get("timestamp")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .clone_into(&mut session_timestamp);
                let parsed_cwd = entry
                    .get("cwd")
                    .and_then(serde_json::Value::as_str)
                    .map(PathBuf::from)
                    .and_then(|dir| dir.canonicalize().ok());
                if parsed_cwd.as_deref() != Some(workspace) {
                    return Ok(None);
                }
                cwd = parsed_cwd;
            }
            Some("session_info") => {
                session_name = entry
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
            }
            Some("message") => {
                let role_str = entry
                    .pointer("/message/role")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown");
                let need_first_user = role_str == "user" && first_message.is_none();
                let need_match = matches.len() < MAX_MATCHES_PER_SESSION;
                if !need_first_user && !need_match {
                    continue;
                }
                let Some(text) = message_text(entry.pointer("/message/content")) else {
                    continue;
                };
                if need_first_user {
                    first_message = Some(text.chars().take(120).collect::<String>());
                }
                if !need_match {
                    continue;
                }
                let lower: Vec<char> = text.to_lowercase().chars().collect();
                if let Some(index) = find_chars(&lower, &needle) {
                    let original: Vec<char> = text.chars().collect();
                    let start = index.saturating_sub(60);
                    let end = (index + needle.len() + 60).min(original.len());
                    let snippet: String = original[start..end].iter().collect();
                    let snippet = format!(
                        "{}{}{}",
                        if start > 0 { "…" } else { "" },
                        snippet.replace('\n', " "),
                        if end < original.len() { "…" } else { "" }
                    );
                    matches.push(SessionSearchMatch {
                        role: role_str.to_owned(),
                        snippet,
                    });
                }
            }
            _ => {}
        }
    }
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    let Some(cwd) = cwd else {
        return Ok(None);
    };
    if cwd != workspace || matches.is_empty() {
        return Ok(None);
    }
    Ok(Some(SessionSearchResult {
        session_id,
        session_name,
        session_timestamp,
        first_message,
        file_name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        matches,
    }))
}

pub fn parse_session_id(path: &Path) -> Result<Option<String>, HostDataError> {
    let file = std::fs::File::open(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let Ok(bytes) = reader.read_line(&mut line) else {
            continue;
        };
        if bytes == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if entry.get("type").and_then(serde_json::Value::as_str) == Some("session") {
            return Ok(entry
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned));
        }
    }
    Ok(None)
}

pub fn metadata_modified_at_ms(metadata: &std::fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis())
}

pub fn timestamp_value_ms(value: Option<&serde_json::Value>) -> Option<u128> {
    match value? {
        serde_json::Value::Number(number) => number.as_u64().map(u128::from),
        serde_json::Value::String(text) => iso_timestamp_ms(text),
        _ => None,
    }
}

pub fn iso_timestamp_ms(text: &str) -> Option<u128> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (date, time) = trimmed.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let time = time.strip_suffix('Z').unwrap_or(time);
    if time.contains('+') || time.rmatch_indices('-').any(|(index, _)| index > 0) {
        return None;
    }
    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<u32>().ok()?;
    let minute = time_parts.next()?.parse::<u32>().ok()?;
    let second_text = time_parts.next()?;
    if time_parts.next().is_some() || hour > 23 || minute > 59 {
        return None;
    }
    let (second_whole, fraction) = second_text
        .split_once('.')
        .map_or((second_text, ""), |(whole, fraction)| (whole, fraction));
    let second = second_whole.parse::<u32>().ok()?;
    if second > 59 {
        return None;
    }
    let millis = fraction
        .chars()
        .take(3)
        .try_fold((0_u32, 0_u32), |(value, digits), ch| {
            ch.to_digit(10)
                .map(|digit| (value * 10 + digit, digits + 1))
        })
        .map_or(0, |(value, digits)| value * 10_u32.pow(3 - digits));

    let days = days_from_civil(year, month, day)?;
    Some(
        days as u128 * 86_400_000
            + hour as u128 * 3_600_000
            + minute as u128 * 60_000
            + second as u128 * 1_000
            + millis as u128,
    )
}

// Howard Hinnant's days-from-civil algorithm. Returns days since 1970-01-01.
pub fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era as i64 * 146_097 + doe as i64 - 719_468;
    (days >= 0).then_some(days)
}

pub fn parse_session_summary_with_metadata(
    path: &Path,
    modified_at_ms: u128,
) -> Result<Option<SessionSummary>, HostDataError> {
    let file = std::fs::File::open(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut id = None;
    let mut timestamp = String::new();
    let mut cwd = None;
    let mut name = None;
    let mut first_message = None;
    let mut last_user_message_at_ms = None;
    let mut user_message_count = 0;
    let mut line_count = 0;
    loop {
        line.clear();
        let Ok(bytes) = reader.read_line(&mut line) else {
            continue;
        };
        if bytes == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        line_count += 1;
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        match entry.get("type").and_then(serde_json::Value::as_str) {
            Some("session") => {
                id = entry
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                entry
                    .get("timestamp")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .clone_into(&mut timestamp);
                cwd = entry
                    .get("cwd")
                    .and_then(serde_json::Value::as_str)
                    .map(PathBuf::from);
            }
            Some("session_info") => {
                name = entry
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
            }
            Some("message")
                if entry
                    .pointer("/message/role")
                    .and_then(serde_json::Value::as_str)
                    == Some("user") =>
            {
                user_message_count += 1;
                last_user_message_at_ms = timestamp_value_ms(
                    entry
                        .pointer("/message/timestamp")
                        .or_else(|| entry.get("timestamp")),
                )
                .or(last_user_message_at_ms);
                if first_message.is_none() {
                    first_message = message_text(entry.pointer("/message/content"))
                        .map(|text| text.chars().take(120).collect());
                }
            }
            _ => {}
        }
        if line_count > 50 && first_message.is_some() && name.is_some() {
            break;
        }
    }
    let Some(id) = id else { return Ok(None) };
    if user_message_count == 0 && line_count <= 4 && name.as_deref() != Some("Agent Inbox") {
        return Ok(None);
    }
    let Some(cwd) = cwd else {
        return Ok(None);
    };
    let project_path = cwd.canonicalize().unwrap_or(cwd);
    let project_name = project_path.file_name().map_or_else(
        || project_path.to_string_lossy().into_owned(),
        |value| value.to_string_lossy().into_owned(),
    );
    let is_remote = is_remote_project_path(&project_path);
    let is_default_workspace = is_home_project_path(&project_path);
    let activity_at_ms = last_user_message_at_ms
        .or_else(|| iso_timestamp_ms(&timestamp))
        .unwrap_or(modified_at_ms);
    Ok(Some(SessionSummary {
        id,
        timestamp,
        name,
        first_message,
        workspace_id: String::new(),
        project_path: project_path.to_string_lossy().into_owned(),
        project_name,
        is_remote,
        is_default_workspace,
        is_current_workspace: false,
        file_path: path.to_string_lossy().into_owned(),
        file_name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        modified_at_ms,
        activity_at_ms,
    }))
}

pub fn message_text(content: Option<&serde_json::Value>) -> Option<String> {
    match content? {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .find(|block| block.get("type").and_then(serde_json::Value::as_str) == Some("text"))
            .and_then(|block| block.get("text"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        _ => None,
    }
}
