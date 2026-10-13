use serde_json::Value;

pub(super) struct RunIndex<'a> {
    pub run_id: &'a str,
    pub workspace_id: &'a str,
    pub status: &'a str,
    pub workflow_id: &'a str,
    pub workflow_revision: i64,
    pub event_sequence: i64,
    pub updated_at: &'a str,
}

pub(super) fn validate(
    run: &Value,
    index: &RunIndex<'_>,
    events: &[(i64, Value)],
) -> Result<(), String> {
    validate_summary(run, index)?;
    if index.event_sequence < 0 || events.len() as i64 != index.event_sequence {
        return Err("Workflow Run event sequence disagrees with its event history".into());
    }

    super::validate_workflow_run_max_concurrency(run)?;
    super::validate_workflow_run_node_states(run)?;
    super::validate_workflow_run_output_sizes(run)?;
    super::validate_workflow_run_node_meta_snapshot(run)?;

    for (event_index, (stored_sequence, event)) in events.iter().enumerate() {
        let expected_sequence = event_index as i64 + 1;
        let expected_id = format!("{}:{expected_sequence}", index.run_id);
        if *stored_sequence != expected_sequence
            || event.get("sequence").and_then(Value::as_i64) != Some(expected_sequence)
            || event.get("id").and_then(Value::as_str) != Some(expected_id.as_str())
            || event.get("runId").and_then(Value::as_str) != Some(index.run_id)
            || event.get("workflowId").and_then(Value::as_str) != Some(index.workflow_id)
            || event.get("revision").and_then(Value::as_i64) != Some(index.workflow_revision)
            || event
                .get("timestamp")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        {
            return Err("Stored workflow Run event history is inconsistent".into());
        }
    }

    validate_replay(run, events)?;

    let last_event = events.last().map(|(_, event)| event);
    let status_is_consistent = match index.status {
        "queued" => index.event_sequence == 0,
        "running" => {
            index.event_sequence > 0
                && last_event.is_some_and(|event| {
                    matches!(
                        event.get("type").and_then(Value::as_str),
                        Some(
                            "run_started"
                                | "node_started"
                                | "node_log"
                                | "node_completed"
                                | "node_failed"
                                | "node_interrupted"
                                | "node_skipped"
                        )
                    )
                })
        }
        "success" => last_event.is_some_and(|event| {
            event.get("type").and_then(Value::as_str) == Some("run_completed")
                && event.get("result") == run.get("result")
        }),
        "error" => last_event.is_some_and(|event| {
            event.get("type").and_then(Value::as_str) == Some("run_failed")
                && event.get("error") == run.get("error")
        }),
        "cancelled" => last_event.is_some_and(|event| {
            event.get("type").and_then(Value::as_str) == Some("run_cancelled")
                && event.get("error") == run.get("error")
        }),
        "interrupted" => last_event.is_some_and(|event| {
            event.get("type").and_then(Value::as_str) == Some("run_interrupted")
                && event.get("error") == run.get("error")
        }),
        _ => false,
    };
    if !status_is_consistent {
        return Err("Workflow Run status disagrees with its event history".into());
    }
    Ok(())
}

