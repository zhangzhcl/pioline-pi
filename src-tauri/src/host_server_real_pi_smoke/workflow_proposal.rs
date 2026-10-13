use super::fake_providers::{fake_workflow_chat_completion, FakeWorkflowProviderState};
use super::node_meta_proposal::verify_node_meta_and_workflow_history;
use super::workflow_run;
use super::{read_frame, read_through_agent_end, read_until, read_until_collect_events, send_json};
use crate::host_server::HostServer;
use crate::metadata_store::MetadataStore;
use crate::native_pi_manager::{NativeLaunchSpec, NativePiManager};
use crate::remote_auth::RemoteAuth;
use crate::runtime_coordinator::RuntimeTarget;
use axum::routing::post;
use axum::Router;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub(super) async fn run_workflow_proposal_smoke(
    temp: &Path,
    public: &Path,
    pi_agent_dir: &Path,
    workspace: &Path,
) -> Result<(), String> {
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("bind fake workflow model provider: {error}"))?;
    let provider_address = provider_listener
        .local_addr()
        .map_err(|error| format!("read fake provider address: {error}"))?;
    let provider_state = FakeWorkflowProviderState {
        request_count: Arc::new(AtomicUsize::new(0)),
        received_workflow_tool: Arc::new(AtomicBool::new(false)),
        next_response_is_tool_call: Arc::new(AtomicBool::new(true)),
        received_manual_workflow_read: Arc::new(AtomicBool::new(false)),
        received_active_run_summary: Arc::new(AtomicBool::new(false)),
        proposal: Arc::new(Mutex::new(json!({
            "operation": "read",
            "workflowNodeOffset": 0,
            "workflowEdgeOffset": 0,
            "workflowItemLimit": 25
        }))),
    };
    let provider_observed = provider_state.clone();
    let provider_task = tokio::spawn(async move {
        let app = Router::new()
            .route("/v1/chat/completions", post(fake_workflow_chat_completion))
            .with_state(provider_state);
        axum::serve(provider_listener, app).await
    });
    fs::write(
        pi_agent_dir.join("models.json"),
        serde_json::to_vec(&json!({
            "providers": {
                "pipline-workflow-host-smoke": {
                    "baseUrl": format!("http://{provider_address}/v1"),
                    "api": "openai-completions",
                    "apiKey": "pipline-workflow-host-smoke-key",
                    "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
                    "models": [{
                        "id": "workflow-host-smoke-model",
                        "name": "Pipline Workflow Host Smoke Model",
                        "reasoning": false,
                        "input": ["text"],
                        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
                        "contextWindow": 8192,
                        "maxTokens": 256
                    }]
                }
            }
        }))
        .map_err(|error| format!("encode fake workflow provider model: {error}"))?,
    )
    .map_err(|error| format!("write isolated workflow models: {error}"))?;
    fs::write(
        pi_agent_dir.join("settings.json"),
        br#"{"defaultProvider":"pipline-workflow-host-smoke","defaultModel":"workflow-host-smoke-model","defaultTools":["read","write"]}"#,
    )
    .map_err(|error| format!("write isolated workflow settings: {error}"))?;

    let metadata = Arc::new(Mutex::new(
        MetadataStore::open(&temp.join("pipline.sqlite3"))
            .map_err(|error| format!("open workflow metadata store: {error}"))?,
    ));
    let workspace_id = metadata
        .lock()
        .map_err(|_| "workflow metadata store is poisoned".to_owned())?
        .workspace_id_for_path(workspace)
        .map_err(|error| format!("create workflow workspace id: {error}"))?;
    let auth_store = MetadataStore::open(&temp.join("auth.sqlite3"))
        .map_err(|error| format!("open auth metadata store: {error}"))?;
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(
        auth_store,
    )))));
    let manager = NativePiManager::new(8);
    let target = RuntimeTarget::new(
        workspace_id.clone(),
        "workflow-host-smoke-session",
        "workflow-host-smoke-instance",
    );
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let binary = root
        .join("src-tauri")
        .join("resources")
        .join("pi")
        .join(if cfg!(windows) { "pi.exe" } else { "pi" });
    let extension = root
        .join("extensions")
        .join("dist")
        .join("picot-bridge.mjs");
    if !binary.is_file() || !extension.is_file() {
        provider_task.abort();
        return Err(format!(
            "required embedded runtime or bridge is missing (Pi: {}, extension: {})",
            binary.display(),
            extension.display()
        ));
    }
    let launch_spec = NativeLaunchSpec {
        binary,
        cwd: workspace.to_path_buf(),
        session_path: Some(temp.join("workflow-session.jsonl")),
        extensions: vec![extension],
        pi_version: env!("PI_STUDIO_PI_VERSION_BUNDLED").to_owned(),
        path_env: std::env::var("PATH").unwrap_or_default(),
        approve: true,
        windows_powershell_fallback: false,
    };
    manager
        .spawn(target.clone(), &launch_spec)
        .map_err(|error| format!("spawn Pi with Pipline workflow extension: {error}"))?;
    let host = HostServer::start_with_workspaces(
        public.to_path_buf(),
        manager.clone(),
        auth,
        std::collections::HashMap::new(),
        None,
        Some(metadata),
    )
    .await
    .map_err(|error| format!("start Host for Pi workflow smoke: {error}"))?;
    let outcome = async {
        let ws_url = host.origin().replace("http://", "ws://") + "/v2/ws";
        let (mut socket, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|error| format!("connect workflow Host websocket: {error}"))?;
        send_json(
            &mut socket,
            json!({
                "type": "hello", "protocolVersion": 2,
                "clientType": "desktop", "clientId": "pi-workflow-host-smoke"
            }),
        )
        .await?;
        if read_frame(&mut socket)
            .await
            .map_err(|error| format!("receive Host hello_ack: {error}"))?["type"]
            != "hello_ack"
        {
            return Err("Host rejected workflow smoke client handshake".into());
        }
        send_json(
            &mut socket,
            json!({ "type": "runtime_subscribe", "requestId": "subscribe-workflow-smoke", "target": target }),
        )
        .await?;
        let subscribed = read_until(&mut socket, |frame| frame["requestId"] == "subscribe-workflow-smoke")
            .await
            .map_err(|error| format!("subscribe Pi workflow Runtime: {error}"))?;
        if subscribed["type"] != "runtime_subscribed" {
            return Err(format!("Host rejected Pi workflow runtime subscription: {subscribed}"));
        }

        let workflow_id = "agent-proposal-workflow";
        let created_at = "2026-09-28T00:00:00.000Z";
        let workflow = json!({
            "schemaVersion": 1,
            "id": workflow_id,
            "workspaceId": workspace_id,
            "name": "Pi Agent proposal integration",
            "revision": 0,
            "nodes": [
                { "instanceId": "start", "meta": { "id": "pipline.start", "version": "1.0.0" }, "position": { "x": 0, "y": 0 }, "paramValues": { "inputSchema": { "properties": { "topic": "string" }, "required": ["topic"] } }, "portValues": {} },
                { "instanceId": "manual-assign", "meta": { "id": "pipline.assign", "version": "2.0.0" }, "position": { "x": 200, "y": 0 }, "paramValues": { "varName": "manualAnswer" }, "portValues": {} },
                { "instanceId": "end", "meta": { "id": "pipline.end", "version": "1.0.0" }, "position": { "x": 400, "y": 0 }, "paramValues": {}, "portValues": {} }
            ],
            "edges": [
                { "id": "start-assign", "sourceNodeId": "start", "sourcePort": "input", "targetNodeId": "manual-assign", "targetPort": "value" },
                { "id": "assign-end", "sourceNodeId": "manual-assign", "sourcePort": "output", "targetNodeId": "end", "targetPort": "result" }
            ],
            "createdAt": created_at,
            "updatedAt": created_at
        });
        send_json(
            &mut socket,
            json!({ "type": "host_request", "requestId": "create-agent-workflow", "operation": "create_workflow", "workflow": workflow }),
        )
        .await?;
        let created = read_until(&mut socket, |frame| frame["requestId"] == "create-agent-workflow")
            .await
            .map_err(|error| format!("create Pi Agent workflow: {error}"))?;
        if created["created"] != true {
            return Err(format!("Host failed to create test workflow: {created}"));
        }
        send_json(
            &mut socket,
            json!({ "type": "host_request", "requestId": "load-manual-workflow-before-agent-read",
                "operation": "load_workflow", "workflowId": workflow_id, "workspaceId": workspace_id }),
        )
        .await?;
        let manual_snapshot = read_until(&mut socket, |frame| {
            frame["requestId"] == "load-manual-workflow-before-agent-read"
        })
        .await
        .map_err(|error| format!("reload manually composed workflow from Host: {error}"))?;
        if manual_snapshot["record"]["workflow"]["nodes"].as_array().map(Vec::len) != Some(3)
            || manual_snapshot["record"]["workflow"]["edges"].as_array().map(Vec::len) != Some(2)
            || manual_snapshot["record"]["workflow"]["nodes"][1]["paramValues"]["varName"]
                != "manualAnswer"
        {
            return Err(format!("Host did not reload the manually composed graph: {manual_snapshot}"));
        }
        let manual_run_record = workflow_run::persist_active_run(
            &mut socket,
            workflow_id,
            &workspace_id,
            &manual_snapshot["record"]["workflow"],
        )
        .await?;

        let mut proposal_events = Vec::new();
        for (request_id, message) in [
            ("enable-workflow-tools", "/pipline-workflow-mode on"),
            ("ask-pi-to-read-manual-workflow", "Explain the workflow I manually composed, including its existing nodes, parameter values, and connections."),
        ] {
            send_json(
                &mut socket,
                json!({ "type": "runtime_request", "requestId": request_id,
                    "idempotencyKey": format!("{request_id}-key"), "target": target,
                    "command": { "type": "prompt", "message": message } }),
            )
            .await?;
            let response = read_until(&mut socket, |frame| frame["requestId"] == request_id)
                .await
                .map_err(|error| format!("receive Pi response for {request_id}: {error}"))?;
            if response["type"] != "runtime_response" || response["response"]["success"] != true {
                return Err(format!("Pi rejected {request_id}: {response}"));
            }
            if request_id == "enable-workflow-tools" {
                continue;
            }

            let (extension_request, observed_events) = read_until_collect_events(&mut socket, |frame| {
                frame["type"] == "runtime_event"
                    && frame["event"]["type"] == "extension_ui_request"
                    && frame["event"]["method"] == "input"
            })
            .await
            .map_err(|error| format!("receive Agent read of manual workflow: {error}"))?;
            proposal_events.extend(observed_events);
            let extension_event = &extension_request["event"];
            let placeholder = extension_event["placeholder"]
                .as_str()
                .ok_or("workflow read request omitted placeholder")?;
            let marker = "__PIPLINE_WORKFLOW_TOOL_V1__";
            let marker_offset = placeholder.find(marker).ok_or("workflow request marker is missing")?;
            let tool_request: Value = serde_json::from_str(&placeholder[marker_offset + marker.len()..])
                .map_err(|error| format!("decode Pi workflow read request: {error}"))?;
            if tool_request["operation"] != "read"
                || tool_request["workflowNodeOffset"] != 0
                || tool_request["workflowEdgeOffset"] != 0
            {
                return Err(format!("Pi did not request the current graph read: {tool_request}"));
            }

            let read_result = workflow_run::agent_workflow_read_result(
                &manual_snapshot["record"]["workflow"],
                &manual_run_record,
            );
            send_json(
                &mut socket,
                json!({ "type": "runtime_request", "requestId": "return-manual-workflow-read",
                    "idempotencyKey": "return-manual-workflow-read-key", "target": target,
                    "command": { "type": "extension_ui_response", "id": extension_event["id"],
                        "value": read_result.to_string() } }),
            )
            .await?;
            let returned = read_until(&mut socket, |frame| frame["requestId"] == "return-manual-workflow-read")
                .await
                .map_err(|error| format!("return manual workflow snapshot to Pi: {error}"))?;
            if returned["type"] != "runtime_response" || returned["response"]["success"] != true {
                return Err(format!("Host did not return manual workflow read result to Pi: {returned}"));
            }
            let (agent_end, mut read_events) = read_through_agent_end(&mut socket)
                .await
                .map_err(|error| format!("wait for manual workflow read response: {error}"))?;
            proposal_events.append(&mut read_events);
            workflow_run::cancel_active_run(&mut socket, &workspace_id, &manual_run_record).await?;
            if agent_end["event"]["type"] != "agent_end"
                || !provider_observed.received_manual_workflow_read.load(Ordering::SeqCst)
                || !provider_observed
                    .received_active_run_summary
                    .load(Ordering::SeqCst)
            {
                return Err(format!("Pi did not receive the Host workflow and active Run details: {agent_end}"));
            }
        }

        send_json(
            &mut socket,
            json!({ "type": "host_request", "requestId": "read-agent-catalog", "operation": "list_workflow_node_templates", "workspaceId": workspace_id }),
        )
        .await?;
        let catalog = read_until(&mut socket, |frame| frame["requestId"] == "read-agent-catalog")
            .await
            .map_err(|error| format!("read initial node catalog: {error}"))?;
        let catalog_revision = catalog["catalogRevision"].as_str().ok_or("Host did not return catalog revision")?.to_owned();
        *provider_observed.proposal.lock().map_err(|_| "workflow proposal fixture is poisoned")? = json!({
            "operation": "propose",
            "baseRevision": 0,
            "expectedCatalogRevision": catalog_revision,
            "operations": [
                { "type": "add_node", "node": {
                    "instanceId": "assign-answer", "meta": { "id": "pipline.assign", "version": "2.0.0" },
                    "position": { "x": 400, "y": 0 }, "paramValues": { "varName": "answer" },
                    "portValues": {}
                } },
                { "type": "remove_edge", "edgeId": "manual-assign-end" },
                { "type": "connect", "edge": { "id": "manual-to-answer", "sourceNodeId": "manual-assign", "sourcePort": "output", "targetNodeId": "assign-answer", "targetPort": "value" } },
                { "type": "connect", "edge": { "id": "answer-to-end", "sourceNodeId": "assign-answer", "sourcePort": "output", "targetNodeId": "end", "targetPort": "result" } }
            ]
        });
        provider_observed
            .next_response_is_tool_call
            .store(true, Ordering::SeqCst);

        for (request_id, message) in [("ask-pi-to-build-workflow", "Build a workflow that wraps the task in an answer object.")] {
            send_json(
                &mut socket,
                json!({ "type": "runtime_request", "requestId": request_id,
                    "idempotencyKey": format!("{request_id}-key"), "target": target,
                    "command": { "type": "prompt", "message": message } }),
            )
            .await?;
            let response = read_until(&mut socket, |frame| frame["requestId"] == request_id)
                .await
                .map_err(|error| format!("receive Pi response for {request_id}: {error}"))?;
            if response["type"] != "runtime_response" || response["response"]["success"] != true {
                return Err(format!("Pi rejected {request_id}: {response}"));
            }
            let (extension_request, observed_events) = read_until_collect_events(&mut socket, |frame| {
                frame["type"] == "runtime_event"
                    && frame["event"]["type"] == "extension_ui_request"
                    && frame["event"]["method"] == "input"
            })
            .await
            .map_err(|error| format!("receive graph proposal from Pi: {error}"))?;
            proposal_events.extend(observed_events);
            let extension_event = &extension_request["event"];
            if extension_event["title"] != "Pipline workflow bridge" {
                return Err(format!("Unexpected workflow extension dialog: {extension_event}"));
            }
            let marker = "__PIPLINE_WORKFLOW_TOOL_V1__";
            let placeholder = extension_event["placeholder"].as_str().ok_or("workflow extension request omitted placeholder")?;
            let marker_offset = placeholder.find(marker).ok_or("workflow request marker is missing")?;
            let tool_request: Value = serde_json::from_str(&placeholder[marker_offset + marker.len()..])
                .map_err(|error| format!("decode Pi workflow request: {error}"))?;
            if tool_request["operation"] != "propose"
                || tool_request["baseRevision"] != 0
                || tool_request["expectedCatalogRevision"] != catalog_revision
                || tool_request["operations"].as_array().map(Vec::len) != Some(4)
            {
                return Err(format!("Pi sent an unexpected revision-bound proposal: {tool_request}"));
            }
            let mut revised = workflow.clone();
            revised["revision"] = Value::from(1);
            revised["updatedAt"] = Value::from("2026-09-28T00:00:01.000Z");
            revised["nodes"].as_array_mut().unwrap().insert(2, tool_request["operations"][0]["node"].clone());
            revised["edges"] = json!([
                { "id": "start-assign", "sourceNodeId": "start", "sourcePort": "input", "targetNodeId": "manual-assign", "targetPort": "value" },
                { "id": "manual-to-answer", "sourceNodeId": "manual-assign", "sourcePort": "output", "targetNodeId": "assign-answer", "targetPort": "value" },
                { "id": "answer-to-end", "sourceNodeId": "assign-answer", "sourcePort": "output", "targetNodeId": "end", "targetPort": "result" }
            ]);
            send_json(
                &mut socket,
                json!({
                    "type": "host_request", "requestId": "approve-agent-proposal",
                    "operation": "compare_and_swap_workflow", "workflowId": workflow_id,
                    "workspaceId": workspace_id, "expectedRevision": 0,
                    "expectedCatalogRevision": catalog_revision, "workflow": revised,
                    "event": { "workflowId": workflow_id, "workspaceId": workspace_id,
                        "revision": 1, "schemaVersion": 1, "actor": "agent",
                        "timestamp": "2026-09-28T00:00:01.000Z",
                        "command": { "type": "apply_batch", "idempotencyKey": "pi-agent-host-smoke" } }
                }),
            ).await?;
            let approval = read_until(&mut socket, |frame| frame["requestId"] == "approve-agent-proposal")
                .await
                .map_err(|error| format!("persist approved graph proposal: {error}"))?;
            if approval["type"] != "host_response" || approval["saved"] != true {
                return Err(format!("Host rejected approved Agent graph proposal: {approval}"));
            }
            let extension_request_id = extension_event["id"].as_str().ok_or("workflow extension request id is missing")?;
            send_json(
                &mut socket,
                json!({ "type": "runtime_request", "requestId": "return-workflow-approval",
                    "idempotencyKey": "return-workflow-approval-key",
                    "target": target,
                    "command": { "type": "extension_ui_response", "id": extension_request_id,
                        "value": "{\"ok\":true,\"applied\":true,\"revision\":1}" } }),
            ).await?;
            let response = read_until(&mut socket, |frame| frame["requestId"] == "return-workflow-approval")
                .await
                .map_err(|error| format!("return graph approval to Pi: {error}"))?;
            if response["type"] != "runtime_response" || response["response"]["success"] != true {
                return Err(format!("Host did not deliver proposal approval to Pi: {response}"));
            }
        }

        let (agent_end, mut events) = read_through_agent_end(&mut socket)
            .await
            .map_err(|error| format!(
                "wait for initial graph proposal agent_end: {error}; fake provider request count: {}",
                provider_observed.request_count.load(Ordering::SeqCst)
            ))?;
        proposal_events.append(&mut events);
        let event_types = proposal_events.iter().filter_map(|frame| frame["event"]["type"].as_str()).collect::<Vec<_>>();
        if !event_types.contains(&"tool_execution_start") || !event_types.contains(&"tool_execution_end") {
            return Err(format!("Pi workflow tool execution events missing: {event_types:?}"));
        }
        let sequences = proposal_events
            .iter()
            .filter_map(|frame| frame["sequence"].as_u64())
            .collect::<Vec<_>>();
        if sequences.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(format!("Host workflow event sequence regressed: {sequences:?}"));
        }
        send_json(
            &mut socket,
            json!({ "type": "host_request", "requestId": "load-agent-proposal-result",
                "operation": "load_workflow", "workflowId": workflow_id, "workspaceId": workspace_id }),
        ).await?;
        let saved = read_until(&mut socket, |frame| frame["requestId"] == "load-agent-proposal-result").await?;
        if saved["record"]["workflow"]["revision"] != 1
            || saved["record"]["workflow"]["nodes"][2]["meta"]["id"] != "pipline.assign"
            || saved["record"]["workflow"]["nodes"][2]["paramValues"]["varName"] != "answer"
            || saved["record"]["workflow"]["edges"].as_array().map(Vec::len) != Some(3)
        {
            return Err(format!("Host did not persist the approved graph: {saved}"));
        }

        verify_node_meta_and_workflow_history(
            &mut socket,
            &workspace_id,
            &target,
            &provider_observed,
            &mut proposal_events,
        )
        .await?;

        if agent_end["target"]["instanceId"] != target.instance_id {
            return Err(format!("Pi workflow response came from the wrong session: {agent_end}"));
        }
        let _ = socket.close(None).await;
        Ok::<(), String>(())
    }.await;

    let stop_result = manager.stop(&target);
    host.stop().await;
    provider_task.abort();
    outcome?;
    let request_count = provider_observed.request_count.load(Ordering::SeqCst);
    let received_workflow_tool = provider_observed
        .received_workflow_tool
        .load(Ordering::SeqCst);
    if request_count < 2 || !received_workflow_tool {
        return Err(format!(
            "fake provider expected a workflow tool call and final turn; observed request_count={request_count}, received_workflow_tool={received_workflow_tool}"
        ));
    }
    stop_result.map_err(|error| format!("stop Pi workflow smoke runtime: {error}"))
}
