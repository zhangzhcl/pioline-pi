//! Opt-in cross-process smoke for the real embedded Pi Runtime behind the
//! desktop Host WebSocket. Run explicitly with `cargo test real_pi_websocket -- --ignored`.

use crate::host_server::HostServer;
use crate::metadata_store::MetadataStore;
use crate::native_pi_manager::{NativeLaunchSpec, NativePiManager};
use crate::remote_auth::RemoteAuth;
use crate::runtime_coordinator::RuntimeTarget;
use axum::body::Body;
use axum::extract::Json;
use axum::extract::State;
use axum::http::header::CONTENT_TYPE;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_tungstenite::tungstenite::Message;

static PI_ENVIRONMENT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[path = "host_server_real_pi_smoke/workflow_run.rs"]
mod workflow_run;

#[derive(Clone)]
struct FakeProviderState {
    request_count: Arc<AtomicUsize>,
    received_write_tool: Arc<AtomicBool>,
}

#[derive(Clone)]
struct FakeWorkflowProviderState {
    request_count: Arc<AtomicUsize>,
    received_workflow_tool: Arc<AtomicBool>,
    next_response_is_tool_call: Arc<AtomicBool>,
    received_manual_workflow_read: Arc<AtomicBool>,
    received_active_run_summary: Arc<AtomicBool>,
    proposal: Arc<Mutex<Value>>,
}

struct PiEnvironmentGuard {
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
}

impl PiEnvironmentGuard {
    fn isolate(pi_agent_dir: &Path, home: &Path) -> Self {
        let names = ["PI_CODING_AGENT_DIR", "HOME", "USERPROFILE"];
        let previous = names
            .into_iter()
            .map(|name| (name, std::env::var_os(name)))
            .collect();
        std::env::set_var("PI_CODING_AGENT_DIR", pi_agent_dir);
        std::env::set_var("HOME", home);
        std::env::set_var("USERPROFILE", home);
        Self { previous }
    }
}

impl Drop for PiEnvironmentGuard {
    fn drop(&mut self) {
        for (name, value) in &self.previous {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }
}

#[tokio::test]
#[ignore = "requires the bundled Pi Runtime; run explicitly as an integration smoke"]
async fn real_pi_websocket_smoke() {
    let _environment_lock = PI_ENVIRONMENT_LOCK.lock().await;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("pipline-host-pi-smoke-{nonce}"));
    let public = temp.join("public");
    let pi_agent_dir = temp.join("pi-agent");
    let isolated_home = temp.join("home");
    let workspace = temp.join("workspace");
    fs::create_dir_all(&public).expect("create static directory");
    fs::create_dir_all(&pi_agent_dir).expect("create isolated Pi config directory");
    fs::create_dir_all(&isolated_home).expect("create isolated home directory");
    fs::create_dir_all(&workspace).expect("create isolated workspace");
    fs::create_dir_all(temp.join(".git"))
        .expect("mark smoke root to stop ancestor skill discovery");
    fs::write(public.join("index.html"), "Pipline Host to Pi smoke").expect("write index");
    let user_extensions = pi_agent_dir.join("extensions");
    fs::create_dir_all(&user_extensions).expect("create isolated user extension directory");
    fs::write(
        user_extensions.join("pipline-profile-smoke.ts"),
        r#"export default function (pi) {
  pi.registerCommand("pipline-profile-smoke", {
    description: "Verify Pipline reuses Pi user extensions",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Pipline user extension executed", "info");
    },
  });
  pi.registerCommand("pipline-profile-confirm", {
    description: "Verify blocking Pi extension UI responses through Pipline",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm("Pipline extension confirmation", "Continue?");
      ctx.ui.notify(`Pipline confirmation result: ${confirmed}`, "info");
    },
  });
  pi.registerCommand("pipline-profile-dialogs", {
    description: "Verify Pi extension select and input UI responses through Pipline",
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select("Choose a profile value", ["A", "B"]);
      const value = await ctx.ui.input("Enter a profile value", "placeholder");
      ctx.ui.notify(`Pipline dialog results: ${JSON.stringify({ choice, value })}`, "info");
    },
  });
  pi.registerCommand("pipline-profile-input-cancel", {
    description: "Verify Pi extension input cancellation through Pipline",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.input("Cancel a profile value", "placeholder");
      ctx.ui.notify(value === undefined ? "Pipline input cancelled" : "Pipline input was not cancelled", "info");
    },
  });
  pi.registerCommand("pipline-profile-custom-ui", {
    description: "Verify custom extension UI input through the Pipline RPC bridge",
    handler: async (_args, ctx) => {
      const result = await ctx.ui.custom((_tui, _theme, _keybindings, done) => ({
        render: () => ["Pipline custom panel", "Press b to continue"],
        handleInput: (data) => { if (data === "b") done("selected"); },
      }), { overlayOptions: { width: 42 } });
      ctx.ui.notify(`Pipline custom UI result: ${result ?? "cancelled"}`, "info");
    },
  });
}
"#,
    )
    .expect("write isolated user extension");

    // Isolate both Pi's config directory and home-based resource discovery so
    // this smoke never enumerates the machine owner's installed skills.
    let _environment = PiEnvironmentGuard::isolate(&pi_agent_dir, &isolated_home);

    let result = run_smoke(&temp, &public, &pi_agent_dir, &workspace).await;
    let cleanup = fs::remove_dir_all(&temp);
    if let Err(error) = result {
        panic!("real Pi Host WebSocket smoke failed: {error}");
    }
    cleanup.expect("remove isolated smoke data");
}

