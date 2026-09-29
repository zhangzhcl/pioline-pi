use super::{read_until, send_json};
use serde_json::{json, Value};

type HostWebSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const RUN_ID: &str = "run-manual-smoke";

pub(super) async fn persist_active_run(
    socket: &mut HostWebSocket,
    workflow_id: &str,
    workspace_id: &str,
    workflow_snapshot: &Value,
) -> Result<Value, String> {
    let run = json!({
        "schemaVersion": 1,
        "id": RUN_ID,
        "workflowId": workflow_id,
        "workspaceId": workspace_id,
        "workflowRevision": workflow_snapshot["revision"],
        "snapshot": workflow_snapshot,
        "nodeMetaSnapshot": {
            "pipline.start@1.0.0": { "id": "pipline.start", "version": "1.0.0" },
            "pipline.assign@2.0.0": { "id": "pipline.assign", "version": "2.0.0" },
            "pipline.end@1.0.0": { "id": "pipline.end", "version": "1.0.0" }
        },
        "input": { "topic": "smoke request" },
        "maxConcurrency": 1,
        "status": "queued",
        "createdAt": "2026-09-29T12:00:00.000Z",
        "updatedAt": "2026-09-29T12:00:00.000Z",
        "nodeStates": {
            "start": { "status": "idle", "logs": [], "output": null, "error": null },
            "manual-assign": { "status": "idle", "logs": [], "output": null, "error": null },
            "end": { "status": "idle", "logs": [], "output": null, "error": null }
        },
        "events": [],
        "result": null,
        "error": null
    });
    send_json(
        socket,
        json!({
            "type": "host_request",
            "requestId": "create-manual-smoke-run",
            "operation": "create_workflow_run",
            "run": run
        }),
    )
    .await?;
    let created = read_until(socket, |frame| {
        frame["requestId"] == "create-manual-smoke-run"
    })
    .await?;
    if created["type"] != "host_response" || created["created"] != true {
        return Err(format!(
            "Host rejected the manual workflow smoke Run: {created}"
        ));
    }

    let mut running = run.clone();
    running["status"] = Value::from("running");
    running["updatedAt"] = Value::from("2026-09-29T12:00:01.000Z");
    append_event(
        socket,
        workspace_id,
        0,
        running.clone(),
        json!({
            "id": format!("{RUN_ID}:1"), "runId": RUN_ID, "workflowId": workflow_id,
            "revision": workflow_snapshot["revision"], "type": "run_started",
            "timestamp": "2026-09-29T12:00:01.000Z", "sequence": 1
        }),
        "start-manual-smoke-run",
    )
    .await?;

    let mut start_completed = running.clone();
    start_completed["updatedAt"] = Value::from("2026-09-29T12:00:02.000Z");
    start_completed["nodeStates"]["start"]["status"] = Value::from("success");
    start_completed["nodeStates"]["start"]["output"] = json!({
        "input": { "topic": "smoke request" }
    });
    append_event(
        socket,
        workspace_id,
        1,
        start_completed.clone(),
        json!({
            "id": format!("{RUN_ID}:2"), "runId": RUN_ID, "workflowId": workflow_id,
            "revision": workflow_snapshot["revision"], "type": "node_completed",
            "timestamp": "2026-09-29T12:00:02.000Z", "sequence": 2,
            "nodeId": "start", "output": { "input": { "topic": "smoke request" } }, "error": null
        }),
        "complete-manual-smoke-start",
    )
    .await?;

    let mut assign_running = start_completed;
    assign_running["updatedAt"] = Value::from("2026-09-29T12:00:03.000Z");
    assign_running["nodeStates"]["manual-assign"]["status"] = Value::from("running");
    append_event(
        socket,
        workspace_id,
        2,
        assign_running,
        json!({
            "id": format!("{RUN_ID}:3"), "runId": RUN_ID, "workflowId": workflow_id,
            "revision": workflow_snapshot["revision"], "type": "node_started",
            "timestamp": "2026-09-29T12:00:03.000Z", "sequence": 3,
            "nodeId": "manual-assign", "nodeType": "assign"
        }),
        "start-manual-smoke-assign",
    )
    .await?;

    send_json(
        socket,
        json!({
            "type": "host_request",
            "requestId": "reload-manual-smoke-run",
            "operation": "load_workflow_run",
            "workflowId": RUN_ID,
            "workspaceId": workspace_id
        }),
    )
    .await?;
    let loaded = read_until(socket, |frame| {
        frame["requestId"] == "reload-manual-smoke-run"
    })
    .await?;
    let record = loaded
        .get("record")
        .filter(|record| record.is_object())
        .ok_or_else(|| format!("Host did not reload the manual workflow Run: {loaded}"))?;
    if record["run"]["status"] != "running"
        || record["run"]["nodeStates"]["manual-assign"]["status"] != "running"
        || record["events"].as_array().map(Vec::len) != Some(3)
    {
        return Err(format!(
            "Host did not reload the active workflow Run state: {record}"
        ));
    }
    Ok(record.clone())
}

