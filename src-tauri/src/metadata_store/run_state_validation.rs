// 工作流运行实例（Run）状态机转移校验、节点状态完整性与冻结快照契约验证。

use serde_json::Value;
use std::collections::HashSet;

use super::workflow_validation::{
    self, validate_custom_node_contracts, validate_workflow_structure,
};
use super::{
    MAX_WORKFLOW_NODE_OUTPUT_BYTES, MAX_WORKFLOW_RUN_EVENT_COUNT,
    TERMINAL_WORKFLOW_RUN_EVENT_RESERVE,
};

pub(super) fn validate_workflow_run_event_state_delta(
    previous: &Value,
    next: &Value,
    event_type: &str,
    event: &Value,
) -> Result<(), String> {
    let previous_result = previous.get("result").cloned().unwrap_or(Value::Null);
    let previous_error = previous.get("error").cloned().unwrap_or(Value::Null);
    let next_result = next.get("result").cloned().unwrap_or(Value::Null);
    let next_error = next.get("error").cloned().unwrap_or(Value::Null);
    match event_type {
        "run_completed" => {
            let event_result = event
                .get("result")
                .ok_or("Workflow run_completed event is missing result")?;
            if next_result != *event_result {
                return Err("Workflow run result does not match run_completed event".into());
            }
            if next_error != previous_error {
                return Err("Workflow run error changed during run_completed".into());
            }
        }
        "run_failed" | "run_cancelled" | "run_interrupted" => {
            let error = event
                .get("error")
                .and_then(Value::as_str)
                .ok_or("Terminal workflow event is missing its error")?;
            if next_error.as_str() != Some(error) {
                return Err(format!(
                    "Workflow run error does not match {event_type} event"
                ));
            }
            if next_result != previous_result {
                return Err(format!("Workflow run result changed during {event_type}"));
            }
        }
        _ => {
            if next_result != previous_result || next_error != previous_error {
                return Err(format!(
                    "Workflow run result or error changed during {event_type}"
                ));
            }
        }
    }
    let previous_states = previous
        .get("nodeStates")
        .and_then(Value::as_object)
        .ok_or("Stored workflow run nodeStates are invalid")?;
    let next_states = next
        .get("nodeStates")
        .and_then(Value::as_object)
        .ok_or("Workflow run nodeStates are invalid")?;
    if event_type.starts_with("node_") {
        let node_id = event
            .get("nodeId")
            .and_then(Value::as_str)
            .ok_or("Workflow node event is missing nodeId")?;
        for (other_node_id, previous_state) in previous_states {
            if other_node_id == node_id {
                continue;
            }
            if next_states.get(other_node_id) != Some(previous_state) {
                return Err(format!(
                    "Workflow node event changed an unrelated node state: {other_node_id}"
                ));
            }
        }
        let previous_state = previous_states
            .get(node_id)
            .ok_or("Workflow node event references an unknown node")?;
        let next_state = next_states
            .get(node_id)
            .ok_or("Workflow node event references an unknown node")?;
        let prior = previous_state
            .get("status")
            .and_then(Value::as_str)
            .ok_or("Workflow node event references an unknown node")?;
        let current = next_state
            .get("status")
            .and_then(Value::as_str)
            .ok_or("Workflow node event references an unknown node")?;
        let expected = match event_type {
            "node_started" | "node_log" => "running",
            "node_completed" => "success",
            "node_failed" => "error",
            "node_interrupted" => "interrupted",
            "node_skipped" => "skipped",
            _ => return Err("Unknown workflow node event".into()),
        };
        if current != expected
            || (event_type == "node_started" && prior != "idle")
            || (event_type == "node_log" && prior != "running")
            || (event_type == "node_completed" && !matches!(prior, "idle" | "running"))
            || (event_type == "node_failed" && prior != "running")
            || (event_type == "node_interrupted" && prior != "running")
            || (event_type == "node_skipped" && prior != "idle")
        {
            return Err(format!(
                "Workflow node state does not match event {event_type}"
            ));
        }
        let mut expected_state = previous_state.clone();
        match event_type {
            "node_started" => expected_state["status"] = Value::from("running"),
            "node_log" => {
                let message = event
                    .get("message")
                    .and_then(Value::as_str)
                    .ok_or("Workflow node_log event is missing its message")?;
                let mut logs = previous_state
                    .get("logs")
                    .and_then(Value::as_array)
                    .cloned()
                    .ok_or("Stored workflow node logs are invalid")?;
                logs.push(Value::from(message));
                expected_state["logs"] = Value::Array(logs);
            }
            "node_completed" => {
                expected_state["status"] = Value::from("success");
                expected_state["output"] = event
                    .get("output")
                    .cloned()
                    .ok_or("Workflow node_completed event is missing its output")?;
                expected_state["error"] = Value::Null;
            }
            "node_failed" | "node_interrupted" => {
                let error = event
                    .get("error")
                    .and_then(Value::as_str)
                    .ok_or("Workflow node terminal event is missing its error")?;
                expected_state["status"] = Value::from(expected);
                expected_state["output"] = Value::Null;
                expected_state["error"] = Value::from(error);
            }
            "node_skipped" => {
                if event
                    .get("reason")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                {
                    return Err("Workflow node_skipped event is missing its reason".into());
                }
                expected_state["status"] = Value::from("skipped");
                expected_state["logs"] = Value::Array(Vec::new());
                expected_state["output"] = Value::Null;
                expected_state["error"] = Value::Null;
            }
            _ => return Err("Unknown workflow node event".into()),
        }
        if next_state != &expected_state {
            return Err(format!(
                "Workflow node state does not match event {event_type}"
            ));
        }
    }
    match event_type {
        "run_started" => {
            if previous_states != next_states {
                return Err("Workflow node state changed during run_started".into());
            }
            if next_states
                .values()
                .any(|state| state.get("status").and_then(Value::as_str) == Some("running"))
            {
                return Err("Workflow run cannot start with a node already running".into());
            }
        }
        "run_completed" => {
            if previous_states != next_states {
                return Err("Workflow node state changed during run_completed".into());
            }
            if next_states.values().any(|state| {
                !matches!(
                    state.get("status").and_then(Value::as_str),
                    Some("success" | "skipped")
                )
            }) {
                return Err("Completed workflow run contains unfinished nodes".into());
            }
        }
        "run_failed" | "run_cancelled" => {
            if previous_states != next_states {
                return Err(format!("Workflow node state changed during {event_type}"));
            }
            if next_states.values().any(|state| {
                matches!(
                    state.get("status").and_then(Value::as_str),
                    Some("idle" | "running")
                )
            }) {
                return Err("Terminal workflow run contains unfinished nodes".into());
            }
        }
        "run_interrupted" => {
            if next_states
                .values()
                .any(|state| state.get("status").and_then(Value::as_str) == Some("running"))
            {
                return Err("Interrupted workflow run contains a running node".into());
            }
            let error = event
                .get("error")
                .and_then(Value::as_str)
                .ok_or("Interrupted workflow event is missing its error")?;
            let skipped_node_ids = event
                .get("skippedNodeIds")
                .and_then(Value::as_array)
                .map(|ids| {
                    let mut unique = std::collections::HashSet::new();
                    ids.iter()
                        .map(|id| {
                            id.as_str()
                                .filter(|id| unique.insert(*id))
                                .ok_or("Interrupted workflow skippedNodeIds are invalid")
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?;
            if let Some(ids) = &skipped_node_ids {
                for node_id in ids {
                    if previous_states
                        .get(*node_id)
                        .and_then(|state| state.get("status"))
                        .and_then(Value::as_str)
                        != Some("idle")
                    {
                        return Err(
                            "Interrupted workflow skippedNodeIds must reference idle nodes".into(),
                        );
                    }
                }
            }
            for (node_id, previous_state) in previous_states {
                let next_state = next_states
                    .get(node_id)
                    .ok_or("Interrupted workflow run is missing a node state")?;
                let prior_status = previous_state
                    .get("status")
                    .and_then(Value::as_str)
                    .ok_or("Stored workflow node state is invalid")?;
                let mut expected_state = previous_state.clone();
                match prior_status {
                    "running" => {
                        expected_state["status"] = Value::from("interrupted");
                        expected_state["error"] = Value::from(error);
                    }
                    "idle"
                        if skipped_node_ids
                            .as_ref()
                            .is_some_and(|ids| ids.contains(&node_id.as_str())) =>
                    {
                        expected_state["status"] = Value::from("skipped");
                    }
                    "idle" if skipped_node_ids.is_none() && next_state != previous_state => {
                        expected_state["status"] = Value::from("skipped");
                    }
                    _ => {}
                }
                if next_state != &expected_state {
                    return Err(format!(
                        "Workflow run_interrupted contains an invalid node state transition for {node_id}"
                    ));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn validate_workflow_run_node_states(run: &Value) -> Result<(), String> {
    let nodes = run
        .pointer("/snapshot/nodes")
        .and_then(Value::as_array)
        .ok_or("Workflow run graph snapshot must contain a nodes array")?;
    let states = run
        .get("nodeStates")
        .and_then(Value::as_object)
        .ok_or("Workflow run nodeStates must be an object")?;
    if states.len() != nodes.len() {
        return Err("Workflow run nodeStates must match the graph nodes".into());
    }
    let mut seen_nodes = HashSet::with_capacity(nodes.len());
    for node in nodes {
        let node_id = node
            .get("instanceId")
            .and_then(Value::as_str)
            .ok_or("Workflow run graph node instanceId is invalid")?;
        seen_nodes.insert(node_id);
        let state = states
            .get(node_id)
            .and_then(Value::as_object)
            .ok_or_else(|| format!("Workflow run state is missing for node {node_id}"))?;
        let logs_valid = state
            .get("logs")
            .and_then(Value::as_array)
            .is_some_and(|logs| logs.iter().all(Value::is_string));
        if !matches!(
            state.get("status").and_then(Value::as_str),
            Some("idle" | "running" | "success" | "error" | "skipped" | "interrupted")
        ) || !logs_valid
            || state.get("output").is_none()
            || !state
                .get("error")
                .is_some_and(|error| error.is_null() || error.is_string())
        {
            return Err(format!("Workflow run state is invalid for node {node_id}"));
        }
    }
    if seen_nodes.len() != states.len() {
        return Err("Workflow run nodeStates contain an unknown node".into());
    }
    Ok(())
}

struct BoundedJsonSizeCounter {
    bytes: usize,
    limit: usize,
}

impl std::io::Write for BoundedJsonSizeCounter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.bytes = self.bytes.saturating_add(buf.len());
        if self.bytes > self.limit {
            return Err(std::io::Error::other("exceeded limit"));
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn check_json_within_limit(value: &Value, limit: usize, exceeded_msg: &str) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    let mut counter = BoundedJsonSizeCounter { bytes: 0, limit };
    if serde_json::to_writer(&mut counter, value).is_err() && counter.bytes > limit {
        return Err(exceeded_msg.into());
    }
    Ok(())
}

pub(super) fn validate_workflow_run_output_sizes(run: &Value) -> Result<(), String> {
    let input = run.get("input").ok_or("Workflow run input is missing")?;
    check_json_within_limit(
        input,
        MAX_WORKFLOW_NODE_OUTPUT_BYTES,
        "Workflow input exceeds the 512 KB limit",
    )?;
    for state in run
        .get("nodeStates")
        .and_then(Value::as_object)
        .ok_or("Workflow run nodeStates must be an object")?
        .values()
    {
        let output = state
            .get("output")
            .ok_or("Workflow run node output is missing")?;
        check_json_within_limit(
            output,
            MAX_WORKFLOW_NODE_OUTPUT_BYTES,
            "Workflow node output exceeds the 512 KB limit",
        )?;
    }
    let result = run.get("result").ok_or("Workflow run result is missing")?;
    check_json_within_limit(
        result,
        MAX_WORKFLOW_NODE_OUTPUT_BYTES,
        "Workflow result exceeds the 512 KB limit",
    )?;
    Ok(())
}

pub(super) fn validate_workflow_run_max_concurrency(run: &Value) -> Result<(), String> {
    let Some(value) = run.get("maxConcurrency") else {
        return Ok(());
    };
    let valid = value.as_u64().is_some_and(|count| (1..=4).contains(&count))
        || value.as_f64().is_some_and(|count| {
            count.is_finite() && count.fract() == 0.0 && (1.0..=4.0).contains(&count)
        });
    if valid {
        Ok(())
    } else {
        Err("Workflow run maxConcurrency must be an integer between 1 and 4".into())
    }
}

pub(super) fn validate_workflow_run_event_limit(
    expected_sequence: i64,
    event_type: Option<&str>,
) -> Result<(), String> {
    let terminal = matches!(
        event_type,
        Some(
            "node_failed"
                | "node_interrupted"
                | "run_completed"
                | "run_failed"
                | "run_cancelled"
                | "run_interrupted"
        )
    );
    if expected_sequence >= MAX_WORKFLOW_RUN_EVENT_COUNT
        || (!terminal
            && expected_sequence
                >= MAX_WORKFLOW_RUN_EVENT_COUNT - TERMINAL_WORKFLOW_RUN_EVENT_RESERVE)
    {
        return Err("Workflow run reached the 10,000 event limit".into());
    }
    Ok(())
}

pub(super) fn validate_workflow_run_node_meta_snapshot(run: &Value) -> Result<(), String> {
    let graph = run
        .get("snapshot")
        .ok_or("Workflow run graph snapshot is missing")?;
    validate_workflow_structure(graph)?;
    let input = run.get("input").ok_or("Workflow run input is missing")?;
    let start = graph
        .pointer("/nodes")
        .and_then(Value::as_array)
        .and_then(|nodes| {
            nodes.iter().find(|node| {
                node.pointer("/meta/id").and_then(Value::as_str) == Some("pipline.start")
            })
        })
        .ok_or("Workflow run graph snapshot is missing its Start node")?;
    let default_schema = serde_json::json!({ "properties": {}, "required": [] });
    let input_schema = start
        .pointer("/paramValues/inputSchema")
        .unwrap_or(&default_schema);
    workflow_validation::validate_workflow_start_input(input, input_schema)?;
    let Some(snapshot) = run.get("nodeMetaSnapshot") else {
        return Ok(());
    };
    let templates = snapshot
        .as_object()
        .ok_or("Workflow run NodeMeta snapshot must be an object")?;
    validate_custom_node_contracts(graph, templates)?;
    let nodes = run
        .pointer("/snapshot/nodes")
        .and_then(Value::as_array)
        .ok_or("Workflow run graph snapshot must contain a nodes array")?;
    for node in nodes {
        let meta = node
            .get("meta")
            .and_then(Value::as_object)
            .ok_or("Workflow run node reference is invalid")?;
        let id = meta
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Workflow run node template id is invalid")?;
        let version = meta
            .get("version")
            .and_then(Value::as_str)
            .ok_or("Workflow run node template version is invalid")?;
        let key = format!("{id}@{version}");
        let frozen = templates
            .get(&key)
            .ok_or_else(|| format!("Workflow run is missing frozen NodeMeta: {key}"))?;
        if frozen.get("id").and_then(Value::as_str) != Some(id)
            || frozen.get("version").and_then(Value::as_str) != Some(version)
        {
            return Err(format!(
                "Workflow run frozen NodeMeta does not match: {key}"
            ));
        }
    }
    Ok(())
}
