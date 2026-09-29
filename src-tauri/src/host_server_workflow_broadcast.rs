//! Multi-client workflow synchronization over the desktop Host WebSocket.

use crate::host_server::HostServer;
use crate::metadata_store::MetadataStore;
use crate::native_pi_manager::NativePiManager;
use crate::remote_auth::RemoteAuth;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_tungstenite::tungstenite::Message;

type HostSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

#[tokio::test]
async fn broadcasts_workflow_and_run_then_recovers_after_host_restart() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("pipline-workflow-broadcast-{nonce}"));
    let public = temp.join("public");
    fs::create_dir_all(&public).expect("create static directory");
    fs::write(public.join("index.html"), "Pipline workflow sync").expect("write index");

    let metadata = Arc::new(Mutex::new(
        MetadataStore::open(&temp.join("pipline.sqlite3")).expect("open workflow store"),
    ));
    let workspace_id = "shared-workspace";
    let workflow_id = format!("broadcast-{nonce}");
    let run_id = format!("run-broadcast-{nonce}");
    let auth_store = MetadataStore::open(&temp.join("auth.sqlite3")).expect("open auth store");
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(
        auth_store,
    )))));
    let host = HostServer::start_with_workspaces(
        public.clone(),
        NativePiManager::new(8),
        auth,
        std::collections::HashMap::new(),
        None,
        Some(metadata.clone()),
    )
    .await
    .expect("start Host server");

    let result = async {
        let ws_url = host.origin().replace("http://", "ws://") + "/v2/ws";
        let mut editor = connect_client(&ws_url, "workflow-editor-window").await?;
        let mut chat = connect_client(&ws_url, "workflow-chat-window").await?;
        let created_at = "2026-09-27T00:00:00.000Z";
        let workflow = json!({
            "schemaVersion": 1,
            "id": workflow_id,
            "workspaceId": workspace_id,
            "name": "Shared workflow",
            "revision": 0,
            "nodes": [
                {
                    "instanceId": "start",
                    "meta": { "id": "pipline.start", "version": "1.0.0" },
                    "position": { "x": 0, "y": 0 },
                    "paramValues": {}, "portValues": {}
                },
                {
                    "instanceId": "assign",
                    "meta": { "id": "pipline.assign", "version": "2.0.0" },
                    "position": { "x": 200, "y": 0 },
                    "paramValues": { "varName": "answer" }, "portValues": {}
                },
                {
                    "instanceId": "end",
                    "meta": { "id": "pipline.end", "version": "1.0.0" },
                    "position": { "x": 400, "y": 0 },
                    "paramValues": { "returnMode": "variable" }, "portValues": {}
                }
            ],
            "edges": [
                { "id": "start-assign", "sourceNodeId": "start", "sourcePort": "input", "targetNodeId": "assign", "targetPort": "value" },
                { "id": "assign-end", "sourceNodeId": "assign", "sourcePort": "output", "targetNodeId": "end", "targetPort": "result" }
            ],
            "createdAt": created_at,
            "updatedAt": created_at
        });
        send_json(
            &mut editor,
            json!({
                "type": "host_request",
                "requestId": "create-shared-workflow",
                "operation": "create_workflow",
                "workflow": workflow
            }),
        )
        .await?;
        let created = read_until(&mut editor, |frame| {
            frame["requestId"] == "create-shared-workflow"
        })
        .await?;
        if created["type"] != "host_response" || created["created"] != true {
            return Err(format!("Host did not create shared workflow: {created}"));
        }

        let change_event = read_until(&mut chat, |frame| {
            frame["type"] == "workflow_changed"
                && frame["workspaceId"] == workspace_id
                && frame["workflowId"] == workflow_id
        })
        .await?;
        if change_event["revision"] != 0 {
            return Err(format!("unexpected initial workflow event: {change_event}"));
        }

        let mut invalid_builtin_input = workflow.clone();
        invalid_builtin_input["revision"] = Value::from(1);
        invalid_builtin_input["updatedAt"] = Value::from("2026-09-27T00:00:01.000Z");
        invalid_builtin_input["nodes"][1]["meta"] = json!({
            "id": "pipline.extract",
            "version": "1.0.0"
        });
        invalid_builtin_input["nodes"][1]["paramValues"] = json!({ "path": "value" });
        invalid_builtin_input["nodes"][1]["portValues"] = json!({
            "source": { "mode": "static", "staticValue": "not an object" }
        });
        invalid_builtin_input["edges"] = json!([{
            "id": "extract-end",
            "sourceNodeId": "assign",
            "sourcePort": "value",
            "targetNodeId": "end",
            "targetPort": "result"
        }]);
        send_json(
            &mut editor,
            json!({
                "type": "host_request",
                "requestId": "reject-invalid-builtin-input",
                "operation": "compare_and_swap_workflow",
                "workflowId": workflow_id,
                "workspaceId": workspace_id,
                "expectedRevision": 0,
                "workflow": invalid_builtin_input,
                "event": {
                    "workflowId": workflow_id,
                    "workspaceId": workspace_id,
                    "revision": 1,
                    "schemaVersion": 1,
                    "actor": "user",
                    "timestamp": "2026-09-27T00:00:01.000Z",
                    "command": {
                        "type": "set_param",
                        "idempotencyKey": "workflow-broadcast-invalid-input"
                    }
                }
            }),
        )
        .await?;
        let rejected = read_until(&mut editor, |frame| {
            frame["requestId"] == "reject-invalid-builtin-input"
        })
        .await?;
        if rejected["type"] != "error"
            || !rejected["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("built-in input has an invalid value"))
        {
            return Err(format!("Host accepted an invalid built-in input: {rejected}"));
        }

        send_json(
            &mut chat,
            json!({
                "type": "host_request",
                "requestId": "load-after-rejected-input",
                "operation": "load_workflow",
                "workflowId": workflow_id,
                "workspaceId": workspace_id
            }),
        )
        .await?;
        let unchanged = read_until(&mut chat, |frame| {
            frame["requestId"] == "load-after-rejected-input"
        })
        .await?;
        if unchanged["record"]["workflow"]["revision"] != 0
            || unchanged["record"]["workflow"]["nodes"][1]["meta"]["id"] != "pipline.assign"
        {
            return Err(format!(
                "rejected built-in input changed Host workflow state: {unchanged}"
            ));
        }

        let mut revised = workflow;
        revised["name"] = Value::from("Changed from editor window");
        revised["revision"] = Value::from(1);
        revised["updatedAt"] = Value::from("2026-09-27T00:00:01.000Z");
        let event = json!({
            "workflowId": workflow_id,
            "workspaceId": workspace_id,
            "revision": 1,
            "schemaVersion": 1,
            "actor": "user",
            "timestamp": "2026-09-27T00:00:01.000Z",
            "command": {
                "type": "rename_workflow",
                "idempotencyKey": "workflow-broadcast-rename-1"
            }
        });
        send_json(
            &mut editor,
            json!({
                "type": "host_request",
                "requestId": "save-shared-workflow",
                "operation": "compare_and_swap_workflow",
                "workflowId": workflow_id,
                "workspaceId": workspace_id,
                "expectedRevision": 0,
                "workflow": revised,
                "event": event
            }),
        )
        .await?;
        let saved = read_until(&mut editor, |frame| {
            frame["requestId"] == "save-shared-workflow"
        })
        .await?;
        if saved["type"] != "host_response" || saved["saved"] != true {
            return Err(format!("Host did not save updated workflow: {saved}"));
        }

        let updated_event = read_until(&mut chat, |frame| {
            frame["type"] == "workflow_changed"
                && frame["workspaceId"] == workspace_id
                && frame["workflowId"] == workflow_id
                && frame["revision"] == 1
        })
        .await?;
        if updated_event["revision"] != 1 {
            return Err(format!(
                "chat window missed workflow revision: {updated_event}"
            ));
        }

        send_json(
            &mut chat,
            json!({
                "type": "host_request",
                "requestId": "reload-shared-workflow",
                "operation": "load_workflow",
                "workflowId": workflow_id,
                "workspaceId": workspace_id
            }),
        )
        .await?;
        let reloaded = read_until(&mut chat, |frame| {
            frame["requestId"] == "reload-shared-workflow"
        })
        .await?;
        if reloaded["record"]["workflow"]["revision"] != 1
            || reloaded["record"]["workflow"]["name"] != "Changed from editor window"
        {
            return Err(format!("chat window did not reload Host truth: {reloaded}"));
        }

        let snapshot = reloaded["record"]["workflow"].clone();
        let queued_run = json!({
            "schemaVersion": 1,
            "id": run_id,
            "workflowId": workflow_id,
            "workspaceId": workspace_id,
            "workflowRevision": 1,
            "snapshot": snapshot,
            "nodeMetaSnapshot": {
                "pipline.start@1.0.0": { "id": "pipline.start", "version": "1.0.0" },
                "pipline.assign@2.0.0": { "id": "pipline.assign", "version": "2.0.0" },
                "pipline.end@1.0.0": { "id": "pipline.end", "version": "1.0.0" }
            },
            "input": {},
            "maxConcurrency": 1,
            "status": "queued",
            "createdAt": "2026-09-27T00:00:02.000Z",
            "updatedAt": "2026-09-27T00:00:02.000Z",
            "nodeStates": {
                "start": { "status": "idle", "logs": [], "output": null, "error": null },
                "assign": { "status": "idle", "logs": [], "output": null, "error": null },
                "end": { "status": "idle", "logs": [], "output": null, "error": null }
            },
            "events": [],
            "result": null,
            "error": null
        });
        send_json(
            &mut editor,
            json!({
                "type": "host_request",
                "requestId": "create-shared-run",
                "operation": "create_workflow_run",
                "run": queued_run
            }),
        )
        .await?;
        let run_created = read_until(&mut editor, |frame| {
            frame["requestId"] == "create-shared-run"
        })
        .await?;
        if run_created["type"] != "host_response" || run_created["created"] != true {
            return Err(format!("Host did not create shared Run: {run_created}"));
        }
        let queued_broadcast = read_until(&mut chat, |frame| {
            frame["type"] == "workflow_run_changed"
                && frame["runId"] == run_id
                && frame["eventSequence"] == 0
        })
        .await?;
        if queued_broadcast["status"] != "queued" {
            return Err(format!(
                "chat window did not observe queued Run: {queued_broadcast}"
            ));
        }

        let mut running_run = queued_run.clone();
        running_run["status"] = Value::from("running");
        running_run["updatedAt"] = Value::from("2026-09-27T00:00:03.000Z");
        let run_event = json!({
            "id": format!("{run_id}:1"),
            "runId": run_id,
            "workflowId": workflow_id,
            "revision": 1,
            "type": "run_started",
            "timestamp": "2026-09-27T00:00:03.000Z",
            "sequence": 1
        });
        send_json(
            &mut editor,
            json!({
                "type": "host_request",
                "requestId": "append-shared-run-start",
                "operation": "append_workflow_run_event",
                "workflowId": run_id,
                "workspaceId": workspace_id,
                "expectedSequence": 0,
                "run": running_run,
                "event": run_event
            }),
        )
        .await?;
        let run_started = read_until(&mut editor, |frame| {
            frame["requestId"] == "append-shared-run-start"
        })
        .await?;
        if run_started["type"] != "host_response" || run_started["saved"] != true {
            return Err(format!("Host did not save Run start event: {run_started}"));
        }
        let run_broadcast = read_until(&mut chat, |frame| {
            frame["type"] == "workflow_run_changed"
                && frame["runId"] == run_id
                && frame["eventSequence"] == 1
        })
        .await?;
        if run_broadcast["status"] != "running" || run_broadcast["eventType"] != "run_started" {
            return Err(format!(
                "chat window missed active Run state: {run_broadcast}"
            ));
        }

        let mut start_completed_run = running_run.clone();
        start_completed_run["updatedAt"] = Value::from("2026-09-27T00:00:04.000Z");
        start_completed_run["nodeStates"]["start"]["status"] = Value::from("success");
        start_completed_run["nodeStates"]["start"]["output"] = json!({ "input": {} });
        send_json(
            &mut editor,
            json!({
                "type": "host_request",
                "requestId": "append-start-node-complete",
                "operation": "append_workflow_run_event",
                "workflowId": run_id,
                "workspaceId": workspace_id,
                "expectedSequence": 1,
                "run": start_completed_run,
                "event": {
                    "id": format!("{run_id}:2"), "runId": run_id,
                    "workflowId": workflow_id, "revision": 1,
                    "type": "node_completed", "timestamp": "2026-09-27T00:00:04.000Z",
                    "sequence": 2, "nodeId": "start", "output": { "input": {} }
                }
            }),
        )
        .await?;
        let start_completed = read_until(&mut editor, |frame| {
            frame["requestId"] == "append-start-node-complete"
        })
        .await?;
        if start_completed["type"] != "host_response" || start_completed["saved"] != true {
            return Err(format!(
                "Host did not save Start node completion: {start_completed}"
            ));
        }
        let start_broadcast = read_until(&mut chat, |frame| {
            frame["type"] == "workflow_run_changed"
                && frame["runId"] == run_id
                && frame["eventSequence"] == 2
        })
        .await?;
        if start_broadcast["eventType"] != "node_completed" {
            return Err(format!("chat missed Start completion: {start_broadcast}"));
        }

        let mut assign_started_run = start_completed_run.clone();
        assign_started_run["updatedAt"] = Value::from("2026-09-27T00:00:05.000Z");
        assign_started_run["nodeStates"]["assign"]["status"] = Value::from("running");
        send_json(
            &mut editor,
            json!({
                "type": "host_request",
                "requestId": "append-assign-node-start",
                "operation": "append_workflow_run_event",
                "workflowId": run_id,
                "workspaceId": workspace_id,
                "expectedSequence": 2,
                "run": assign_started_run,
                "event": {
                    "id": format!("{run_id}:3"), "runId": run_id,
                    "workflowId": workflow_id, "revision": 1,
                    "type": "node_started", "timestamp": "2026-09-27T00:00:05.000Z",
                    "sequence": 3, "nodeId": "assign", "nodeType": "assign"
                }
            }),
        )
        .await?;
        let assign_started = read_until(&mut editor, |frame| {
            frame["requestId"] == "append-assign-node-start"
        })
        .await?;
        if assign_started["type"] != "host_response" || assign_started["saved"] != true {
            return Err(format!(
                "Host did not save Assign node start: {assign_started}"
            ));
        }
        let assign_broadcast = read_until(&mut chat, |frame| {
            frame["type"] == "workflow_run_changed"
                && frame["runId"] == run_id
                && frame["eventSequence"] == 3
        })
        .await?;
        if assign_broadcast["eventType"] != "node_started" {
            return Err(format!("chat missed Assign start: {assign_broadcast}"));
        }
        send_json(
            &mut chat,
            json!({
                "type": "host_request",
                "requestId": "reload-shared-run",
                "operation": "load_workflow_run",
                "workflowId": run_id,
                "workspaceId": workspace_id
            }),
        )
        .await?;
        let reloaded_run =
            read_until(&mut chat, |frame| frame["requestId"] == "reload-shared-run").await?;
        if reloaded_run["record"]["run"]["status"] != "running"
            || reloaded_run["record"]["events"][1]["type"] != "node_completed"
            || reloaded_run["record"]["events"][2]["type"] != "node_started"
            || reloaded_run["record"]["run"]["nodeStates"]["assign"]["status"] != "running"
        {
            return Err(format!(
                "chat window did not reload authoritative Run: {reloaded_run}"
            ));
        }
        let _ = editor.close(None).await;
        let _ = chat.close(None).await;
        Ok::<String, String>(run_id.clone())
    }
    .await;

    let run_id = match result {
        Ok(run_id) => run_id,
        Err(error) => {
            host.stop().await;
            drop(metadata);
            let _ = fs::remove_dir_all(&temp);
            panic!("workflow broadcast integration smoke failed: {error}");
        }
    };
    host.stop().await;
    drop(metadata);

    let recovered_metadata = Arc::new(Mutex::new(
        MetadataStore::open(&temp.join("pipline.sqlite3")).expect("reopen workflow store"),
    ));
    let recovered_auth_store = MetadataStore::open(&temp.join("auth-restarted.sqlite3"))
        .expect("open restarted auth store");
    let recovered_auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(
        recovered_auth_store,
    )))));
    let recovered_host = HostServer::start_with_workspaces(
        public,
        NativePiManager::new(8),
        recovered_auth,
        std::collections::HashMap::new(),
        None,
        Some(recovered_metadata),
    )
    .await
    .expect("restart Host server");
    let recovery_result = async {
        let ws_url = recovered_host.origin().replace("http://", "ws://") + "/v2/ws";
        let mut reconnected_chat = connect_client(&ws_url, "workflow-chat-after-restart").await?;
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
        retry_run["retryOfRunId"] = Value::from(run_id.clone());
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
            || retry_reloaded["record"]["run"]["nodeStates"]["start"]["output"]["input"]
                != json!({})
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
        Ok::<(), String>(())
    }
    .await;
    recovered_host.stop().await;
    let cleanup = fs::remove_dir_all(&temp);
    if let Err(error) = recovery_result {
        panic!("workflow Run recovery smoke failed: {error}");
    }
    cleanup.expect("remove temporary workflow data");
}

async fn connect_client(url: &str, client_id: &str) -> Result<HostSocket, String> {
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

async fn send_json(socket: &mut HostSocket, value: Value) -> Result<(), String> {
    socket
        .send(Message::Text(value.to_string()))
        .await
        .map_err(|error| format!("send Host frame: {error}"))
}

async fn append_run_event(
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

async fn read_frame(socket: &mut HostSocket) -> Result<Value, String> {
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

async fn read_until<F>(socket: &mut HostSocket, mut predicate: F) -> Result<Value, String>
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
