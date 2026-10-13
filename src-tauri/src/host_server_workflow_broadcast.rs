//! Multi-client workflow synchronization over the desktop Host WebSocket.

use crate::host_server::HostServer;
use crate::metadata_store::MetadataStore;
use crate::native_pi_manager::NativePiManager;
use crate::remote_auth::RemoteAuth;
use serde_json::{json, Value};
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[path = "host_server_workflow_broadcast/recovery.rs"]
mod recovery;

use recovery::{
    append_run_event, connect_client, read_until, send_json, verify_recovered_run_and_retry,
};

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
        append_run_event(
            &mut editor,
            &run_id,
            workspace_id,
            0,
            running_run.clone(),
            json!({
                "id": format!("{run_id}:1"),
                "runId": run_id,
                "workflowId": workflow_id,
                "revision": 1,
                "type": "run_started",
                "timestamp": "2026-09-27T00:00:03.000Z",
                "sequence": 1
            }),
        )
        .await?;
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
        append_run_event(
            &mut editor,
            &run_id,
            workspace_id,
            1,
            start_completed_run.clone(),
            json!({
                "id": format!("{run_id}:2"), "runId": run_id,
                "workflowId": workflow_id, "revision": 1,
                "type": "node_completed", "timestamp": "2026-09-27T00:00:04.000Z",
                "sequence": 2, "nodeId": "start", "output": { "input": {} }
            }),
        )
        .await?;
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
        append_run_event(
            &mut editor,
            &run_id,
            workspace_id,
            2,
            assign_started_run,
            json!({
                "id": format!("{run_id}:3"), "runId": run_id,
                "workflowId": workflow_id, "revision": 1,
                "type": "node_started", "timestamp": "2026-09-27T00:00:05.000Z",
                "sequence": 3, "nodeId": "assign", "nodeType": "assign"
            }),
        )
        .await?;
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
    let ws_url = recovered_host.origin().replace("http://", "ws://") + "/v2/ws";
    let recovery_result =
        verify_recovered_run_and_retry(&ws_url, &run_id, workspace_id, &workflow_id).await;
    recovered_host.stop().await;
    let cleanup = fs::remove_dir_all(&temp);
    if let Err(error) = recovery_result {
        panic!("workflow Run recovery smoke failed: {error}");
    }
    cleanup.expect("remove temporary workflow data");
}
