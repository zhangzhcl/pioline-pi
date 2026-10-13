use super::{MetadataStore, SCHEMA_VERSION};
use serde_json::{json, Value};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[path = "workflow_graph_tests.rs"]
mod workflow_graph_tests;
#[path = "workflow_run_create_tests.rs"]
mod workflow_run_create_tests;
#[path = "workflow_run_recovery_tests.rs"]
mod workflow_run_recovery_tests;
#[path = "workflow_run_replay_tests.rs"]
mod workflow_run_replay_tests;
#[path = "workflow_run_transition_tests.rs"]
mod workflow_run_transition_tests;

fn temp_dir() -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("pipline-metadata-{nonce}"));
    fs::create_dir_all(&path).unwrap();
    path
}

fn custom_template() -> Value {
    let translations = || {
        json!({
            "label": "Example",
            "description": "Example node",
            "inputs": { "input": "Input" },
            "outputs": { "result": "Result" },
            "params": { "count": { "label": "Count" } }
        })
    };
    json!({
        "schemaVersion": 1,
        "id": "custom.example",
        "version": "1.0.0",
        "type": "custom",
        "label": "Example",
        "description": "Example node",
        "inputs": [{ "name": "input", "label": "Input", "type": "object", "required": false, "allowStaticValue": true }],
        "outputs": [{ "name": "result", "label": "Result", "type": "object", "required": false, "allowStaticValue": false }],
        "params": [{ "name": "count", "label": "Count", "type": "number", "required": false }],
        "execution": { "kind": "user-code" },
        "permissions": { "filesystem": "none", "network": "none", "shell": "none" },
        "i18n": {
            "en": translations(),
            "zh": translations(),
            "es": translations(),
            "ja": translations()
        }
    })
}

fn prepare_workflow(store: &mut MetadataStore, workspace: &std::path::Path) -> String {
    fs::create_dir_all(workspace).unwrap();
    let workspace_id = store.workspace_id_for_path(workspace).unwrap();
    assert!(store
        .workflow_node_template_create(&workspace_id, &custom_template())
        .unwrap());
    let start = json!({
        "instanceId": "node-start",
        "meta": { "id": "pipline.start", "version": "1.0.0" },
        "position": { "x": 0, "y": 0 },
        "paramValues": {},
        "portValues": {}
    });
    let node = json!({
        "instanceId": "node-1",
        "meta": { "id": "custom.example", "version": "1.0.0" },
        "position": { "x": 200, "y": 0 },
        "paramValues": { "count": 1 },
        "portValues": {}
    });
    let end = json!({
        "instanceId": "node-end",
        "meta": { "id": "pipline.end", "version": "1.0.0" },
        "position": { "x": 400, "y": 0 },
        "paramValues": { "returnMode": "variable" },
        "portValues": {}
    });
    let workflow = json!({
        "schemaVersion": 1,
        "id": "workflow-run-test",
        "workspaceId": workspace_id,
        "name": "Run persistence test",
        "revision": 0,
        "nodes": [start, node, end],
        "edges": [
            { "id": "edge-start-custom", "sourceNodeId": "node-start", "sourcePort": "input", "targetNodeId": "node-1", "targetPort": "input" },
            { "id": "edge-custom-end", "sourceNodeId": "node-1", "sourcePort": "result", "targetNodeId": "node-end", "targetPort": "result" }
        ],
        "createdAt": "2026-09-27T00:00:00.000Z",
        "updatedAt": "2026-09-27T00:00:00.000Z"
    });
    assert!(store.workflow_create(&workspace_id, &workflow).unwrap());
    workspace_id
}

fn test_run(workspace_id: &str) -> Value {
    let start = json!({
        "instanceId": "node-start",
        "meta": { "id": "pipline.start", "version": "1.0.0" },
        "position": { "x": 0, "y": 0 },
        "paramValues": {},
        "portValues": {}
    });
    let node = json!({
        "instanceId": "node-1",
        "meta": { "id": "custom.example", "version": "1.0.0" },
        "position": { "x": 200, "y": 0 },
        "paramValues": { "count": 1 },
        "portValues": {}
    });
    let end = json!({
        "instanceId": "node-end",
        "meta": { "id": "pipline.end", "version": "1.0.0" },
        "position": { "x": 400, "y": 0 },
        "paramValues": { "returnMode": "variable" },
        "portValues": {}
    });
    let snapshot = json!({
        "schemaVersion": 1,
        "id": "workflow-run-test",
        "workspaceId": workspace_id,
        "name": "Run persistence test",
        "revision": 0,
        "nodes": [start, node, end],
        "edges": [
            { "id": "edge-start-custom", "sourceNodeId": "node-start", "sourcePort": "input", "targetNodeId": "node-1", "targetPort": "input" },
            { "id": "edge-custom-end", "sourceNodeId": "node-1", "sourcePort": "result", "targetNodeId": "node-end", "targetPort": "result" }
        ],
        "createdAt": "2026-09-27T00:00:00.000Z",
        "updatedAt": "2026-09-27T00:00:00.000Z"
    });
    json!({
        "schemaVersion": 1,
        "id": "run-test-1",
        "workflowId": "workflow-run-test",
        "workspaceId": workspace_id,
        "workflowRevision": 0,
        "snapshot": snapshot,
        "nodeMetaSnapshot": {
            "pipline.start@1.0.0": { "id": "pipline.start", "version": "1.0.0" },
            "pipline.end@1.0.0": { "id": "pipline.end", "version": "1.0.0" },
            "custom.example@1.0.0": custom_template()
        },
        "input": {},
        "maxConcurrency": 1,
        "status": "queued",
        "createdAt": "2026-09-27T00:00:00.000Z",
        "updatedAt": "2026-09-27T00:00:00.000Z",
        "nodeStates": {
            "node-start": { "status": "idle", "logs": [], "output": null, "error": null },
            "node-1": { "status": "idle", "logs": [], "output": null, "error": null },
            "node-end": { "status": "idle", "logs": [], "output": null, "error": null }
        },
        "events": [],
        "result": null,
        "error": null
    })
}

