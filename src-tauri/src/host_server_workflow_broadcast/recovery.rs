use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

pub(super) type HostSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub(super) async fn verify_recovered_run_and_retry(
    ws_url: &str,
    run_id: &str,
    workspace_id: &str,
    workflow_id: &str,
) -> Result<(), String> {
    let mut reconnected_chat = connect_client(ws_url, "workflow-chat-after-restart").await?;
    send_json(
        &mut reconnected_chat,
        json!({
            "type": "host_request",
            "requestId": "load-run-after-host-restart",
            "operation": "load_workflow_run",
            "workflowId": run_id,
            "workspaceId": workspace_id
        }),
    )
    .await?;
    let recovered = read_until(&mut reconnected_chat, |frame| {
        frame["requestId"] == "load-run-after-host-restart"
    })
    .await?;
    if recovered["record"]["run"]["status"] != "interrupted"
        || recovered["record"]["events"][0]["type"] != "run_started"
        || recovered["record"]["events"][1]["type"] != "node_completed"
        || recovered["record"]["events"][2]["type"] != "node_started"
        || recovered["record"]["events"][3]["type"] != "run_interrupted"
        || recovered["record"]["events"][3]["sequence"] != 4
        || recovered["record"]["run"]["nodeStates"]["assign"]["status"] != "interrupted"
        || recovered["record"]["run"]["nodeStates"]["end"]["status"] != "idle"
    {
        return Err(format!(
            "Host restart did not recover Run as interrupted: {recovered}"
        ));
    }
    let retry_id = format!("{run_id}-retry");
    let mut retry_run = recovered["record"]["run"].clone();
    retry_run["id"] = Value::from(retry_id.clone());
    retry_run["status"] = Value::from("queued");
    retry_run["error"] = Value::Null;
    retry_run["result"] = Value::Null;
    retry_run["createdAt"] = Value::from("2026-09-27T00:00:06.000Z");
    retry_run["updatedAt"] = retry_run["createdAt"].clone();
    retry_run["events"] = json!([]);
    retry_run["retryOfRunId"] = Value::from(run_id);
    retry_run["resumeFromNodeId"] = Value::from("assign");
    retry_run["retrySeedStates"] = json!({
        "start": {
            "status": "success",
            "output": { "input": {} }
        }
    });
    for state in retry_run["nodeStates"]
        .as_object_mut()
        .unwrap()
        .values_mut()
    {
        *state = json!({ "status": "idle", "logs": [], "output": null, "error": null });
    }
    send_json(
        &mut reconnected_chat,
        json!({
            "type": "host_request",
            "requestId": "create-retry-after-restart",
            "operation": "create_workflow_run",
            "run": retry_run
        }),
    )
    .await?;
    let retry_created = read_until(&mut reconnected_chat, |frame| {
        frame["requestId"] == "create-retry-after-restart"
    })
    .await?;
    if retry_created["type"] != "host_response" || retry_created["created"] != true {
        return Err(format!(
            "Host refused retry after recovered Run: {retry_created}"
        ));
    }

    let mut retry_running = retry_run.clone();
    retry_running["status"] = Value::from("running");
    retry_running["updatedAt"] = Value::from("2026-09-27T00:00:07.000Z");
    send_json(
        &mut reconnected_chat,
        json!({
            "type": "host_request",
            "requestId": "append-retry-run-start",
            "operation": "append_workflow_run_event",
            "workflowId": retry_id,
            "workspaceId": workspace_id,
            "expectedSequence": 0,
            "run": retry_running,
            "event": {
                "id": format!("{retry_id}:1"), "runId": retry_id,
                "workflowId": workflow_id, "revision": 1,
                "type": "run_started", "timestamp": "2026-09-27T00:00:07.000Z",
                "sequence": 1, "retryOfRunId": run_id, "resumeFromNodeId": "assign"
            }
        }),
    )
    .await?;
    let retry_started = read_until(&mut reconnected_chat, |frame| {
        frame["requestId"] == "append-retry-run-start"
    })
    .await?;
    if retry_started["type"] != "host_response" || retry_started["saved"] != true {
        return Err(format!("Host did not persist retry start: {retry_started}"));
    }

    let mut reused_start = retry_running;
    reused_start["updatedAt"] = Value::from("2026-09-27T00:00:08.000Z");
    reused_start["nodeStates"]["start"]["status"] = Value::from("success");
    reused_start["nodeStates"]["start"]["output"] = json!({ "input": {} });
    send_json(
        &mut reconnected_chat,
        json!({
            "type": "host_request",
            "requestId": "append-reused-start-output",
            "operation": "append_workflow_run_event",
            "workflowId": retry_id,
            "workspaceId": workspace_id,
            "expectedSequence": 1,
            "run": reused_start,
            "event": {
                "id": format!("{retry_id}:2"), "runId": retry_id,
                "workflowId": workflow_id, "revision": 1,
                "type": "node_completed", "timestamp": "2026-09-27T00:00:08.000Z",
                "sequence": 2, "nodeId": "start", "output": { "input": {} },
                "reusedFromRunId": run_id
            }
        }),
    )
    .await?;
    let reused_start_saved = read_until(&mut reconnected_chat, |frame| {
        frame["requestId"] == "append-reused-start-output"
    })
    .await?;
    if reused_start_saved["type"] != "host_response" || reused_start_saved["saved"] != true {
        return Err(format!(
            "Host did not persist reused Start output: {reused_start_saved}"
        ));
    }
    send_json(
        &mut reconnected_chat,
        json!({
            "type": "host_request",
            "requestId": "reload-retry-after-restart",
            "operation": "load_workflow_run",
            "workflowId": retry_id,
            "workspaceId": workspace_id
        }),
    )
    .await?;
    let retry_reloaded = read_until(&mut reconnected_chat, |frame| {
        frame["requestId"] == "reload-retry-after-restart"
    })
    .await?;
    if retry_reloaded["record"]["run"]["status"] != "running"
        || retry_reloaded["record"]["run"]["nodeStates"]["start"]["status"] != "success"
        || retry_reloaded["record"]["run"]["nodeStates"]["start"]["output"]["input"] != json!({})
        || retry_reloaded["record"]["events"][1]["reusedFromRunId"] != run_id
        || retry_reloaded["record"]["events"].as_array().unwrap().len() != 2
    {
        return Err(format!(
            "Host did not reload retry snapshot and events: {retry_reloaded}"
        ));
    }
    let mut assign_started_run = reused_start.clone();
    assign_started_run["updatedAt"] = Value::from("2026-09-27T00:00:09.000Z");
    assign_started_run["nodeStates"]["assign"]["status"] = Value::from("running");
    append_run_event(
        &mut reconnected_chat,
        &retry_id,
        workspace_id,
        2,
        assign_started_run.clone(),
        json!({
            "id": format!("{retry_id}:3"), "runId": retry_id,
            "workflowId": workflow_id, "revision": 1,
            "type": "node_started", "timestamp": "2026-09-27T00:00:09.000Z",
            "sequence": 3, "nodeId": "assign", "nodeType": "assign"
        }),
    )
    .await?;

    let assign_output = json!({ "output": { "answer": { "input": {} } } });
    let mut assign_completed_run = assign_started_run;
    assign_completed_run["updatedAt"] = Value::from("2026-09-27T00:00:10.000Z");
    assign_completed_run["nodeStates"]["assign"]["status"] = Value::from("success");
    assign_completed_run["nodeStates"]["assign"]["output"] = assign_output.clone();
    append_run_event(
        &mut reconnected_chat,
        &retry_id,
        workspace_id,
        3,
        assign_completed_run.clone(),
        json!({
            "id": format!("{retry_id}:4"), "runId": retry_id,
            "workflowId": workflow_id, "revision": 1,
            "type": "node_completed", "timestamp": "2026-09-27T00:00:10.000Z",
            "sequence": 4, "nodeId": "assign", "output": assign_output
        }),
    )
    .await?;

    let end_output = json!({ "result": { "answer": { "input": {} } } });
    let mut end_completed_run = assign_completed_run;
    end_completed_run["updatedAt"] = Value::from("2026-09-27T00:00:11.000Z");
    end_completed_run["nodeStates"]["end"]["status"] = Value::from("success");
    end_completed_run["nodeStates"]["end"]["output"] = end_output.clone();
    append_run_event(
        &mut reconnected_chat,
        &retry_id,
        workspace_id,
        4,
        end_completed_run.clone(),
        json!({
            "id": format!("{retry_id}:5"), "runId": retry_id,
            "workflowId": workflow_id, "revision": 1,
            "type": "node_completed", "timestamp": "2026-09-27T00:00:11.000Z",
            "sequence": 5, "nodeId": "end", "output": end_output
        }),
    )
    .await?;

    let run_result = json!({ "answer": { "input": {} } });
    let mut retry_completed = end_completed_run;
    retry_completed["status"] = Value::from("success");
    retry_completed["result"] = run_result.clone();
    retry_completed["updatedAt"] = Value::from("2026-09-27T00:00:12.000Z");
    append_run_event(
        &mut reconnected_chat,
        &retry_id,
        workspace_id,
        5,
        retry_completed,
        json!({
            "id": format!("{retry_id}:6"), "runId": retry_id,
            "workflowId": workflow_id, "revision": 1,
            "type": "run_completed", "timestamp": "2026-09-27T00:00:12.000Z",
            "sequence": 6, "result": run_result
        }),
    )
    .await?;

    send_json(
        &mut reconnected_chat,
        json!({
            "type": "host_request",
            "requestId": "reload-completed-retry-after-restart",
            "operation": "load_workflow_run",
            "workflowId": retry_id,
            "workspaceId": workspace_id
        }),
    )
    .await?;
    let completed_retry = read_until(&mut reconnected_chat, |frame| {
        frame["requestId"] == "reload-completed-retry-after-restart"
    })
    .await?;
    if completed_retry["record"]["run"]["status"] != "success"
        || completed_retry["record"]["run"]["result"] != run_result
        || completed_retry["record"]["events"][5]["type"] != "run_completed"
        || completed_retry["record"]["events"]
            .as_array()
            .unwrap()
            .len()
            != 6
    {
        return Err(format!(
            "Host did not reload completed retry result: {completed_retry}"
        ));
    }

    let mut next_run = retry_run;
    next_run["id"] = Value::from(format!("{run_id}-after-retry"));
    next_run["retrySeedStates"] = Value::Null;
    next_run["retryOfRunId"] = Value::Null;
    next_run["resumeFromNodeId"] = Value::Null;
    next_run["createdAt"] = Value::from("2026-09-27T00:00:13.000Z");
    next_run["updatedAt"] = next_run["createdAt"].clone();
    send_json(
        &mut reconnected_chat,
        json!({
            "type": "host_request",
            "requestId": "create-run-after-completion",
            "operation": "create_workflow_run",
            "run": next_run
        }),
    )
    .await?;
    let created_after_completion = read_until(&mut reconnected_chat, |frame| {
        frame["requestId"] == "create-run-after-completion"
    })
    .await?;
    if created_after_completion["type"] != "host_response"
        || created_after_completion["created"] != true
    {
        return Err(format!(
            "Host did not release active Run lock after completion: {created_after_completion}"
        ));
    }
    let _ = reconnected_chat.close(None).await;
    Ok(())
}