#[tokio::test]
#[ignore = "requires the bundled Pi Runtime and bridge extension; run explicitly as an integration smoke"]
async fn real_pi_workflow_proposal_websocket_smoke() {
    let _environment_lock = PI_ENVIRONMENT_LOCK.lock().await;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("pipline-pi-workflow-host-smoke-{nonce}"));
    let public = temp.join("public");
    let pi_agent_dir = temp.join("pi-agent");
    let isolated_home = temp.join("home");
    let workspace = temp.join("workspace");
    fs::create_dir_all(&public).expect("create static directory");
    fs::create_dir_all(&pi_agent_dir).expect("create isolated Pi config directory");
    fs::create_dir_all(&isolated_home).expect("create isolated home directory");
    fs::create_dir_all(&workspace).expect("create isolated workspace");
    fs::create_dir_all(temp.join(".git"))
        .expect("mark smoke root to stop ancestor skill discovery");
    fs::write(public.join("index.html"), "Pipline Pi workflow Host smoke").expect("write index");

    let _environment = PiEnvironmentGuard::isolate(&pi_agent_dir, &isolated_home);
    let result = run_workflow_proposal_smoke(&temp, &public, &pi_agent_dir, &workspace).await;
    let cleanup = fs::remove_dir_all(&temp);
    if let Err(error) = result {
        panic!("real Pi workflow Host WebSocket smoke failed: {error}");
    }
    cleanup.expect("remove isolated workflow smoke data");
}