pub(super) async fn cancel_active_run(
    socket: &mut HostWebSocket,
    workspace_id: &str,
    run_record: &Value,
) -> Result<(), String> {
    let run_id = run_record["run"]["id"]
        .as_str()
        .ok_or("Host Run record omitted its id")?;
    let workflow_id = run_record["run"]["workflowId"]
        .as_str()
        .ok_or("Host Run record omitted its workflow id")?;
    let revision = run_record["run"]["workflowRevision"].clone();
    let terminal_error = "Integration smoke stopped after Agent read the active Run.";

    let mut interrupted = run_record["run"].clone();
    interrupted["updatedAt"] = Value::from("2026-09-29T12:00:04.000Z");
    interrupted["nodeStates"]["manual-assign"]["status"] = Value::from("interrupted");
    interrupted["nodeStates"]["manual-assign"]["error"] = Value::from(terminal_error);
    append_event(
        socket,
        workspace_id,
        3,
        interrupted.clone(),
        json!({
            "id": format!("{run_id}:4"), "runId": run_id, "workflowId": workflow_id,
            "revision": revision, "type": "node_interrupted",
            "timestamp": "2026-09-29T12:00:04.000Z", "sequence": 4,
            "nodeId": "manual-assign", "error": terminal_error
        }),
        "interrupt-manual-smoke-assign",
    )
    .await?;

    let mut skipped = interrupted;
    skipped["updatedAt"] = Value::from("2026-09-29T12:00:05.000Z");
    skipped["nodeStates"]["end"]["status"] = Value::from("skipped");
    append_event(
        socket,
        workspace_id,
        4,
        skipped.clone(),
        json!({
            "id": format!("{run_id}:5"), "runId": run_id, "workflowId": workflow_id,
            "revision": revision, "type": "node_skipped",
            "timestamp": "2026-09-29T12:00:05.000Z", "sequence": 5,
            "nodeId": "end", "reason": "Smoke Run cancelled before End started."
        }),
        "skip-manual-smoke-end",
    )
    .await?;

    let mut cancelled = skipped;
    cancelled["status"] = Value::from("cancelled");
    cancelled["updatedAt"] = Value::from("2026-09-29T12:00:06.000Z");
    cancelled["error"] = Value::from(terminal_error);
    append_event(
        socket,
        workspace_id,
        5,
        cancelled,
        json!({
            "id": format!("{run_id}:6"), "runId": run_id, "workflowId": workflow_id,
            "revision": revision, "type": "run_cancelled",
            "timestamp": "2026-09-29T12:00:06.000Z", "sequence": 6,
            "error": terminal_error
        }),
        "cancel-manual-smoke-run",
    )
    .await
}