fn append_event(
    store: &mut MetadataStore,
    workspace_id: &str,
    run: &Value,
    expected_sequence: i64,
    next_status: &str,
    event_type: &str,
) -> bool {
    let sequence = expected_sequence + 1;
    let timestamp = format!("2026-09-27T00:00:{sequence:02}.000Z");
    let event = json!({
        "id": format!("run-test-1:{sequence}"),
        "runId": "run-test-1",
        "workflowId": "workflow-run-test",
        "revision": 0,
        "type": event_type,
        "timestamp": timestamp,
        "sequence": sequence,
        "result": run.get("result").cloned().unwrap_or(Value::Null),
        "error": run.get("error").cloned().unwrap_or(Value::Null),
        "nodeId": if event_type.starts_with("node_") { Some("node-1") } else { None }
    });
    let mut next = run.clone();
    next["status"] = Value::from(next_status);
    next["updatedAt"] = Value::from(timestamp);
    store
        .workflow_run_append_event("run-test-1", workspace_id, expected_sequence, &next, &event)
        .unwrap()
}

fn append_node_event(
    store: &mut MetadataStore,
    workspace_id: &str,
    run: &Value,
    expected_sequence: i64,
    node_id: &str,
    node_status: &str,
    event_type: &str,
) -> bool {
    let sequence = expected_sequence + 1;
    let timestamp = format!("2026-09-27T00:00:{sequence:02}.000Z");
    let mut next = run.clone();
    next["updatedAt"] = Value::from(timestamp.clone());
    next["nodeStates"][node_id]["status"] = Value::from(node_status);
    store
        .workflow_run_append_event(
            "run-test-1",
            workspace_id,
            expected_sequence,
            &next,
            &json!({
                "id": format!("run-test-1:{sequence}"), "runId": "run-test-1",
                "workflowId": "workflow-run-test", "revision": 0, "type": event_type,
                "timestamp": timestamp, "sequence": sequence, "nodeId": node_id,
                "output": next["nodeStates"][node_id]["output"],
                "error": next["nodeStates"][node_id]["error"]
            }),
        )
        .unwrap()
}

#[test]
fn assigns_stable_workspace_ids_and_stores_only_device_token_hashes() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let store = MetadataStore::open(&database).unwrap();

    let first = store.workspace_id_for_path(&workspace).unwrap();
    let second = store.workspace_id_for_path(&workspace).unwrap();
    assert_eq!(first, second);
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);

    store
        .store_device_token("phone", "plain-device-token")
        .unwrap();
    assert!(store.verify_device_token("plain-device-token").unwrap());
    assert!(!store.verify_device_token("wrong-token").unwrap());
    let bytes = fs::read(&database).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("plain-device-token"));
    store.revoke_device("phone").unwrap();
    assert!(!store.verify_device_token("plain-device-token").unwrap());

    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn preferences_round_trip_json_and_delete() {
    let temp = temp_dir();
    let store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();

    assert_eq!(store.preference_get("ui.chatFontSize").unwrap(), None);
    store
        .preference_set("ui.chatFontSize", &json!("large"))
        .unwrap();
    assert_eq!(
        store.preference_get("ui.chatFontSize").unwrap(),
        Some(json!("large"))
    );
    store
        .preference_set("ui.chatFontSize", &json!({ "level": 3 }))
        .unwrap();
    assert_eq!(
        store.preference_get("ui.chatFontSize").unwrap(),
        Some(json!({ "level": 3 }))
    );
    assert!(store.preference_remove("ui.chatFontSize").unwrap());
    assert_eq!(store.preference_get("ui.chatFontSize").unwrap(), None);
    assert!(!store.preference_remove("ui.chatFontSize").unwrap());

    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn reset_cannot_modify_pi_sessions_or_workspace_files() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let session = workspace.join("session.jsonl");
    fs::write(&session, "{\"type\":\"session\"}\n").unwrap();
    let mut store = MetadataStore::open(&database).unwrap();
    store.workspace_id_for_path(&workspace).unwrap();

    store.reset().unwrap();

    assert_eq!(
        fs::read_to_string(session).unwrap(),
        "{\"type\":\"session\"}\n"
    );
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}