async fn run_workflow_proposal_smoke(
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
        .spawn(target.clone(), launch_spec)
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

        send_json(
            &mut socket,
            json!({ "type": "host_request", "requestId": "read-node-meta-catalog",
                "operation": "list_workflow_node_templates", "workspaceId": workspace_id }),
        )
        .await?;
        let catalog = read_until(&mut socket, |frame| frame["requestId"] == "read-node-meta-catalog")
            .await
            .map_err(|error| format!("read NodeMeta catalog: {error}"))?;
        let node_meta_catalog_revision = catalog["catalogRevision"]
            .as_str()
            .ok_or("Host did not return NodeMeta catalog revision")?
            .to_owned();
        let candidate = json!({
            "schemaVersion": 1,
            "id": "custom.slugify",
            "version": "1.0.0",
            "type": "custom",
            "label": "Slugify",
            "description": "Convert text into a URL slug.",
            "inputs": [{ "name": "text", "label": "Text", "type": "string",
                "required": true, "allowStaticValue": true }],
            "outputs": [{ "name": "slug", "label": "Slug", "type": "string",
                "required": true, "allowStaticValue": false }],
            "params": [],
            "execution": { "kind": "user-code", "entrypoint": "slugify" },
            "permissions": { "filesystem": "none", "network": "none", "shell": "none" },
            "implementationDraft": { "language": "typescript",
                "source": "export function slugify(text: string) { return text.toLowerCase(); }",
                "entryFn": "slugify" },
            "i18n": {
                "en": { "label": "Slugify", "description": "Convert text into a URL slug.",
                    "inputs": { "text": "Text" }, "outputs": { "slug": "Slug" }, "params": {} },
                "zh": { "label": "生成链接别名", "description": "将文本转换为链接别名。",
                    "inputs": { "text": "文本" }, "outputs": { "slug": "链接别名" }, "params": {} },
                "es": { "label": "Crear slug", "description": "Convertir texto en un slug de URL.",
                    "inputs": { "text": "Texto" }, "outputs": { "slug": "Slug" }, "params": {} },
                "ja": { "label": "URLスラッグ化", "description": "テキストをURLスラッグに変換します。",
                    "inputs": { "text": "テキスト" }, "outputs": { "slug": "スラッグ" }, "params": {} }
            }
        });
        *provider_observed.proposal.lock().map_err(|_| "workflow NodeMeta fixture is poisoned")? = json!({
            "operation": "propose_node_meta",
            "expectedCatalogRevision": node_meta_catalog_revision,
            "meta": candidate,
        });
        provider_observed
            .next_response_is_tool_call
            .store(true, Ordering::SeqCst);
        send_json(
            &mut socket,
            json!({ "type": "runtime_request", "requestId": "ask-pi-for-node-meta",
                "idempotencyKey": "ask-pi-for-node-meta-key", "target": target,
                "command": { "type": "prompt", "message": "Create a reusable node template that converts text into a URL slug. Save the template only; do not add it to the active workflow." } }),
        )
        .await?;
        let prompt_response = read_until(&mut socket, |frame| frame["requestId"] == "ask-pi-for-node-meta")
            .await
            .map_err(|error| format!("receive NodeMeta prompt response: {error}"))?;
        if prompt_response["type"] != "runtime_response" || prompt_response["response"]["success"] != true {
            return Err(format!("Pi rejected NodeMeta generation prompt: {prompt_response}"));
        }
        let (node_meta_request, node_meta_events) = read_until_collect_events(&mut socket, |frame| {
            frame["type"] == "runtime_event"
                && frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "input"
        })
        .await
        .map_err(|error| format!("receive Pi NodeMeta approval request: {error}"))?;
        proposal_events.extend(node_meta_events);
        let node_meta_event = &node_meta_request["event"];
        let placeholder = node_meta_event["placeholder"]
            .as_str()
            .ok_or("Pi NodeMeta request omitted its workflow marker")?;
        let marker = "__PIPLINE_WORKFLOW_TOOL_V1__";
        let marker_offset = placeholder.find(marker).ok_or("NodeMeta workflow marker is missing")?;
        let node_meta_request: Value = serde_json::from_str(&placeholder[marker_offset + marker.len()..])
            .map_err(|error| format!("decode Pi NodeMeta request: {error}"))?;
        if node_meta_request["operation"] != "propose_node_meta"
            || node_meta_request["expectedCatalogRevision"] != node_meta_catalog_revision
            || node_meta_request["meta"]["id"] != "custom.slugify"
            || node_meta_request["meta"]["implementationDraft"]["source"]
                != candidate["implementationDraft"]["source"]
        {
            return Err(format!("Pi sent an unexpected NodeMeta candidate: {node_meta_request}"));
        }
        let extension_request_id = node_meta_event["id"]
            .as_str()
            .ok_or("NodeMeta approval request id is missing")?;
        send_json(
            &mut socket,
            json!({ "type": "host_request", "requestId": "approve-node-meta-candidate",
                "operation": "create_workflow_node_template", "workspaceId": workspace_id,
                "expectedCatalogRevision": node_meta_catalog_revision, "meta": candidate }),
        )
        .await?;
        let node_meta_saved = read_until(&mut socket, |frame| frame["requestId"] == "approve-node-meta-candidate")
            .await
            .map_err(|error| format!("save approved NodeMeta through Host: {error}"))?;
        if node_meta_saved["type"] != "host_response" || node_meta_saved["created"] != true {
            return Err(format!("Host rejected approved NodeMeta candidate: {node_meta_saved}"));
        }
        let candidate_summary = json!({ "ok": true, "meta": {
            "id": candidate["id"], "version": candidate["version"], "implementation": { "compiled": false, "executable": false }
        }, "nodeCatalog": { "revision": node_meta_saved["catalogRevision"] } });
        send_json(
            &mut socket,
            json!({ "type": "runtime_request", "requestId": "return-node-meta-approval",
                "idempotencyKey": "return-node-meta-approval-key", "target": target,
                "command": { "type": "extension_ui_response", "id": extension_request_id,
                    "value": candidate_summary.to_string() } }),
        )
        .await?;
        let approval_response = read_until(&mut socket, |frame| frame["requestId"] == "return-node-meta-approval")
            .await
            .map_err(|error| format!("return NodeMeta approval to Pi: {error}"))?;
        if approval_response["type"] != "runtime_response" || approval_response["response"]["success"] != true {
            return Err(format!("Host did not return NodeMeta approval to Pi: {approval_response}"));
        }
        let (node_meta_agent_end, mut node_meta_events) = read_through_agent_end(&mut socket)
            .await
            .map_err(|error| format!("wait for NodeMeta proposal agent_end: {error}"))?;
        proposal_events.append(&mut node_meta_events);
        if node_meta_agent_end["event"]["type"] != "agent_end" {
            return Err(format!("Pi did not finish NodeMeta proposal turn: {node_meta_agent_end}"));
        }
        send_json(
            &mut socket,
            json!({ "type": "host_request", "requestId": "verify-node-meta-template",
                "operation": "list_workflow_node_templates", "workspaceId": workspace_id }),
        )
        .await?;
        let templates = read_until(&mut socket, |frame| frame["requestId"] == "verify-node-meta-template")
            .await
            .map_err(|error| format!("verify NodeMeta Host persistence: {error}"))?;
        if !templates["templates"].as_array().is_some_and(|items| items.contains(&candidate)) {
            return Err(format!("Host did not persist the approved custom NodeMeta template: {templates}"));
        }
        send_json(
            &mut socket,
            json!({ "type": "runtime_request", "requestId": "read-agent-workflow-history",
                "target": target, "command": { "type": "get_messages" } }),
        )
        .await?;
        let history_response = read_until(&mut socket, |frame| {
            frame["requestId"] == "read-agent-workflow-history"
        })
        .await?;
        if history_response["response"]["success"] != true {
            return Err(format!("Pi could not reload workflow conversation history: {history_response}"));
        }
        let messages = history_response["response"]["data"]["messages"]
            .as_array()
            .ok_or_else(|| format!("Pi workflow conversation history is missing: {history_response}"))?;
        let saved_workflow_call = messages.iter().any(|message| {
            message["role"] == "assistant"
                && message["content"].as_array().is_some_and(|parts| {
                    parts.iter().any(|part| {
                        part["type"] == "toolCall" && part["name"] == "pipline_workflow"
                    })
                })
        });
        let saved_approval = messages.iter().any(|message| {
            message["role"] == "toolResult"
                && message["toolName"] == "pipline_workflow"
                && message["content"].as_array().is_some_and(|parts| {
                    parts.iter().any(|part| {
                        part["type"] == "text"
                            && part["text"].as_str().is_some_and(|text| {
                                serde_json::from_str::<Value>(text).is_ok_and(|result| {
                                    result["applied"] == true && result["revision"] == 1
                                })
                            })
                    })
                })
        });
        let saved_agent_summary = messages.iter().any(|message| {
            message["role"] == "assistant"
                && message["content"].as_array().is_some_and(|parts| {
                    parts.iter().any(|part| {
                        part["type"] == "text"
                            && part["text"]
                                .as_str()
                                .is_some_and(|text| text.contains("I added an Assign node"))
                    })
                })
        });
        if !saved_workflow_call || !saved_approval || !saved_agent_summary {
            return Err(format!(
                "Pi history must retain the workflow call, approved result, and assistant summary; call={saved_workflow_call}, approval={saved_approval}, summary={saved_agent_summary}, messages={messages:?}"
            ));
        }
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

async fn run_smoke(
    temp: &Path,
    public: &Path,
    pi_agent_dir: &Path,
    workspace: &Path,
) -> Result<(), String> {
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("bind fake model provider: {error}"))?;
    let provider_address = provider_listener
        .local_addr()
        .map_err(|error| format!("read fake provider address: {error}"))?;
    let provider_state = FakeProviderState {
        request_count: Arc::new(AtomicUsize::new(0)),
        received_write_tool: Arc::new(AtomicBool::new(false)),
    };
    let provider_observed = provider_state.clone();
    let provider_task = tokio::spawn(async move {
        let app = Router::new()
            .route("/v1/chat/completions", post(fake_chat_completion))
            .with_state(provider_state);
        axum::serve(provider_listener, app).await
    });
    fs::write(
        pi_agent_dir.join("models.json"),
        serde_json::to_vec(&json!({
            "providers": {
                "pipline-host-smoke": {
                    "baseUrl": format!("http://{provider_address}/v1"),
                    "api": "openai-completions",
                    "apiKey": "pipline-host-smoke-key",
                    "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
                    "models": [{
                        "id": "host-smoke-model",
                        "name": "Pipline Host Smoke Model",
                        "reasoning": false,
                        "input": ["text"],
                        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
                        "contextWindow": 8192,
                        "maxTokens": 256
                    }]
                }
            }
        }))
        .map_err(|error| format!("encode fake provider model: {error}"))?,
    )
    .map_err(|error| format!("write fake provider model: {error}"))?;
    fs::write(
        pi_agent_dir.join("settings.json"),
        br#"{"defaultProvider":"pipline-host-smoke","defaultModel":"host-smoke-model","defaultTools":["read","write"]}"#,
    )
    .map_err(|error| format!("write isolated Pi settings: {error}"))?;

    let metadata = MetadataStore::open(&temp.join("pipline.sqlite3"))
        .map_err(|error| format!("open metadata store: {error}"))?;
    let auth = Arc::new(Mutex::new(RemoteAuth::new(Arc::new(Mutex::new(metadata)))));
    let manager = NativePiManager::new(8);
    let target = RuntimeTarget::new(
        "host-smoke-workspace",
        "host-smoke-session",
        "host-smoke-instance",
    );
    let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("pi")
        .join(if cfg!(windows) { "pi.exe" } else { "pi" });
    if !binary.is_file() {
        return Err(format!(
            "embedded Pi binary is missing: {}",
            binary.display()
        ));
    }
    let bridge = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("extensions")
        .join("dist")
        .join("picot-bridge.mjs");
    if !bridge.is_file() {
        return Err(format!(
            "Pipline Pi bridge extension is missing: {}",
            bridge.display()
        ));
    }
    let launch_spec = NativeLaunchSpec {
        binary,
        cwd: workspace.to_path_buf(),
        session_path: Some(temp.join("session.jsonl")),
        extensions: vec![bridge],
        pi_version: env!("PI_STUDIO_PI_VERSION_BUNDLED").to_owned(),
        path_env: std::env::var("PATH").unwrap_or_default(),
        approve: true,
        windows_powershell_fallback: false,
    };
    manager
        .spawn(target.clone(), launch_spec.clone())
        .map_err(|error| format!("spawn bundled Pi: {error}"))?;

    let host = HostServer::start(public.to_path_buf(), manager.clone(), auth, None)
        .await
        .map_err(|error| format!("start HostServer: {error}"))?;
    let mut target_for_cleanup = target.clone();
    let outcome = async {
        let ws_url = host.origin().replace("http://", "ws://") + "/v2/ws";
        let (mut socket, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|error| format!("connect Host WebSocket: {error}"))?;
        send_json(
            &mut socket,
            json!({
                "type": "hello",
                "protocolVersion": 2,
                "clientType": "desktop",
                "clientId": "real-pi-smoke"
            }),
        )
        .await?;
        let hello = read_frame(&mut socket).await?;
        if hello["type"] != "hello_ack" {
            return Err(format!("unexpected hello response: {hello}"));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_subscribe",
                "requestId": "subscribe-real-pi",
                "target": target
            }),
        )
        .await?;
        let subscribed = read_until(&mut socket, |frame| {
            frame["requestId"] == "subscribe-real-pi"
        })
        .await?;
        if subscribed["type"] != "runtime_subscribed" {
            return Err(format!("runtime subscription rejected: {subscribed}"));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "get-user-extension-commands",
                "target": target,
                "command": { "type": "get_commands" }
            }),
        )
        .await?;
        let commands_response = read_until(&mut socket, |frame| {
            frame["requestId"] == "get-user-extension-commands"
        })
        .await?;
        if commands_response["response"]["success"] != true {
            return Err(format!("Pi get_commands failed through Host: {commands_response}"));
        }
        let commands = commands_response["response"]["data"]["commands"]
            .as_array()
            .ok_or_else(|| format!("Pi extension command catalog missing: {commands_response}"))?;
        let command_names = commands
            .iter()
            .filter_map(|command| command["name"].as_str())
            .collect::<Vec<_>>();
        if !commands.iter().any(|command| {
            command["name"] == "pipline-profile-smoke" && command["source"] == "extension"
        }) || !commands.iter().any(|command| {
            command["name"] == "pipline-profile-confirm" && command["source"] == "extension"
        }) || !commands.iter().any(|command| {
            command["name"] == "pipline-profile-dialogs" && command["source"] == "extension"
        }) || !commands.iter().any(|command| {
            command["name"] == "pipline-profile-input-cancel" && command["source"] == "extension"
        }) || !commands.iter().any(|command| {
            command["name"] == "pipline-profile-custom-ui" && command["source"] == "extension"
        }) {
            return Err(format!(
                "Pi did not auto-load the user extension from PI_CODING_AGENT_DIR; commands: {command_names:?}"
            ));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "run-user-extension-command",
                "idempotencyKey": "run-user-extension-command-key",
                "target": target,
                "command": { "type": "prompt", "message": "/pipline-profile-smoke" }
            }),
        )
        .await?;
        let (extension_command_response, extension_events) = read_until_collect_events(
            &mut socket,
            |frame| frame["requestId"] == "run-user-extension-command",
        )
        .await?;
        if extension_command_response["type"] != "runtime_response"
            || extension_command_response["response"]["success"] != true
        {
            return Err(format!(
                "Pi did not execute the user extension command: {extension_command_response}"
            ));
        }
        let notification = extension_events
            .iter()
            .find(|frame| {
                frame["event"]["type"] == "extension_ui_request"
                    && frame["event"]["method"] == "notify"
                    && frame["event"]["message"] == "Pipline user extension executed"
            })
            .cloned();
        let notification = if let Some(notification) = notification {
            notification
        } else {
            read_until(&mut socket, |frame| {
                    frame["type"] == "runtime_event"
                        && frame["event"]["type"] == "extension_ui_request"
                        && frame["event"]["method"] == "notify"
                        && frame["event"]["message"] == "Pipline user extension executed"
                })
                .await?
        };
        if notification["event"]["message"] != "Pipline user extension executed" {
            return Err(format!(
                "Unexpected user extension UI notification: {notification}"
            ));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "run-user-extension-confirm",
                "idempotencyKey": "run-user-extension-confirm-key",
                "target": target,
                "command": { "type": "prompt", "message": "/pipline-profile-confirm" }
            }),
        )
        .await?;
        let confirmation_request = read_until(&mut socket, |frame| {
            frame["type"] == "runtime_event"
                && frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "confirm"
                && frame["event"]["title"] == "Pipline extension confirmation"
        })
        .await?;
        let confirmation_id = confirmation_request["event"]["id"]
            .as_str()
            .ok_or("Pi extension confirmation omitted its request id")?;
        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "answer-user-extension-confirm",
                "idempotencyKey": "answer-user-extension-confirm-key",
                "target": target,
                "command": { "type": "extension_ui_response", "id": confirmation_id,
                    "confirmed": true }
            }),
        )
        .await?;
        let confirmation_response = read_until(&mut socket, |frame| {
            frame["requestId"] == "answer-user-extension-confirm"
        })
        .await?;
        if confirmation_response["type"] != "runtime_response"
            || confirmation_response["response"]["success"] != true
        {
            return Err(format!(
                "Host did not deliver the Pi extension confirmation: {confirmation_response}"
            ));
        }
        let (command_response, later_events) = read_until_collect_events(&mut socket, |frame| {
            frame["requestId"] == "run-user-extension-confirm"
        })
        .await?;
        if command_response["type"] != "runtime_response"
            || command_response["response"]["success"] != true
        {
            return Err(format!(
                "Pi extension command did not resume after confirmation: {command_response}"
            ));
        }
        let confirmation_notice = later_events
            .iter()
            .find(|frame| {
                frame["event"]["type"] == "extension_ui_request"
                    && frame["event"]["method"] == "notify"
                    && frame["event"]["message"] == "Pipline confirmation result: true"
            })
            .cloned();
        let confirmation_notice = if let Some(notice) = confirmation_notice {
            notice
        } else {
            read_until(&mut socket, |frame| {
                frame["type"] == "runtime_event"
                    && frame["event"]["type"] == "extension_ui_request"
                    && frame["event"]["method"] == "notify"
                    && frame["event"]["message"] == "Pipline confirmation result: true"
            })
            .await?
        };
        if confirmation_notice["event"]["message"] != "Pipline confirmation result: true" {
            return Err(format!(
                "Pi extension did not continue with the confirmed result: {confirmation_notice}"
            ));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "run-user-extension-dialogs",
                "idempotencyKey": "run-user-extension-dialogs-key",
                "target": target,
                "command": { "type": "prompt", "message": "/pipline-profile-dialogs" }
            }),
        )
        .await?;
        let select_request = read_until(&mut socket, |frame| {
            frame["type"] == "runtime_event"
                && frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "select"
                && frame["event"]["title"] == "Choose a profile value"
        })
        .await?;
        let select_id = select_request["event"]["id"]
            .as_str()
            .ok_or("Pi extension select omitted its request id")?;
        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "answer-user-extension-select",
                "idempotencyKey": "answer-user-extension-select-key",
                "target": target,
                "command": { "type": "extension_ui_response", "id": select_id, "value": "B" }
            }),
        )
        .await?;
        let select_response = read_until(&mut socket, |frame| {
            frame["requestId"] == "answer-user-extension-select"
        })
        .await?;
        if select_response["type"] != "runtime_response"
            || select_response["response"]["success"] != true
        {
            return Err(format!("Host did not deliver Pi select value: {select_response}"));
        }
        let input_request = read_until(&mut socket, |frame| {
            frame["type"] == "runtime_event"
                && frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "input"
                && frame["event"]["title"] == "Enter a profile value"
        })
        .await?;
        let input_id = input_request["event"]["id"]
            .as_str()
            .ok_or("Pi extension input omitted its request id")?;
        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "answer-user-extension-input",
                "idempotencyKey": "answer-user-extension-input-key",
                "target": target,
                "command": { "type": "extension_ui_response", "id": input_id, "value": "Pipline ✓" }
            }),
        )
        .await?;
        let input_response = read_until(&mut socket, |frame| {
            frame["requestId"] == "answer-user-extension-input"
        })
        .await?;
        if input_response["type"] != "runtime_response"
            || input_response["response"]["success"] != true
        {
            return Err(format!("Host did not deliver Pi input value: {input_response}"));
        }
        let (dialogs_response, dialogs_events) = read_until_collect_events(&mut socket, |frame| {
            frame["requestId"] == "run-user-extension-dialogs"
        })
        .await?;
        if dialogs_response["type"] != "runtime_response"
            || dialogs_response["response"]["success"] != true
        {
            return Err(format!("Pi dialog extension did not resume: {dialogs_response}"));
        }
        let expected_dialog_result = "Pipline dialog results: {\"choice\":\"B\",\"value\":\"Pipline ✓\"}";
        let dialog_notice = dialogs_events
            .iter()
            .find(|frame| {
                frame["event"]["type"] == "extension_ui_request"
                    && frame["event"]["method"] == "notify"
                    && frame["event"]["message"] == expected_dialog_result
            })
            .cloned();
        let dialog_notice = if let Some(notice) = dialog_notice {
            notice
        } else {
            read_until(&mut socket, |frame| {
                frame["type"] == "runtime_event"
                    && frame["event"]["type"] == "extension_ui_request"
                    && frame["event"]["method"] == "notify"
                    && frame["event"]["message"] == expected_dialog_result
            })
            .await?
        };
        if dialog_notice["event"]["message"] != expected_dialog_result {
            return Err(format!("Pi extension returned unexpected dialog values: {dialog_notice}"));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "run-user-extension-input-cancel",
                "idempotencyKey": "run-user-extension-input-cancel-key",
                "target": target,
                "command": { "type": "prompt", "message": "/pipline-profile-input-cancel" }
            }),
        )
        .await?;
        let cancel_request = read_until(&mut socket, |frame| {
            frame["type"] == "runtime_event"
                && frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "input"
                && frame["event"]["title"] == "Cancel a profile value"
        })
        .await?;
        let cancel_id = cancel_request["event"]["id"]
            .as_str()
            .ok_or("Pi extension cancellation input omitted its request id")?;
        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "answer-user-extension-input-cancel",
                "idempotencyKey": "answer-user-extension-input-cancel-key",
                "target": target,
                "command": { "type": "extension_ui_response", "id": cancel_id, "cancelled": true }
            }),
        )
        .await?;
        let cancel_response = read_until(&mut socket, |frame| {
            frame["requestId"] == "answer-user-extension-input-cancel"
        })
        .await?;
        if cancel_response["type"] != "runtime_response"
            || cancel_response["response"]["success"] != true
        {
            return Err(format!("Host did not deliver Pi input cancellation: {cancel_response}"));
        }
        let (cancelled_command_response, cancelled_events) =
            read_until_collect_events(&mut socket, |frame| {
                frame["requestId"] == "run-user-extension-input-cancel"
            })
            .await?;
        if cancelled_command_response["type"] != "runtime_response"
            || cancelled_command_response["response"]["success"] != true
        {
            return Err(format!("Pi extension did not resume after cancellation: {cancelled_command_response}"));
        }
        let cancellation_notice = cancelled_events
            .iter()
            .find(|frame| {
                frame["event"]["type"] == "extension_ui_request"
                    && frame["event"]["method"] == "notify"
                    && frame["event"]["message"] == "Pipline input cancelled"
            })
            .cloned();
        let cancellation_notice = if let Some(notice) = cancellation_notice {
            notice
        } else {
            read_until(&mut socket, |frame| {
                frame["type"] == "runtime_event"
                    && frame["event"]["type"] == "extension_ui_request"
                    && frame["event"]["method"] == "notify"
                    && frame["event"]["message"] == "Pipline input cancelled"
            })
            .await?
        };
        if cancellation_notice["event"]["message"] != "Pipline input cancelled" {
            return Err(format!("Pi extension returned the wrong cancellation result: {cancellation_notice}"));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "run-user-extension-custom-ui",
                "idempotencyKey": "run-user-extension-custom-ui-key",
                "target": target,
                "command": { "type": "prompt", "message": "/pipline-profile-custom-ui" }
            }),
        )
        .await?;
        let custom_ui_open = read_until(&mut socket, |frame| {
            frame["type"] == "runtime_event"
                && frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "notify"
                && frame["event"]["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("__picotCustomUi"))
        })
        .await?;
        let custom_ui_payload: Value = serde_json::from_str(
            custom_ui_open["event"]["message"]
                .as_str()
                .ok_or("custom UI notification did not contain text")?,
        )
        .map_err(|error| format!("decode custom UI notification: {error}"))?;
        if custom_ui_payload["__picotCustomUi"]["op"] != "open"
            || custom_ui_payload["__picotCustomUi"]["lines"][0] != "Pipline custom panel"
        {
            return Err(format!(
                "Pi custom UI did not render through Host: {custom_ui_payload}"
            ));
        }
        let custom_ui_id = custom_ui_payload["__picotCustomUi"]["id"]
            .as_str()
            .ok_or("custom UI open frame omitted its panel id")?;
        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "send-user-extension-custom-ui-input",
                "idempotencyKey": "send-user-extension-custom-ui-input-key",
                "target": target,
                "command": {
                    "type": "prompt",
                    "message": format!(
                        "/picot-custom-ui {{\"id\":\"{custom_ui_id}\",\"data\":\"b\"}}"
                    )
                }
            }),
        )
        .await?;
        let custom_input_response = read_until(&mut socket, |frame| {
            frame["requestId"] == "send-user-extension-custom-ui-input"
        })
        .await?;
        if custom_input_response["type"] != "runtime_response"
            || custom_input_response["response"]["success"] != true
        {
            return Err(format!(
                "Pi did not accept custom UI input through Host: {custom_input_response}"
            ));
        }
        let (custom_ui_response, custom_ui_events) =
            read_until_collect_events(&mut socket, |frame| {
                frame["requestId"] == "run-user-extension-custom-ui"
            })
            .await?;
        if custom_ui_response["type"] != "runtime_response"
            || custom_ui_response["response"]["success"] != true
        {
            return Err(format!(
                "Pi extension remained blocked after custom UI input: {custom_ui_response}"
            ));
        }
        let expected_custom_result = "Pipline custom UI result: selected";
        if !custom_ui_events.iter().any(|frame| {
            frame["event"]["type"] == "extension_ui_request"
                && frame["event"]["method"] == "notify"
                && frame["event"]["message"] == expected_custom_result
        }) {
            let custom_ui_result = read_until(&mut socket, |frame| {
                frame["type"] == "runtime_event"
                    && frame["event"]["type"] == "extension_ui_request"
                    && frame["event"]["method"] == "notify"
                    && frame["event"]["message"] == expected_custom_result
            })
            .await?;
            if custom_ui_result["event"]["message"] != expected_custom_result {
                return Err(format!(
                    "Pi custom UI returned an unexpected result: {custom_ui_result}"
                ));
            }
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "get-state-real-pi",
                "target": target,
                "command": { "type": "get_state" }
            }),
        )
        .await?;
        let response = read_until(&mut socket, |frame| {
            frame["requestId"] == "get-state-real-pi"
        })
        .await?;
        if response["type"] != "runtime_response" || response["response"]["success"] != true {
            return Err(format!("Pi get_state failed through Host: {response}"));
        }
        if response["acceptance"] != "accepted" {
            return Err(format!("unexpected Host acceptance: {response}"));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "name-session-real-pi",
                "target": target,
                "command": { "type": "set_session_name", "name": "Pipline RPC integration smoke" }
            }),
        )
        .await?;
        let named = read_until(&mut socket, |frame| {
            frame["requestId"] == "name-session-real-pi"
        })
        .await?;
        if named["type"] != "runtime_response" || named["response"]["success"] != true {
            return Err(format!("Pi could not name the isolated smoke session: {named}"));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "prompt-real-pi",
                "idempotencyKey": "host-smoke-prompt-1",
                "target": target,
                "command": { "type": "prompt", "message": "Reply with the exact text: Pipline Host to Pi integration passed." }
            }),
        )
        .await?;
        let prompt_response = read_until(&mut socket, |frame| {
            frame["requestId"] == "prompt-real-pi"
        })
        .await?;
        if prompt_response["type"] != "runtime_response"
            || prompt_response["response"]["success"] != true
        {
            return Err(format!("Pi rejected prompt through Host: {prompt_response}"));
        }
        let (agent_end, runtime_events) = read_through_agent_end(&mut socket).await?;
        if agent_end["target"]["instanceId"] != target.instance_id {
            return Err(format!("agent event target mismatch: {agent_end}"));
        }
        let event_types = runtime_events
            .iter()
            .filter_map(|frame| frame["event"]["type"].as_str())
            .collect::<Vec<_>>();
        for required in [
            "message_update",
            "tool_execution_start",
            "tool_execution_end",
        ] {
            if !event_types.contains(&required) {
                return Err(format!(
                    "Pi runtime event {required} did not cross Host: {event_types:?}"
                ));
            }
        }
        let sequences = runtime_events
            .iter()
            .filter_map(|frame| frame["sequence"].as_u64())
            .collect::<Vec<_>>();
        if sequences.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(format!("Host runtime event sequence regressed: {sequences:?}"));
        }

        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "get-messages-real-pi",
                "target": target,
                "command": { "type": "get_messages" }
            }),
        )
        .await?;
        let messages_response = read_until(&mut socket, |frame| {
            frame["requestId"] == "get-messages-real-pi"
        })
        .await?;
        if messages_response["response"]["success"] != true {
            return Err(format!("Pi get_messages failed through Host: {messages_response}"));
        }
        let messages = messages_response["response"]["data"]["messages"]
            .as_array()
            .ok_or_else(|| format!("Pi message history missing: {messages_response}"))?;
        let expected_reply = "Pipline Host to Pi integration passed.";
        let found_reply = messages.iter().any(|message| {
            message["role"] == "assistant"
                && message["content"].as_array().is_some_and(|parts| {
                    parts.iter().any(|part| {
                        part["type"] == "text" && part["text"] == expected_reply
                    })
                })
        });
        if !found_reply {
            return Err(format!("expected assistant reply not in Pi history: {messages:?}"));
        }
        let found_write = messages.iter().any(|message| {
            message["role"] == "assistant"
                && message["content"].as_array().is_some_and(|parts| {
                    parts.iter().any(|part| {
                        part["type"] == "toolCall" && part["name"] == "write"
                    })
                })
        });
        let found_write_result = messages.iter().any(|message| {
            message["role"] == "toolResult"
                && message["toolName"] == "write"
                && message["isError"] != true
        });
        if !found_write || !found_write_result {
            return Err(format!("Pi write tool call/result missing from history: {messages:?}"));
        }
        let written_file = fs::read_to_string(workspace.join("pipline-host-smoke.txt"))
            .map_err(|error| format!("read Pi-created file: {error}"))?;
        if written_file != "Pipline Host to Pi write tool passed.\n" {
            return Err(format!("Pi wrote unexpected file content: {written_file:?}"));
        }

        manager
            .stop(&target)
            .map_err(|error| format!("stop first Pi process before session recovery: {error}"))?;
        let recovered_target = RuntimeTarget::new(
            target.workspace_id.clone(),
            target.session_id.clone(),
            "host-smoke-instance-recovered",
        );
        manager
            .spawn(recovered_target.clone(), launch_spec.clone())
            .map_err(|error| format!("restart Pi with saved session: {error}"))?;
        target_for_cleanup = recovered_target.clone();
        send_json(
            &mut socket,
            json!({
                "type": "runtime_subscribe",
                "requestId": "subscribe-recovered-pi",
                "target": recovered_target
            }),
        )
        .await?;
        let recovered_subscription = read_until(&mut socket, |frame| {
            frame["requestId"] == "subscribe-recovered-pi"
        })
        .await?;
        if recovered_subscription["type"] != "runtime_subscribed" {
            return Err(format!("recovered Pi subscription rejected: {recovered_subscription}"));
        }
        send_json(
            &mut socket,
            json!({
                "type": "runtime_request",
                "requestId": "get-recovered-messages",
                "target": recovered_target,
                "command": { "type": "get_messages" }
            }),
        )
        .await?;
        let recovered_messages = read_until(&mut socket, |frame| {
            frame["requestId"] == "get-recovered-messages"
        })
        .await?;
        if recovered_messages["response"]["success"] != true {
            return Err(format!("restored Pi session could not load messages: {recovered_messages}"));
        }
        let restored_history = recovered_messages["response"]["data"]["messages"]
            .as_array()
            .ok_or_else(|| format!("restored Pi history missing: {recovered_messages}"))?;
        let restored_assistant_reply = restored_history.iter().any(|message| {
            message["role"] == "assistant"
                && message["content"].as_array().is_some_and(|parts| {
                    parts.iter().any(|part| {
                        part["type"] == "text"
                            && part["text"] == "Pipline Host to Pi integration passed."
                    })
                })
        });
        if !restored_assistant_reply {
            return Err(format!("Pi did not restore assistant history: {restored_history:?}"));
        }
        let _ = socket.close(None).await;
        Ok::<(), String>(())
    }
    .await;

    let stop_result = manager.stop(&target_for_cleanup);
    host.stop().await;
    provider_task.abort();
    outcome?;
    if provider_observed.request_count.load(Ordering::SeqCst) != 2 {
        return Err(format!(
            "expected two model requests for write plus final reply, got {}",
            provider_observed.request_count.load(Ordering::SeqCst)
        ));
    }
    if !provider_observed.received_write_tool.load(Ordering::SeqCst) {
        return Err("Pi did not advertise its native write tool to the model".into());
    }
    stop_result.map_err(|error| format!("stop bundled Pi: {error}"))
}

