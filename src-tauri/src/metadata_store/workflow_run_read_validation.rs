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
    let mut replayed = stored_run.clone();
    replayed["status"] = Value::from("queued");
    replayed["result"] = Value::Null;
    replayed["error"] = Value::Null;
    let states = replayed
        .get_mut("nodeStates")
        .and_then(Value::as_object_mut)
        .ok_or("Stored workflow Run nodeStates are invalid")?;
    for state in states.values_mut() {
        state["status"] = Value::from("idle");
        state["logs"] = Value::Array(Vec::new());
        state["output"] = Value::Null;
        state["error"] = Value::Null;
    }

    for (event_index, (_, event)) in events.iter().enumerate() {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or("Stored workflow Run event type is invalid")?;
        let timestamp = event
            .get("timestamp")
            .and_then(Value::as_str)
            .ok_or("Stored workflow Run event timestamp is invalid")?;
        let mut next = replayed.clone();
        next["updatedAt"] = Value::from(timestamp);
        match event_type {
            "run_started" if replayed["status"] == "queued" => {
                next["status"] = Value::from("running");
            }
            "node_started" | "node_log" | "node_completed" | "node_failed" | "node_interrupted"
            | "node_skipped"
                if replayed["status"] == "running" =>
            {
                apply_node_event(&mut next, event, event_type)?;
            }
            "run_completed" if replayed["status"] == "running" => {
                next["status"] = Value::from("success");
                next["result"] = event
                    .get("result")
                    .cloned()
                    .ok_or("Stored run_completed event is missing result")?;
            }
            "run_failed" if replayed["status"] == "running" => {
                next["status"] = Value::from("error");
                next["error"] = event_error(event)?;
            }
            "run_cancelled" if replayed["status"] == "running" => {
                next["status"] = Value::from("cancelled");
                next["error"] = event_error(event)?;
            }
            "run_interrupted"
                if matches!(replayed["status"].as_str(), Some("queued" | "running"))
                    && event_index + 1 == events.len() =>
            {
                next["status"] = Value::from("interrupted");
                next["error"] = event_error(event)?;
                apply_interrupted_node_states(&mut next, &replayed, stored_run, event)?;
            }
            _ => {
                return Err(
                    "Stored workflow Run event history does not replay to the stored Run".into(),
                )
            }
        }
        super::validate_workflow_run_event_state_delta(&replayed, &next, event_type, event)
            .map_err(|_| "Stored workflow Run event history does not replay to the stored Run")?;
        replayed = next;
    }

    for field in ["status", "result", "error", "nodeStates"] {
        if replayed.get(field) != stored_run.get(field) {
            return Err(
                "Stored workflow Run event history does not replay to the stored Run".into(),
            );
        }
    }
    if let Some((_, last_event)) = events.last() {
        if replayed.get("updatedAt") != last_event.get("timestamp")
            || stored_run.get("updatedAt") != last_event.get("timestamp")
        {
            return Err(
                "Stored workflow Run event history does not replay to the stored Run".into(),
            );
        }
    }
    Ok(())
}

fn apply_interrupted_node_states(
    next: &mut Value,
    previous: &Value,
    stored_run: &Value,
    event: &Value,
) -> Result<(), String> {
    let explicit_skipped_ids = event
        .get("skippedNodeIds")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).collect::<Vec<_>>());
    let previous_states = previous
        .get("nodeStates")
        .and_then(Value::as_object)
        .ok_or("Stored workflow Run nodeStates are invalid")?;
    let final_states = stored_run
        .get("nodeStates")
        .and_then(Value::as_object)
        .ok_or("Stored workflow Run nodeStates are invalid")?;
    let next_states = next
        .get_mut("nodeStates")
        .and_then(Value::as_object_mut)
        .ok_or("Stored workflow Run nodeStates are invalid")?;
    for (node_id, previous_state) in previous_states {
        let status = previous_state
            .get("status")
            .and_then(Value::as_str)
            .ok_or("Stored workflow node state is invalid")?;
        let should_skip = if let Some(skipped_ids) = &explicit_skipped_ids {
            skipped_ids.contains(&node_id.as_str())
        } else {
            // Older interrupted events did not record which idle nodes were skipped.
            final_states
                .get(node_id)
                .and_then(|state| state.get("status"))
                .and_then(Value::as_str)
                == Some("skipped")
        };
        let next_state = next_states
            .get_mut(node_id)
            .ok_or("Stored workflow Run nodeStates are invalid")?;
        match status {
            "running" => {
                next_state["status"] = Value::from("interrupted");
                next_state["error"] = event_error(event)?;
            }
            "idle" if should_skip => {
                next_state["status"] = Value::from("skipped");
            }
            _ => {}
        }
    }
    Ok(())
}

fn apply_node_event(next: &mut Value, event: &Value, event_type: &str) -> Result<(), String> {
    let node_id = event
        .get("nodeId")
        .and_then(Value::as_str)
        .ok_or("Stored workflow node event is missing nodeId")?;
    let state = next
        .pointer_mut(&format!("/nodeStates/{}", escape_pointer_segment(node_id)))
        .ok_or("Stored workflow node event references an unknown node")?;
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

fn escape_pointer_segment(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
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
