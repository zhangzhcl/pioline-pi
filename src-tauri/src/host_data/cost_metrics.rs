// 会话成本与 Token 指标解析及成本仪表盘聚合。

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::super::{same_dir, HostDataError};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostDashboardSummary {
    pub total_cost: f64,
    pub total_tokens: u64,
    pub session_count: u64,
    pub user_message_count: u64,
    pub avg_cost_per_session: f64,
    pub avg_cost_per_user_message: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBreakdownEntry {
    pub name: String,
    pub cost: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSessionRow {
    pub id: String,
    pub title: String,
    pub model: String,
    pub time: String,
    pub total_cost: f64,
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub tool_calls: u64,
    pub tool_cost_by_name: HashMap<String, f64>,
    pub user_messages: u64,
    pub project_path: String,
    pub project_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostDashboard {
    pub summary: CostDashboardSummary,
    pub by_model: Vec<CostBreakdownEntry>,
    pub by_tool: Vec<CostBreakdownEntry>,
    pub top_sessions: Vec<CostSessionRow>,
    pub sessions: Vec<CostSessionRow>,
}

#[derive(Debug, Clone, Default)]
pub struct SessionMetrics {
    pub id: String,
    pub title: String,
    pub cwd: Option<PathBuf>,
    pub model: String,
    pub timestamp: String,
    pub total_cost: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub user_messages: u64,
    pub tool_calls: u64,
    pub tool_cost_by_name: HashMap<String, f64>,
}

pub fn parse_session_metrics(
    path: &Path,
    workspace: Option<&Path>,
) -> Result<Option<SessionMetrics>, HostDataError> {
    let file = std::fs::File::open(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut metrics = SessionMetrics {
        model: "unknown".to_owned(),
        ..SessionMetrics::default()
    };
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
                entry
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .clone_into(&mut metrics.id);
                entry
                    .get("timestamp")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .clone_into(&mut metrics.timestamp);
                metrics.cwd = entry
                    .get("cwd")
                    .and_then(serde_json::Value::as_str)
                    .map(PathBuf::from);
                if let Some(workspace) = workspace {
                    let Some(cwd) = metrics.cwd.as_ref() else {
                        return Ok(None);
                    };
                    if !same_dir(cwd, workspace) {
                        return Ok(None);
                    }
                }
            }
            Some("session_info") => {
                if let Some(name) = entry.get("name").and_then(serde_json::Value::as_str) {
                    name.clone_into(&mut metrics.title);
                }
            }
            Some("model_change") => {
                if let Some(model) = entry.get("model").and_then(serde_json::Value::as_str) {
                    model.clone_into(&mut metrics.model);
                }
            }
            Some("message") => {
                let Some(role) = entry
                    .pointer("/message/role")
                    .and_then(serde_json::Value::as_str)
                else {
                    continue;
                };
                if role == "user" {
                    metrics.user_messages += 1;
                    continue;
                }
                if role != "assistant" {
                    continue;
                }
                if let Some(model) = entry
                    .pointer("/message/model")
                    .and_then(serde_json::Value::as_str)
                {
                    model.clone_into(&mut metrics.model);
                }
                let usage = entry.pointer("/message/usage");
                let cost = usage
                    .and_then(|usage| usage.pointer("/cost/total"))
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0);
                metrics.total_cost += cost;
                metrics.input_tokens += usage
                    .and_then(|usage| usage.get("input"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                metrics.output_tokens += usage
                    .and_then(|usage| usage.get("output"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                metrics.cache_read += usage
                    .and_then(|usage| usage.get("cacheRead"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                metrics.cache_write += usage
                    .and_then(|usage| usage.get("cacheWrite"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                if let Some(blocks) = entry
                    .pointer("/message/content")
                    .and_then(serde_json::Value::as_array)
                {
                    let tool_count = blocks
                        .iter()
                        .filter(|block| {
                            block.get("type").and_then(serde_json::Value::as_str)
                                == Some("toolCall")
                                && block
                                    .get("name")
                                    .and_then(serde_json::Value::as_str)
                                    .is_some()
                        })
                        .count();
                    metrics.tool_calls += tool_count as u64;
                    if tool_count > 0 && cost > 0.0 {
                        let per_tool_cost = cost / tool_count as f64;
                        for tool_name in blocks
                            .iter()
                            .filter(|block| {
                                block.get("type").and_then(serde_json::Value::as_str)
                                    == Some("toolCall")
                            })
                            .filter_map(|block| {
                                block.get("name").and_then(serde_json::Value::as_str)
                            })
                        {
                            *metrics
                                .tool_cost_by_name
                                .entry(tool_name.to_owned())
                                .or_insert(0.0) += per_tool_cost;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if metrics.id.is_empty() {
        return Ok(None);
    }
    if let Some(workspace) = workspace {
        let Some(cwd) = metrics.cwd.as_ref() else {
            return Ok(None);
        };
        if !same_dir(cwd, workspace) {
            return Ok(None);
        }
    }
    if metrics.title.is_empty() {
        metrics.title = "Untitled".to_owned();
    }
    Ok(Some(metrics))
}

pub fn build_cost_dashboard(sessions: Vec<SessionMetrics>) -> CostDashboard {
    let mut dashboard = CostDashboard::default();
    let mut by_model: Vec<(String, f64)> = Vec::new();
    let mut by_tool: HashMap<String, f64> = HashMap::new();
    for session in &sessions {
        dashboard.summary.total_cost += session.total_cost;
        let session_tokens =
            session.input_tokens + session.output_tokens + session.cache_read + session.cache_write;
        dashboard.summary.total_tokens += session_tokens;
        dashboard.summary.user_message_count += session.user_messages;
        dashboard.summary.session_count += 1;

        match by_model.iter_mut().find(|(name, _)| name == &session.model) {
            Some((_, cost)) => *cost += session.total_cost,
            None => by_model.push((session.model.clone(), session.total_cost)),
        }
        for (tool_name, cost) in &session.tool_cost_by_name {
            *by_tool.entry(tool_name.clone()).or_insert(0.0) += cost;
        }
    }
    dashboard.summary.avg_cost_per_session = if dashboard.summary.session_count > 0 {
        dashboard.summary.total_cost / dashboard.summary.session_count as f64
    } else {
        0.0
    };
    dashboard.summary.avg_cost_per_user_message = if dashboard.summary.user_message_count > 0 {
        dashboard.summary.total_cost / dashboard.summary.user_message_count as f64
    } else {
        0.0
    };
    by_model.sort_by(|left, right| right.1.total_cmp(&left.1));
    dashboard.by_model = by_model
        .into_iter()
        .map(|(name, cost)| CostBreakdownEntry { name, cost })
        .collect();
    let mut by_tool: Vec<(String, f64)> = by_tool.into_iter().collect();
    by_tool.sort_by(|left, right| right.1.total_cmp(&left.1));
    dashboard.by_tool = by_tool
        .into_iter()
        .map(|(name, cost)| CostBreakdownEntry { name, cost })
        .collect();

    let mut session_rows: Vec<CostSessionRow> = sessions
        .into_iter()
        .map(|session| {
            let project_path = session
                .cwd
                .as_ref()
                .map(|cwd| cwd.to_string_lossy().into_owned())
                .unwrap_or_default();
            let project_name = session
                .cwd
                .as_ref()
                .and_then(|cwd| cwd.file_name())
                .map_or_else(
                    || project_path.clone(),
                    |name| name.to_string_lossy().into_owned(),
                );
            CostSessionRow {
                id: session.id,
                title: session.title,
                model: session.model,
                time: session.timestamp,
                total_cost: session.total_cost,
                total_tokens: session.input_tokens
                    + session.output_tokens
                    + session.cache_read
                    + session.cache_write,
                input_tokens: session.input_tokens,
                output_tokens: session.output_tokens,
                cache_read: session.cache_read,
                cache_write: session.cache_write,
                tool_calls: session.tool_calls,
                tool_cost_by_name: session.tool_cost_by_name,
                user_messages: session.user_messages,
                project_path,
                project_name,
            }
        })
        .collect();
    session_rows.sort_by(|left, right| right.total_cost.total_cmp(&left.total_cost));
    dashboard.top_sessions = session_rows.iter().take(20).cloned().collect();
    dashboard.sessions = session_rows;
    dashboard
}