async fn fake_chat_completion(
    State(state): State<FakeProviderState>,
    Json(request): Json<Value>,
) -> Response<Body> {
    if request["stream"] != true {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from("the smoke provider requires streaming requests"))
            .expect("build bad request response");
    }
    let request_number = state.request_count.fetch_add(1, Ordering::SeqCst) + 1;
    state.received_write_tool.store(
        state.received_write_tool.load(Ordering::SeqCst)
            || request["tools"]
                .as_array()
                .is_some_and(|tools| tools.iter().any(|tool| tool["function"]["name"] == "write")),
        Ordering::SeqCst,
    );
    let chunks = if request_number == 1 {
        vec![
            json!({
                "id":"chatcmpl-pipline-host-smoke-1",
                "object":"chat.completion.chunk",
                "created":1,
                "model":"host-smoke-model",
                "choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]
            }),
            json!({
                "id":"chatcmpl-pipline-host-smoke-1",
                "object":"chat.completion.chunk",
                "created":1,
                "model":"host-smoke-model",
                "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_pipline_host_smoke_write","type":"function","function":{"name":"write","arguments":json!({"path":"pipline-host-smoke.txt","content":"Pipline Host to Pi write tool passed.\n"}).to_string()}}]},"finish_reason":null}]
            }),
            json!({
                "id":"chatcmpl-pipline-host-smoke-1",
                "object":"chat.completion.chunk",
                "created":1,
                "model":"host-smoke-model",
                "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]
            }),
        ]
    } else {
        vec![
            json!({
                "id":"chatcmpl-pipline-host-smoke-2",
                "object":"chat.completion.chunk",
                "created":1,
                "model":"host-smoke-model",
                "choices":[{"index":0,"delta":{"role":"assistant","content":"Pipline Host to Pi integration passed."},"finish_reason":null}]
            }),
            json!({
                "id":"chatcmpl-pipline-host-smoke-2",
                "object":"chat.completion.chunk",
                "created":1,
                "model":"host-smoke-model",
                "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]
            }),
        ]
    };
    let mut stream = chunks
        .iter()
        .map(|chunk| format!("data: {chunk}\n\n"))
        .collect::<String>();
    stream.push_str("data: [DONE]\n\n");
    Response::builder()
        .header(CONTENT_TYPE, "text/event-stream")
        .body(Body::from(stream))
        .expect("build fake provider stream")
}