pub(super) async fn connect_client(url: &str, client_id: &str) -> Result<HostSocket, String> {
    let (mut socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|error| format!("connect WebSocket client {client_id}: {error}"))?;
    send_json(
        &mut socket,
        json!({
            "type": "hello",
            "protocolVersion": 2,
            "clientType": "desktop",
            "clientId": client_id
        }),
    )
    .await?;
    let hello = read_frame(&mut socket).await?;
    if hello["type"] != "hello_ack" {
        return Err(format!("client {client_id} handshake failed: {hello}"));
    }
    Ok(socket)
}

pub(super) async fn send_json(socket: &mut HostSocket, value: Value) -> Result<(), String> {
    socket
        .send(Message::Text(value.to_string()))
        .await
        .map_err(|error| format!("send Host frame: {error}"))
}

pub(super) async fn append_run_event(
    socket: &mut HostSocket,
    run_id: &str,
    workspace_id: &str,
    expected_sequence: u64,
    run: Value,
    event: Value,
) -> Result<(), String> {
    let sequence = expected_sequence + 1;
    let request_id = format!("append-{run_id}-{sequence}");
    send_json(
        socket,
        json!({
            "type": "host_request",
            "requestId": request_id,
            "operation": "append_workflow_run_event",
            "workflowId": run_id,
            "workspaceId": workspace_id,
            "expectedSequence": expected_sequence,
            "run": run,
            "event": event
        }),
    )
    .await?;
    let response = read_until(socket, |frame| frame["requestId"] == request_id).await?;
    if response["type"] != "host_response" || response["saved"] != true {
        return Err(format!("Host did not persist Run event: {response}"));
    }
    Ok(())
}

pub(super) async fn read_frame(socket: &mut HostSocket) -> Result<Value, String> {
    let message = tokio::time::timeout(std::time::Duration::from_secs(10), socket.next())
        .await
        .map_err(|_| "timed out waiting for Host frame".to_string())?
        .ok_or_else(|| "Host WebSocket closed".to_string())?
        .map_err(|error| format!("read Host frame: {error}"))?;
    serde_json::from_str(
        message
            .to_text()
            .map_err(|error| format!("non-text Host frame: {error}"))?,
    )
    .map_err(|error| format!("decode Host frame: {error}"))
}

pub(super) async fn read_until<F>(
    socket: &mut HostSocket,
    mut predicate: F,
) -> Result<Value, String>
where
    F: FnMut(&Value) -> bool,
{
    loop {
        let frame = read_frame(socket).await?;
        if predicate(&frame) {
            return Ok(frame);
        }
    }
}
