use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::Serialize;

use super::HostDataError;

/// Verbatim JSONL tree snapshot for the Info panel's session history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionTreeSnapshot {
    pub entries: Vec<serde_json::Value>,
    pub leaf_id: Option<String>,
}

pub fn message_with_entry_id(mut message: serde_json::Value, entry_id: &str) -> serde_json::Value {
    let role = message.get("role").and_then(serde_json::Value::as_str);
    if role != Some("user") && role != Some("assistant") {
        return message;
    }
    if let Some(object) = message.as_object_mut() {
        object.insert(
            "entryId".to_owned(),
            serde_json::Value::String(entry_id.to_owned()),
        );
    }
    message
}

/// Read session messages directly from the on-disk JSONL file, bypassing
/// the Pi runtime process. Traces back from the last message in the file
/// (the tip of the current branch) to reconstruct the correct message chain.
pub fn read_session_messages_from_path(
    path: &Path,
) -> Result<Vec<serde_json::Value>, HostDataError> {
    let file = std::fs::File::open(path).map_err(|e| HostDataError::Io(e.to_string()))?;

    // 收集所有 JSONL 条目的平行索引与消息载荷：(id, parentId) 与 message_value
    let mut entry_links: Vec<(String, Option<String>)> = Vec::new();
    let mut entry_messages: Vec<Option<serde_json::Value>> = Vec::new();
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| HostDataError::Io(format!("Cannot read session history: {error}")))?;
        if bytes == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(mut entry) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        let Some(id) = entry
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        let parent_id = entry
            .get("parentId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let message_value =
            if entry.get("type").and_then(serde_json::Value::as_str) == Some("message") {
                entry
                    .get_mut("message")
                    .map(serde_json::Value::take)
                    .map(|message| message_with_entry_id(message, &id))
            } else {
                None
            };
        entry_links.push((id, parent_id));
        entry_messages.push(message_value);
    }

    if entry_links.is_empty() {
        return Ok(vec![]);
    }

    // Build id -> index map for parentId traversal
    let id_to_idx: HashMap<&str, usize> = entry_links
        .iter()
        .enumerate()
        .map(|(i, (id, _))| (id.as_str(), i))
        .collect();

    // Find the last message entry — the tip of the current branch
    let Some(tip_idx) = entry_messages
        .iter()
        .enumerate()
        .rev()
        .find(|(_, msg)| msg.is_some())
        .map(|(i, _)| i)
    else {
        return Ok(vec![]);
    };

    // Walk back from the tip through parentId links, collecting message entries.
    // Non-message entries (model_change, thinking_level_change, etc.) are
    // traversed but not collected.
    let mut chain: Vec<serde_json::Value> = Vec::new();
    let mut current = tip_idx;
    let mut visited = HashSet::new();
    loop {
        if !visited.insert(current) {
            break; // cycle guard
        }
        if let Some(message) = entry_messages[current].take() {
            chain.push(message);
        }
        match entry_links[current].1.as_deref() {
            None => break,
            Some(pid) => match id_to_idx.get(pid) {
                Some(&idx) => current = idx,
                None => break,
            },
        }
    }
    chain.reverse();
    Ok(chain)
}

/// Full session JSONL tree snapshot for the Info panel: every id-carrying
/// entry verbatim (hidden entries keep the parent/child chain connected
/// across skipped nodes) plus the derived active leaf. The leaf uses the
/// same last-message-tip rule as `read_session_messages`, so the tree and
/// the main-chat transcript always agree on which branch is active.
pub fn read_session_tree_from_path(path: &Path) -> Result<SessionTreeSnapshot, HostDataError> {
    let file = std::fs::File::open(path).map_err(|e| HostDataError::Io(e.to_string()))?;

    let mut entries: Vec<serde_json::Value> = Vec::new();
    // Parallel (id, parentId, is-message) index for the tip walk.
    let mut index: Vec<(String, Option<String>, bool)> = Vec::new();
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| HostDataError::Io(format!("Cannot read session tree: {error}")))?;
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
        let Some(id) = entry.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let parent_id = entry
            .get("parentId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let is_message = entry.get("type").and_then(serde_json::Value::as_str) == Some("message");
        index.push((id.to_owned(), parent_id, is_message));
        entries.push(entry);
    }

    if entries.is_empty() {
        return Ok(SessionTreeSnapshot {
            entries,
            leaf_id: None,
        });
    }

    let id_to_idx: HashMap<&str, usize> = index
        .iter()
        .enumerate()
        .map(|(i, (id, _, _))| (id.as_str(), i))
        .collect();
    // Same tip rule as read_session_messages: the LAST message entry in the
    // file heads the active branch. Verify its parent chain resolves (walk
    // to root purely as a cycle guard) and report the tip itself as leaf.
    let Some(tip_idx) = index
        .iter()
        .enumerate()
        .rev()
        .find(|(_, (_, _, is_message))| *is_message)
        .map(|(i, _)| i)
    else {
        return Ok(SessionTreeSnapshot {
            entries,
            leaf_id: None,
        });
    };
    let mut visited = HashSet::new();
    let mut current = tip_idx;
    let mut chain_ok = true;
    loop {
        if !visited.insert(current) {
            chain_ok = false; // cycle guard
            break;
        }
        match index[current].1.as_deref() {
            None => break,
            Some(pid) => match id_to_idx.get(pid) {
                Some(&idx) => current = idx,
                None => break,
            },
        }
    }
    let leaf_id = chain_ok.then(|| index[tip_idx].0.clone());

    Ok(SessionTreeSnapshot { entries, leaf_id })
}