async fn fake_workflow_chat_completion(
    State(state): State<FakeWorkflowProviderState>,
    Json(request): Json<Value>,
) -> Response<Body> {
    if request["stream"] != true {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from(
                "the workflow smoke provider requires streaming requests",
            ))
            .expect("build bad request response");
    }
    let request_number = state.request_count.fetch_add(1, Ordering::SeqCst) + 1;
    let received_tool = request["tools"].as_array().is_some_and(|tools| {
        tools
            .iter()
            .any(|tool| tool["function"]["name"] == "pipline_workflow")
    });
    state
        .received_workflow_tool
        .fetch_or(received_tool, Ordering::SeqCst);
    let serialized_messages = request["messages"].to_string();
    if serialized_messages.contains("manual-assign")
        && serialized_messages.contains("manualAnswer")
        && serialized_messages.contains("assign-end")
    {
        state
            .received_manual_workflow_read
            .store(true, Ordering::SeqCst);
    }
    if serialized_messages.contains("run-manual-smoke")
        && serialized_messages.contains("running")
        && serialized_messages.contains("manual-assign")
    {
        state
            .received_active_run_summary
            .store(true, Ordering::SeqCst);
    }
    let chunks = if state
        .next_response_is_tool_call
        .swap(false, Ordering::SeqCst)
    {
        let proposal = state
            .proposal
            .lock()
            .map(|value| value.to_string())
            .unwrap_or_else(|_| "{}".to_owned());
        let call_id = format!("call_pipline_workflow_host_smoke_{request_number}");
        vec![
            json!({
                "id":format!("chatcmpl-pipline-workflow-host-smoke-{request_number}"),
                "object":"chat.completion.chunk",
                "created":1,
                "model":"workflow-host-smoke-model",
                "choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]
            }),
            json!({
                "id":format!("chatcmpl-pipline-workflow-host-smoke-{request_number}"),
                "object":"chat.completion.chunk",
                "created":1,
                "model":"workflow-host-smoke-model",
                "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":call_id,"type":"function","function":{"name":"pipline_workflow","arguments":proposal}}]},"finish_reason":null}]
            }),
            json!({
                "id":format!("chatcmpl-pipline-workflow-host-smoke-{request_number}"),
                "object":"chat.completion.chunk",
                "created":1,
                "model":"workflow-host-smoke-model",
                "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]
            }),
        ]
    } else {
        let operation = state
            .proposal
            .lock()
            .ok()
            .and_then(|proposal| proposal["operation"].as_str().map(str::to_owned));
        let response = if operation.as_deref() == Some("propose_node_meta") {
            "The reusable custom NodeMeta template was saved; its implementation remains an inert draft."
        } else if operation.as_deref() == Some("read")
            && state.received_active_run_summary.load(Ordering::SeqCst)
        {
            "The current workflow run run-manual-smoke is running; its Assign node is active."
        } else if operation.as_deref() == Some("read") {
            "The manually composed workflow is Start → Assign (variable manualAnswer) → End, with the start input connected to Assign and Assign connected to End."
        } else {
            "I added an Assign node and connected it to the workflow."
        };
        vec![
            json!({
                "id":format!("chatcmpl-pipline-workflow-host-smoke-{request_number}"),
                "object":"chat.completion.chunk",
                "created":1,
                "model":"workflow-host-smoke-model",
                "choices":[{"index":0,"delta":{"role":"assistant","content":response},"finish_reason":null}]
            }),
            json!({
                "id":format!("chatcmpl-pipline-workflow-host-smoke-{request_number}"),
                "object":"chat.completion.chunk",
                "created":1,
                "model":"workflow-host-smoke-model",
                "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]
            }),
        ]
    };
    let mut stream = chunks
        .iter()
        .map(|chunk| format!("data: {chunk}\n\n"))
        .collect::<String>();
    stream.push_str("data: [DONE]\n\n");
    Response::builder()
        .header(CONTENT_TYPE, "text/event-stream")
        .body(Body::from(stream))
        .expect("build fake workflow provider stream")
}