fn validate_replay(stored_run: &Value, events: &[(i64, Value)]) -> Result<(), String> {
    const REPLAY_ERR: &str = "Stored workflow Run event history does not replay to the stored Run";
    let stored_states = stored_run
        .get("nodeStates")
        .and_then(Value::as_object)
        .ok_or("Stored workflow Run nodeStates are invalid")?;
    let mut states = serde_json::Map::with_capacity(stored_states.len());
    for (node_id, stored_state) in stored_states {
        let mut initial_state = stored_state.clone();
        initial_state["status"] = Value::from("idle");
        initial_state["logs"] = Value::Array(Vec::new());
        initial_state["output"] = Value::Null;
        initial_state["error"] = Value::Null;
        states.insert(node_id.clone(), initial_state);
    }
    let mut status = "queued";
    let mut result = Value::Null;
    let mut error = Value::Null;
    let mut updated_at: Option<&str> = None;

    for (event_index, (_, event)) in events.iter().enumerate() {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or("Stored workflow Run event type is invalid")?;
        let timestamp = event
            .get("timestamp")
            .and_then(Value::as_str)
            .ok_or("Stored workflow Run event timestamp is invalid")?;
        updated_at = Some(timestamp);
        match event_type {
            "run_started" if status == "queued" => {
                if states
                    .values()
                    .any(|state| state.get("status").and_then(Value::as_str) == Some("running"))
                {
                    return Err(REPLAY_ERR.into());
                }
                status = "running";
            }
            "node_started" | "node_log" | "node_completed" | "node_failed" | "node_interrupted"
            | "node_skipped"
                if status == "running" =>
            {
                apply_node_event(&mut states, event, event_type).map_err(|_| REPLAY_ERR)?;
            }
            "run_completed" if status == "running" => {
                if states.values().any(|state| {
                    !matches!(
                        state.get("status").and_then(Value::as_str),
                        Some("success" | "skipped")
                    )
                }) {
                    return Err(REPLAY_ERR.into());
                }
                status = "success";
                result = event
                    .get("result")
                    .cloned()
                    .ok_or("Stored run_completed event is missing result")?;
            }
            "run_failed" | "run_cancelled" if status == "running" => {
                if states.values().any(|state| {
                    matches!(
                        state.get("status").and_then(Value::as_str),
                        Some("idle" | "running")
                    )
                }) {
                    return Err(REPLAY_ERR.into());
                }
                status = if event_type == "run_failed" {
                    "error"
                } else {
                    "cancelled"
                };
                error = event_error(event)?;
            }
            "run_interrupted"
                if matches!(status, "queued" | "running") && event_index + 1 == events.len() =>
            {
                status = "interrupted";
                error = event_error(event)?;
                apply_interrupted_node_states(&mut states, stored_states, event)
                    .map_err(|_| REPLAY_ERR)?;
            }
            _ => return Err(REPLAY_ERR.into()),
        }
    }

    if stored_run.get("status").and_then(Value::as_str) != Some(status)
        || stored_run.get("result") != Some(&result)
        || stored_run.get("error") != Some(&error)
        || stored_states != &states
    {
        return Err(REPLAY_ERR.into());
    }
    if let Some((_, last_event)) = events.last() {
        let last_ts = last_event.get("timestamp").and_then(Value::as_str);
        if updated_at != last_ts || stored_run.get("updatedAt").and_then(Value::as_str) != last_ts {
            return Err(REPLAY_ERR.into());
        }
    }
    Ok(())
}

fn apply_interrupted_node_states(
    states: &mut serde_json::Map<String, Value>,
    final_states: &serde_json::Map<String, Value>,
    event: &Value,
) -> Result<(), String> {
    let explicit_skipped_ids = event
        .get("skippedNodeIds")
        .and_then(Value::as_array)
        .map(|ids| {
            let mut unique = std::collections::HashSet::with_capacity(ids.len());
            ids.iter()
                .map(|id| {
                    id.as_str()
                        .filter(|id| unique.insert(*id))
                        .ok_or("Interrupted workflow skippedNodeIds are invalid")
                })
                .collect::<Result<std::collections::HashSet<_>, _>>()
        })
        .transpose()?;
    if let Some(ids) = &explicit_skipped_ids {
        for node_id in ids {
            if states
                .get(*node_id)
                .and_then(|state| state.get("status"))
                .and_then(Value::as_str)
                != Some("idle")
            {
                return Err("Interrupted workflow skippedNodeIds must reference idle nodes".into());
            }
        }
    }
    let err_val = event_error(event)?;
    for (node_id, state) in states.iter_mut() {
        let prior_status = state
            .get("status")
            .and_then(Value::as_str)
            .ok_or("Stored workflow node state is invalid")?;
        let should_skip = if let Some(skipped_ids) = &explicit_skipped_ids {
            skipped_ids.contains(node_id.as_str())
        } else {
            // Older interrupted events did not record which idle nodes were skipped.
            final_states
                .get(node_id)
                .and_then(|s| s.get("status"))
                .and_then(Value::as_str)
                == Some("skipped")
        };
        match prior_status {
            "running" => {
                state["status"] = Value::from("interrupted");
                state["error"] = err_val.clone();
            }
            "idle" if should_skip => {
                state["status"] = Value::from("skipped");
            }
            _ => {}
        }
    }
    Ok(())
}