async fn append_event(
    socket: &mut HostWebSocket,
    workspace_id: &str,
    expected_sequence: i64,
    run: Value,
    event: Value,
    request_id: &str,
) -> Result<(), String> {
    send_json(
        socket,
        json!({
            "type": "host_request",
            "requestId": request_id,
            "operation": "append_workflow_run_event",
            "workflowId": RUN_ID,
            "workspaceId": workspace_id,
            "expectedSequence": expected_sequence,
            "run": run,
            "event": event
        }),
    )
    .await?;
    let response = read_until(socket, |frame| frame["requestId"] == request_id).await?;
    if response["type"] != "host_response" || response["saved"] != true {
        return Err(format!(
            "Host rejected workflow Run event {request_id}: {response}"
        ));
    }
    Ok(())
}

pub(super) fn agent_workflow_read_result(workflow: &Value, run_record: &Value) -> Value {
    let nodes = workflow["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|node| {
            let meta_id = node["meta"]["id"].as_str().unwrap_or_default();
            let label = match meta_id {
                "pipline.start" => "Start",
                "pipline.assign" => "Assign",
                "pipline.end" => "End",
                _ => node["instanceId"].as_str().unwrap_or("Node"),
            };
            json!({
                "instanceId": node["instanceId"],
                "meta": node["meta"],
                "label": label,
                "params": node["paramValues"],
                "portValues": node["portValues"]
            })
        })
        .collect::<Vec<_>>();
    let edges = workflow["edges"].as_array().cloned().unwrap_or_default();
    let run = &run_record["run"];
    let node_states = run["nodeStates"].as_object();
    let succeeded = node_states
        .into_iter()
        .flat_map(|states| states.values())
        .filter(|state| state["status"] == "success")
        .count();
    let running = node_states
        .into_iter()
        .flat_map(|states| states.values())
        .filter(|state| state["status"] == "running")
        .count();
    let waiting = node_states
        .into_iter()
        .flat_map(|states| states.values())
        .filter(|state| state["status"] == "idle")
        .count();
    let active_nodes = nodes
        .iter()
        .filter(|node| {
            run["nodeStates"][node["instanceId"].as_str().unwrap_or_default()]["status"]
                == "running"
        })
        .map(|node| {
            json!({
                "instanceId": node["instanceId"],
                "label": node["label"],
                "type": node["meta"]["id"]
            })
        })
        .collect::<Vec<_>>();
    let run_nodes = nodes
        .iter()
        .map(|node| {
            let instance_id = node["instanceId"].as_str().unwrap_or_default();
            let state = &run["nodeStates"][instance_id];
            json!({
                "instanceId": node["instanceId"],
                "label": node["label"],
                "type": node["meta"]["id"],
                "status": state["status"],
                "output": state["output"]
            })
        })
        .collect::<Vec<_>>();
    let recent_events = run_record["events"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|event| {
            json!({
                "type": event["type"],
                "nodeId": event["nodeId"]
            })
        })
        .collect::<Vec<_>>();

    json!({
        "ok": true,
        "workflow": {
            "id": workflow["id"],
            "name": workflow["name"],
            "workspaceId": workflow["workspaceId"],
            "revision": workflow["revision"],
            "nodes": nodes,
            "edges": edges,
            "graph": {
                "revision": workflow["revision"],
                "totalNodes": nodes.len(),
                "totalEdges": edges.len(),
                "nodeOffset": 0,
                "edgeOffset": 0,
                "itemLimit": 25,
                "nextNodeOffset": null,
                "nextEdgeOffset": null
            }
        },
        "run": {
            "id": run["id"],
            "status": run["status"],
            "workflowRevision": run["workflowRevision"],
            "maxConcurrency": run["maxConcurrency"],
            "progress": {
                "total": nodes.len(), "running": running, "waiting": waiting,
                "succeeded": succeeded, "failed": 0, "skipped": 0, "interrupted": 0
            },
            "activeNodes": active_nodes,
            "nodes": run_nodes,
            "recentEvents": recent_events
        }
    })
}