async fn read_through_agent_end(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Result<(Value, Vec<Value>), String> {
    let mut events: Vec<Value> = Vec::new();
    loop {
        let frame = read_frame(socket).await.map_err(|error| {
            format!(
                "{error}; observed Pi event types: {:?}",
                events
                    .iter()
                    .filter_map(|event| event["event"]["type"].as_str())
                    .collect::<Vec<_>>()
            )
        })?;
        if frame["type"] == "runtime_event" {
            let is_agent_end = frame["event"]["type"] == "agent_end";
            events.push(frame.clone());
            if is_agent_end {
                return Ok((frame, events));
            }
        }
    }
}

async fn send_json(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    value: Value,
) -> Result<(), String> {
    socket
        .send(Message::Text(value.to_string()))
        .await
        .map_err(|error| format!("send Host frame: {error}"))
}

async fn read_frame(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Result<Value, String> {
    let message = tokio::time::timeout(std::time::Duration::from_secs(20), socket.next())
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

async fn read_until<F>(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
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

async fn read_until_collect_events<F>(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    mut predicate: F,
) -> Result<(Value, Vec<Value>), String>
where
    F: FnMut(&Value) -> bool,
{
    let mut events = Vec::new();
    loop {
        let frame = read_frame(socket).await?;
        if frame["type"] == "runtime_event" {
            events.push(frame.clone());
        }
        if predicate(&frame) {
            return Ok((frame, events));
        }
    }
}