fn apply_node_event(
    states: &mut serde_json::Map<String, Value>,
    event: &Value,
    event_type: &str,
) -> Result<(), String> {
    let node_id = event
        .get("nodeId")
        .and_then(Value::as_str)
        .ok_or("Stored workflow node event is missing nodeId")?;
    let state = states
        .get_mut(node_id)
        .ok_or("Stored workflow node event references an unknown node")?;
    let prior = state
        .get("status")
        .and_then(Value::as_str)
        .ok_or("Stored workflow node state is invalid")?;
    if (event_type == "node_started" && prior != "idle")
        || (event_type == "node_log" && prior != "running")
        || (event_type == "node_completed" && !matches!(prior, "idle" | "running"))
        || (event_type == "node_failed" && prior != "running")
        || (event_type == "node_interrupted" && prior != "running")
        || (event_type == "node_skipped" && prior != "idle")
    {
        return Err("Workflow node state does not match event".into());
    }
    match event_type {
        "node_started" => state["status"] = Value::from("running"),
        "node_log" => {
            let message = event
                .get("message")
                .and_then(Value::as_str)
                .ok_or("Stored node_log event is missing message")?;
            state
                .get_mut("logs")
                .and_then(Value::as_array_mut)
                .ok_or("Stored workflow node logs are invalid")?
                .push(Value::from(message));
        }
        "node_completed" => {
            state["status"] = Value::from("success");
            state["output"] = event
                .get("output")
                .cloned()
                .ok_or("Stored node_completed event is missing output")?;
            state["error"] = Value::Null;
        }
        "node_failed" | "node_interrupted" => {
            state["status"] = Value::from(if event_type == "node_failed" {
                "error"
            } else {
                "interrupted"
            });
            state["output"] = Value::Null;
            state["error"] = event_error(event)?;
        }
        "node_skipped" => {
            if event
                .get("reason")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err("Stored node_skipped event is missing its reason".into());
            }
            state["status"] = Value::from("skipped");
            state["logs"] = Value::Array(Vec::new());
            state["output"] = Value::Null;
            state["error"] = Value::Null;
        }
        _ => return Err("Unknown stored workflow node event".into()),
    }
    Ok(())
}

fn event_error(event: &Value) -> Result<Value, String> {
    event
        .get("error")
        .and_then(Value::as_str)
        .map(Value::from)
        .ok_or_else(|| "Stored workflow terminal event is missing error".into())
}

pub(super) fn validate_summary(run: &Value, index: &RunIndex<'_>) -> Result<(), String> {
    if run.get("id").and_then(Value::as_str) != Some(index.run_id)
        || run.get("workspaceId").and_then(Value::as_str) != Some(index.workspace_id)
        || run.get("workflowId").and_then(Value::as_str) != Some(index.workflow_id)
        || run.get("workflowRevision").and_then(Value::as_i64) != Some(index.workflow_revision)
        || run.get("status").and_then(Value::as_str) != Some(index.status)
        || run.get("updatedAt").and_then(Value::as_str) != Some(index.updated_at)
    {
        return Err("Workflow SQLite index disagrees with the stored Run".into());
    }
    Ok(())
}
