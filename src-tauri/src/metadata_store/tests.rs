use super::{MetadataStore, SCHEMA_VERSION};
use serde_json::{json, Value};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

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

#[test]
fn workflow_catalog_revision_is_stable_and_changes_when_template_is_added() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = store.workspace_id_for_path(&temp).unwrap();
    let empty_revision = store
        .workflow_node_template_catalog_revision(&workspace_id)
        .unwrap();
    assert_eq!(
        empty_revision,
        store
            .workflow_node_template_catalog_revision(&workspace_id)
            .unwrap()
    );
    assert!(store
        .workflow_node_template_create(&workspace_id, &custom_template())
        .unwrap());
    let populated_revision = store
        .workflow_node_template_catalog_revision(&workspace_id)
        .unwrap();
    assert_ne!(empty_revision, populated_revision);
    assert_eq!(
        populated_revision,
        store
            .workflow_node_template_catalog_revision(&workspace_id)
            .unwrap()
    );
    drop(store);
    fs::remove_dir_all(temp).unwrap();
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

#[test]
fn workflow_node_catalog_cannot_change_while_a_run_is_active() {
    let temp = temp_dir();
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    let catalog_revision = store
        .workflow_node_template_catalog_revision(&workspace_id)
        .unwrap();
    let mut candidate = custom_template();
    candidate["version"] = Value::from("1.1.0");

    assert!(store
        .workflow_node_template_create(&workspace_id, &candidate)
        .unwrap_err()
        .contains("catalog is read-only while a Run is active"));
    assert_eq!(
        store
            .workflow_node_template_catalog_revision(&workspace_id)
            .unwrap(),
        catalog_revision
    );
    assert_eq!(
        store
            .workflow_node_templates_list(&workspace_id)
            .unwrap()
            .len(),
        1
    );

    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_node_template_rejects_invalid_custom_slug_ids() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = store.workspace_id_for_path(&temp).unwrap();

    for invalid_id in ["custom.", "custom.-leading", "custom.Uppercase"] {
        let mut candidate = custom_template();
        candidate["id"] = Value::from(invalid_id);
        assert!(
            store
                .workflow_node_template_create(&workspace_id, &candidate)
                .is_err(),
            "Host accepted invalid custom NodeMeta id {invalid_id}"
        );
    }

    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_graph_cannot_change_while_a_run_is_active() {
    let temp = temp_dir();
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    assert!(append_event(
        &mut store,
        &workspace_id,
        &run,
        0,
        "running",
        "run_started"
    ));
    let loaded = store
        .workflow_load("workflow-run-test", &workspace_id)
        .unwrap()
        .unwrap();
    let mut changed = loaded["workflow"].clone();
    changed["revision"] = Value::from(1);
    changed["nodes"][0]["position"]["x"] = Value::from(24);
    let event = json!({
        "workflowId": "workflow-run-test",
        "workspaceId": workspace_id,
        "revision": 1,
        "schemaVersion": 1,
        "actor": "user",
        "timestamp": "2026-09-28T00:00:01.000Z",
        "command": { "idempotencyKey": "edit-during-active-run" }
    });

    assert!(store
        .workflow_compare_and_swap("workflow-run-test", &workspace_id, 0, &changed, &event)
        .unwrap_err()
        .contains("graph is read-only while a Run is active"));
    let saved = store
        .workflow_load("workflow-run-test", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved["workflow"]["revision"], 0);
    assert_eq!(saved["workflow"]["nodes"][0]["position"]["x"], 0);

    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_create_rejects_dangling_edges_before_persisting() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = store.workspace_id_for_path(&workspace).unwrap();
    let workflow = json!({
        "schemaVersion": 1,
        "id": "workflow-invalid-create",
        "workspaceId": workspace_id,
        "name": "Invalid graph",
        "revision": 0,
        "nodes": [{
            "instanceId": "node-1",
            "meta": { "id": "pipline.start", "version": "1.0.0" },
            "position": { "x": 0, "y": 0 },
            "paramValues": {},
            "portValues": {}
        }],
        "edges": [{
            "id": "edge-1",
            "sourceNodeId": "node-1",
            "sourcePort": "out",
            "targetNodeId": "missing-node",
            "targetPort": "in"
        }],
        "createdAt": "2026-09-27T00:00:00.000Z",
        "updatedAt": "2026-09-27T00:00:00.000Z"
    });

    assert!(store
        .workflow_create(&workspace_id, &workflow)
        .unwrap_err()
        .contains("target node does not exist"));
    assert!(store
        .workflow_load("workflow-invalid-create", &workspace_id)
        .unwrap()
        .is_none());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_create_rejects_missing_start_or_end_before_persisting() {
    let temp = temp_dir();
    let workspace = temp.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = store.workspace_id_for_path(&workspace).unwrap();
    let timestamp = "2026-09-27T00:00:00.000Z";
    let make_workflow = |id: &str, node_id: &str, meta_id: &str| {
        json!({
            "schemaVersion": 1,
            "id": id,
            "workspaceId": workspace_id,
            "name": "Invalid boundary graph",
            "revision": 0,
            "nodes": [{
                "instanceId": node_id,
                "meta": { "id": meta_id, "version": "1.0.0" },
                "position": { "x": 0, "y": 0 },
                "paramValues": {},
                "portValues": {}
            }],
            "edges": [],
            "createdAt": timestamp,
            "updatedAt": timestamp
        })
    };

    let missing_start = make_workflow("workflow-missing-start", "end-only", "pipline.end");
    assert!(store
        .workflow_create(&workspace_id, &missing_start)
        .unwrap_err()
        .contains("exactly one Start"));
    assert!(store
        .workflow_load("workflow-missing-start", &workspace_id)
        .unwrap()
        .is_none());

    let missing_end = make_workflow("workflow-missing-end", "start-only", "pipline.start");
    assert!(store
        .workflow_create(&workspace_id, &missing_end)
        .unwrap_err()
        .contains("at least one End"));
    assert!(store
        .workflow_load("workflow-missing-end", &workspace_id)
        .unwrap()
        .is_none());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_create_rejects_invalid_start_input_schema_before_persisting() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = store.workspace_id_for_path(&workspace).unwrap();
    let workflow = json!({
        "schemaVersion": 1,
        "id": "workflow-invalid-start-schema",
        "workspaceId": workspace_id,
        "name": "Invalid Start schema",
        "revision": 0,
        "nodes": [
            {
                "instanceId": "node-start",
                "meta": { "id": "pipline.start", "version": "1.0.0" },
                "position": { "x": 0, "y": 0 },
                "paramValues": {
                    "inputSchema": {
                        "properties": { "request": { "type": "string", "pattern": ".+" } }
                    }
                },
                "portValues": {}
            },
            {
                "instanceId": "node-end",
                "meta": { "id": "pipline.end", "version": "1.0.0" },
                "position": { "x": 200, "y": 0 },
                "paramValues": {},
                "portValues": {}
            }
        ],
        "edges": [],
        "createdAt": "2026-09-27T00:00:00.000Z",
        "updatedAt": "2026-09-27T00:00:00.000Z"
    });

    assert!(store
        .workflow_create(&workspace_id, &workflow)
        .unwrap_err()
        .contains("Start inputSchema field request contains unsupported schema fields"));
    assert!(store
        .workflow_load("workflow-invalid-start-schema", &workspace_id)
        .unwrap()
        .is_none());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_compare_and_swap_rejects_bad_structure_without_advancing_revision() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let loaded = store
        .workflow_load("workflow-run-test", &workspace_id)
        .unwrap()
        .unwrap();
    let mut malformed = loaded["workflow"].clone();
    malformed["revision"] = Value::from(1);
    malformed["nodes"][0]["position"]["x"] = Value::from("left");

    assert!(store
        .workflow_compare_and_swap(
            "workflow-run-test",
            &workspace_id,
            0,
            &malformed,
            &json!({
                "workflowId": "workflow-run-test",
                "workspaceId": workspace_id,
                "revision": 1,
                "schemaVersion": 1,
                "actor": "user",
                "timestamp": "2026-09-27T00:00:01.000Z",
                "command": { "idempotencyKey": "invalid-position" }
            }),
        )
        .unwrap_err()
        .contains("position"));
    assert_eq!(
        store
            .workflow_load("workflow-run-test", &workspace_id)
            .unwrap()
            .unwrap()["workflow"]["revision"],
        0
    );
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_compare_and_swap_checks_custom_node_meta_types() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let loaded = store
        .workflow_load("workflow-run-test", &workspace_id)
        .unwrap()
        .unwrap();
    let mut malformed = loaded["workflow"].clone();
    malformed["revision"] = Value::from(1);
    malformed["nodes"][1]["paramValues"]["count"] = Value::from("not a number");
    let event = json!({
        "workflowId": "workflow-run-test",
        "workspaceId": workspace_id,
        "revision": 1,
        "schemaVersion": 1,
        "actor": "user",
        "timestamp": "2026-09-27T00:00:01.000Z",
        "command": { "idempotencyKey": "invalid-custom-param" }
    });

    assert!(store
        .workflow_compare_and_swap("workflow-run-test", &workspace_id, 0, &malformed, &event)
        .unwrap_err()
        .contains("custom parameter has an invalid value"));
    assert_eq!(
        store
            .workflow_load("workflow-run-test", &workspace_id)
            .unwrap()
            .unwrap()["workflow"]["revision"],
        0
    );
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_compare_and_swap_checks_builtin_static_port_types() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let loaded = store
        .workflow_load("workflow-run-test", &workspace_id)
        .unwrap()
        .unwrap();
    let mut malformed = loaded["workflow"].clone();
    malformed["revision"] = Value::from(1);
    malformed["nodes"][1]["meta"] = json!({
        "id": "pipline.extract",
        "version": "1.0.0"
    });
    malformed["nodes"][1]["paramValues"] = json!({ "path": "value" });
    malformed["nodes"][1]["portValues"] = json!({
        "source": { "mode": "static", "staticValue": "not an object" }
    });
    malformed["edges"] = json!([{
        "id": "edge-builtin-end",
        "sourceNodeId": "node-1",
        "sourcePort": "value",
        "targetNodeId": "node-end",
        "targetPort": "result"
    }]);
    let event = json!({
        "workflowId": "workflow-run-test",
        "workspaceId": workspace_id,
        "revision": 1,
        "schemaVersion": 1,
        "actor": "user",
        "timestamp": "2026-09-27T00:00:01.000Z",
        "command": { "idempotencyKey": "invalid-builtin-input" }
    });

    assert!(store
        .workflow_compare_and_swap("workflow-run-test", &workspace_id, 0, &malformed, &event)
        .unwrap_err()
        .contains("built-in input has an invalid value"));
    assert_eq!(
        store
            .workflow_load("workflow-run-test", &workspace_id)
            .unwrap()
            .unwrap()["workflow"]["revision"],
        0
    );
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_create_checks_custom_node_meta_snapshot_contracts() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let mut run = test_run(&workspace_id);
    run["snapshot"]["nodes"][1]["paramValues"]["count"] = Value::from("not a number");

    assert!(store
        .workflow_run_create(&workspace_id, &run)
        .unwrap_err()
        .contains("custom parameter has an invalid value"));
    assert!(store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .is_none());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_create_checks_builtin_static_values_against_frozen_node_meta() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let mut run = test_run(&workspace_id);
    run["snapshot"]["edges"] = json!([
        {
            "id": "edge-start-custom",
            "sourceNodeId": "node-start",
            "sourcePort": "input",
            "targetNodeId": "node-1",
            "targetPort": "input"
        }
    ]);
    run["snapshot"]["nodes"][2]["portValues"] = json!({
        "result": { "mode": "static", "staticValue": "not a number" }
    });
    run["nodeMetaSnapshot"]["pipline.end@1.0.0"] = json!({
        "id": "pipline.end",
        "version": "1.0.0",
        "inputs": [{
            "name": "result",
            "type": "number",
            "allowStaticValue": true
        }],
        "outputs": []
    });

    let result = store.workflow_run_create(&workspace_id, &run);
    assert!(result
        .unwrap_err()
        .contains("built-in input has an invalid value"));
    assert!(store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .is_none());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_create_rejects_invalid_max_concurrency() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let invalid_values = [json!(0), json!(5), json!(1.5)];
    let errors: Vec<_> = invalid_values
        .into_iter()
        .enumerate()
        .map(|(index, value)| {
            let mut run = test_run(&workspace_id);
            run["id"] = Value::from(format!("run-invalid-concurrency-{index}"));
            run["maxConcurrency"] = value;
            store.workflow_run_create(&workspace_id, &run).unwrap_err()
        })
        .collect();
    let persisted: Vec<_> = (0..3)
        .map(|index| {
            store
                .workflow_run_load(&format!("run-invalid-concurrency-{index}"), &workspace_id)
                .unwrap()
                .is_some()
        })
        .collect();
    drop(store);
    fs::remove_dir_all(temp).unwrap();

    assert!(errors.iter().all(|error| error.contains("maxConcurrency")));
    assert_eq!(persisted, [false, false, false]);
}

#[test]
fn workflow_run_create_rejects_node_output_over_the_runner_limit() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let mut run = test_run(&workspace_id);
    run["id"] = Value::from("run-oversized-node-output");
    run["nodeStates"]["node-1"]["output"] = json!({
        "result": "x".repeat(512 * 1024)
    });
    let result = store.workflow_run_create(&workspace_id, &run);
    let persisted = store
        .workflow_run_load("run-oversized-node-output", &workspace_id)
        .unwrap()
        .is_some();
    drop(store);
    fs::remove_dir_all(temp).unwrap();

    assert!(result
        .unwrap_err()
        .contains("Workflow node output exceeds the 512 KB limit"));
    assert!(!persisted);
}

#[test]
fn workflow_run_create_rejects_non_object_start_input() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let mut run = test_run(&workspace_id);
    run["id"] = Value::from("run-invalid-start-input");
    run["input"] = Value::from("not-an-object");
    let result = store.workflow_run_create(&workspace_id, &run);
    let persisted = store
        .workflow_run_load("run-invalid-start-input", &workspace_id)
        .unwrap()
        .is_some();
    drop(store);
    fs::remove_dir_all(temp).unwrap();

    assert!(result
        .unwrap_err()
        .contains("Workflow input must be an object"));
    assert!(!persisted);
}

#[test]
fn workflow_run_create_rejects_start_input_over_the_runner_limit() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let mut run = test_run(&workspace_id);
    run["id"] = Value::from("run-oversized-start-input");
    run["input"] = json!({ "value": "x".repeat(512 * 1024) });
    let result = store.workflow_run_create(&workspace_id, &run);
    let persisted = store
        .workflow_run_load("run-oversized-start-input", &workspace_id)
        .unwrap()
        .is_some();
    drop(store);
    fs::remove_dir_all(temp).unwrap();

    assert!(result
        .unwrap_err()
        .contains("Workflow input exceeds the 512 KB limit"));
    assert!(!persisted);
}

#[test]
fn validates_nested_start_input_schema_values() {
    assert!(super::workflow_validation::validate_workflow_start_input(
        &json!({}),
        &json!({ "required": [] })
    )
    .is_ok());
    let schema = json!({
        "properties": {
            "profile": {
                "type": "object",
                "properties": {
                    "name": "string",
                    "settings": {
                        "type": "object",
                        "properties": { "enabled": "boolean" },
                        "required": ["enabled"]
                    }
                },
                "required": ["name", "settings"]
            },
            "tags": { "type": "array", "items": "string" }
        },
        "required": ["profile"]
    });
    assert!(super::workflow_validation::validate_workflow_start_input(
        &json!({
            "profile": { "name": "Pipline", "settings": { "enabled": true } },
            "tags": ["workflow"]
        }),
        &schema
    )
    .is_ok());
    assert!(super::workflow_validation::validate_workflow_start_input(
        &json!({
            "profile": { "name": "Pipline", "settings": { "enabled": "yes" } }
        }),
        &schema
    )
    .unwrap_err()
    .contains("Workflow input field profile.settings.enabled must be boolean"));
}

#[test]
fn workflow_run_append_enforces_event_count_and_terminal_reserve() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let append_at = |store: &mut MetadataStore, expected_sequence, event_type| {
        let mut run = test_run(&workspace_id);
        run["status"] = Value::from("running");
        let sequence = expected_sequence + 1;
        let event = json!({
            "id": format!("run-test-1:{sequence}"),
            "runId": "run-test-1",
            "workflowId": "workflow-run-test",
            "revision": 0,
            "type": event_type,
            "timestamp": "2026-09-27T00:00:00.000Z",
            "sequence": sequence,
            "nodeId": "node-1",
            "message": "log"
        });
        store.workflow_run_append_event(
            "run-test-1",
            &workspace_id,
            expected_sequence,
            &run,
            &event,
        )
    };
    let nonterminal_at_reserve = append_at(&mut store, 9992, "node_log");
    let terminal_inside_reserve = append_at(&mut store, 9999, "run_failed");
    let terminal_at_limit = append_at(&mut store, 10_000, "run_failed");
    drop(store);
    fs::remove_dir_all(temp).unwrap();

    assert!(nonterminal_at_reserve
        .unwrap_err()
        .contains("Workflow run reached the 10,000 event limit"));
    assert!(!terminal_inside_reserve.unwrap());
    assert!(terminal_at_limit
        .unwrap_err()
        .contains("Workflow run reached the 10,000 event limit"));
}

#[test]
fn workflow_run_create_validates_graph_even_without_frozen_meta_snapshot() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let mut run = test_run(&workspace_id);
    run["id"] = Value::from("run-without-frozen-meta");
    run.as_object_mut().unwrap().remove("nodeMetaSnapshot");
    run["snapshot"]["nodes"][0]["meta"]["id"] = Value::from("pipline.assign");

    assert!(store
        .workflow_run_create(&workspace_id, &run)
        .unwrap_err()
        .contains("exactly one Start node"));
    assert!(store
        .workflow_run_load("run-without-frozen-meta", &workspace_id)
        .unwrap()
        .is_none());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_create_validates_builtin_edge_ports_in_frozen_snapshot() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let mut run = test_run(&workspace_id);
    run["nodeMetaSnapshot"]["pipline.start@1.0.0"]["inputs"] = json!([]);
    run["nodeMetaSnapshot"]["pipline.start@1.0.0"]["outputs"] = json!([
        { "name": "input", "type": "object" }
    ]);
    run["nodeMetaSnapshot"]["pipline.end@1.0.0"]["outputs"] = json!([]);
    run["nodeMetaSnapshot"]["pipline.end@1.0.0"]["inputs"] = json!([
        { "name": "result", "type": "any", "multi": false }
    ]);
    run["snapshot"]["edges"][0]["sourcePort"] = Value::from("misspelled");

    assert!(store
        .workflow_run_create(&workspace_id, &run)
        .unwrap_err()
        .contains("unknown outputs port"));
    assert!(store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .is_none());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_create_checks_types_between_builtin_and_custom_ports() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let mut run = test_run(&workspace_id);
    run["nodeMetaSnapshot"]["pipline.start@1.0.0"]["inputs"] = json!([]);
    run["nodeMetaSnapshot"]["pipline.start@1.0.0"]["outputs"] = json!([
        { "name": "input", "type": "object" }
    ]);
    run["nodeMetaSnapshot"]["custom.example@1.0.0"]["inputs"][0]["type"] = Value::from("string");

    assert!(store
        .workflow_run_create(&workspace_id, &run)
        .unwrap_err()
        .contains("incompatible port types"));
    assert!(store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .is_none());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_create_rejects_snapshot_from_stale_revision() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let loaded = store
        .workflow_load("workflow-run-test", &workspace_id)
        .unwrap()
        .unwrap();
    let mut latest = loaded["workflow"].clone();
    latest["revision"] = Value::from(1);
    latest["updatedAt"] = Value::from("2026-09-27T00:00:01.000Z");
    assert!(store
        .workflow_compare_and_swap(
            "workflow-run-test",
            &workspace_id,
            0,
            &latest,
            &json!({
                "workflowId": "workflow-run-test",
                "workspaceId": workspace_id,
                "revision": 1,
                "schemaVersion": 1,
                "actor": "user",
                "timestamp": "2026-09-27T00:00:01.000Z",
                "command": { "idempotencyKey": "advance-before-run" }
            }),
        )
        .unwrap());
    let run = test_run(&workspace_id);

    assert!(store
        .workflow_run_create(&workspace_id, &run)
        .unwrap_err()
        .contains("Workflow changed after this Run snapshot was prepared"));
    assert!(store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .is_none());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_create_rejects_modified_graph_with_current_revision() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let mut run = test_run(&workspace_id);
    run["snapshot"]["nodes"][1]["paramValues"]["count"] = Value::from(99);

    assert!(store
        .workflow_run_create(&workspace_id, &run)
        .unwrap_err()
        .contains("Run snapshot does not match the saved workflow revision"));
    assert!(store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .is_none());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_create_rejects_invalid_start_schema_in_frozen_graph() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let mut run = test_run(&workspace_id);
    run["id"] = Value::from("run-invalid-start-schema");
    run["snapshot"]["nodes"][0]["paramValues"] = json!({
        "inputSchema": {
            "properties": { "request": { "type": "string", "pattern": ".+" } }
        }
    });

    assert!(store
        .workflow_run_create(&workspace_id, &run)
        .unwrap_err()
        .contains("Start inputSchema field request contains unsupported schema fields"));
    drop(store);
    fs::remove_dir_all(temp).unwrap();
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
    let mut store = MetadataStore::open(&database).unwrap();

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
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();

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

#[test]
fn workflow_run_event_sequence_is_atomic_and_allows_only_one_active_run() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());

    let mut duplicate = test_run(&workspace_id);
    duplicate["id"] = Value::from("run-test-2");
    assert!(!store
        .workflow_run_create(&workspace_id, &duplicate)
        .unwrap());

    let mut running = run.clone();
    running["status"] = Value::from("running");
    assert!(append_event(
        &mut store,
        &workspace_id,
        &running,
        0,
        "running",
        "run_started"
    ));
    assert!(!append_event(
        &mut store,
        &workspace_id,
        &running,
        0,
        "running",
        "node_started"
    ));
    assert!(append_node_event(
        &mut store,
        &workspace_id,
        &running,
        1,
        "node-start",
        "success",
        "node_completed"
    ));
    let mut node_started = running.clone();
    node_started["nodeStates"]["node-start"]["status"] = Value::from("success");
    node_started["nodeStates"]["node-1"]["status"] = Value::from("running");
    assert!(append_node_event(
        &mut store,
        &workspace_id,
        &node_started,
        2,
        "node-1",
        "running",
        "node_started"
    ));
    let mut node_running = node_started;
    node_running["nodeStates"]["node-1"]["status"] = Value::from("running");
    assert!(append_node_event(
        &mut store,
        &workspace_id,
        &node_running,
        3,
        "node-1",
        "success",
        "node_completed"
    ));
    let mut node_succeeded = node_running.clone();
    node_succeeded["nodeStates"]["node-1"]["status"] = Value::from("success");
    assert!(append_node_event(
        &mut store,
        &workspace_id,
        &node_succeeded,
        4,
        "node-end",
        "success",
        "node_completed"
    ));
    let mut succeeded = node_succeeded;
    succeeded["nodeStates"]["node-end"]["status"] = Value::from("success");
    succeeded["result"] = json!({ "value": 42 });
    assert!(append_event(
        &mut store,
        &workspace_id,
        &succeeded,
        5,
        "success",
        "run_completed"
    ));

    let saved = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved["run"]["status"], "success");
    assert_eq!(saved["run"]["result"]["value"], 42);
    assert_eq!(saved["events"].as_array().unwrap().len(), 6);
    assert_eq!(saved["events"][5]["sequence"], 6);
    assert_eq!(
        store
            .workflow_run_list("workflow-run-test", &workspace_id, 50)
            .unwrap()[0]["status"],
        "success"
    );

    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_create_rejects_node_states_that_do_not_match_snapshot() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let mut run = test_run(&workspace_id);
    run["nodeStates"]["node-1"]["status"] = Value::from("mystery");
    assert!(store.workflow_run_create(&workspace_id, &run).is_err());

    let mut run = test_run(&workspace_id);
    run["nodeStates"]["unexpected-node"] = json!({
        "status": "idle", "logs": [], "output": null, "error": null
    });
    assert!(store.workflow_run_create(&workspace_id, &run).is_err());
    assert!(store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .is_none());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_create_rejects_non_pristine_initial_state() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));

    let mut run = test_run(&workspace_id);
    run["result"] = json!({ "forged": true });
    assert!(store
        .workflow_run_create(&workspace_id, &run)
        .unwrap_err()
        .contains("empty results and idle nodes"));

    let mut run = test_run(&workspace_id);
    run["nodeStates"]["node-1"]["status"] = Value::from("success");
    assert!(store
        .workflow_run_create(&workspace_id, &run)
        .unwrap_err()
        .contains("empty results and idle nodes"));
    assert!(store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .is_none());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_create_strips_ephemeral_retry_seed_states_before_persistence() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let mut run = test_run(&workspace_id);
    run["retryOfRunId"] = Value::from("run-previous");
    run["resumeFromNodeId"] = Value::from("node-1");
    run["retrySeedStates"] = json!({
        "node-start": { "status": "success", "output": { "input": { "request": "retained" } } }
    });

    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    let saved = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert!(saved["run"].get("retrySeedStates").is_none());

    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_nonterminal_event_cannot_mutate_top_level_result_or_error() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());

    let mut forged = run.clone();
    forged["status"] = Value::from("running");
    forged["result"] = json!({ "forged": true });
    let event = json!({
        "id": "run-test-1:1", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "run_started", "timestamp": "2026-09-27T00:00:01.000Z",
        "sequence": 1
    });
    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 0, &forged, &event)
        .unwrap_err()
        .contains("result or error changed during run_started"));

    let saved = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved["run"]["status"], "queued");
    assert_eq!(saved["run"]["result"], Value::Null);
    assert!(saved["events"].as_array().unwrap().is_empty());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_load_rejects_status_that_disagrees_with_sqlite_index() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    store
        .connection
        .execute(
            "UPDATE workflow_runs SET status = 'running' WHERE run_id = 'run-test-1'",
            [],
        )
        .unwrap();

    assert!(store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap_err()
        .contains("SQLite index disagrees with the stored Run"));
    assert!(store
        .workflow_run_list("workflow-run-test", &workspace_id, 50)
        .unwrap_err()
        .contains("SQLite index disagrees with the stored Run"));
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_load_rejects_event_history_with_missing_sequence() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    assert!(append_event(
        &mut store,
        &workspace_id,
        &run,
        0,
        "running",
        "run_started"
    ));
    store
        .connection
        .execute(
            "DELETE FROM workflow_run_events WHERE run_id = 'run-test-1' AND sequence = 1",
            [],
        )
        .unwrap();

    assert!(store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap_err()
        .contains("event sequence disagrees with its event history"));
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_load_rejects_event_payload_that_does_not_replay_to_snapshot() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    assert!(append_event(
        &mut store,
        &workspace_id,
        &run,
        0,
        "running",
        "run_started"
    ));
    let raw: String = store
        .connection
        .query_row(
            "SELECT event_json FROM workflow_run_events WHERE run_id = 'run-test-1' AND sequence = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut event: Value = serde_json::from_str(&raw).unwrap();
    event["type"] = Value::from("node_started");
    event["nodeId"] = Value::from("node-start");
    store
        .connection
        .execute(
            "UPDATE workflow_run_events SET event_json = ?1 WHERE run_id = 'run-test-1' AND sequence = 1",
            [serde_json::to_string(&event).unwrap()],
        )
        .unwrap();

    assert!(store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap_err()
        .contains("event history does not replay to the stored Run"));
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_append_rejects_update_time_that_disagrees_with_event_time() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    let mut next = run.clone();
    next["status"] = Value::from("running");
    let event = json!({
        "id": "run-test-1:1", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "run_started", "timestamp": "2026-09-27T00:00:01.000Z",
        "sequence": 1
    });

    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 0, &next, &event)
        .unwrap_err()
        .contains("updatedAt does not match the event timestamp"));
    let saved = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved["run"]["status"], "queued");
    assert!(saved["events"].as_array().unwrap().is_empty());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_completed_event_must_contain_result_even_when_null() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    assert!(append_event(
        &mut store,
        &workspace_id,
        &run,
        0,
        "running",
        "run_started"
    ));

    let mut completed = run.clone();
    completed["status"] = Value::from("success");
    completed["updatedAt"] = Value::from("2026-09-27T00:00:02.000Z");
    let event = json!({
        "id": "run-test-1:2", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "run_completed", "timestamp": "2026-09-27T00:00:02.000Z",
        "sequence": 2
    });
    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 1, &completed, &event)
        .unwrap_err()
        .contains("run_completed event is missing result"));
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_node_skipped_event_must_contain_reason() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    assert!(append_event(
        &mut store,
        &workspace_id,
        &run,
        0,
        "running",
        "run_started"
    ));

    let mut skipped = run.clone();
    skipped["status"] = Value::from("running");
    skipped["updatedAt"] = Value::from("2026-09-27T00:00:02.000Z");
    skipped["nodeStates"]["node-1"]["status"] = Value::from("skipped");
    let event = json!({
        "id": "run-test-1:2", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "node_skipped", "timestamp": "2026-09-27T00:00:02.000Z",
        "sequence": 2, "nodeId": "node-1"
    });
    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 1, &skipped, &event)
        .unwrap_err()
        .contains("node_skipped event is missing its reason"));
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_interrupted_event_must_explicitly_list_skipped_nodes() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    let mut interrupted = run.clone();
    interrupted["status"] = Value::from("interrupted");
    interrupted["error"] = Value::from("Host recovery");
    interrupted["updatedAt"] = Value::from("2026-09-27T00:00:01.000Z");
    let event = json!({
        "id": "run-test-1:1", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "run_interrupted", "timestamp": "2026-09-27T00:00:01.000Z",
        "sequence": 1, "error": "Host recovery"
    });
    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 0, &interrupted, &event)
        .unwrap_err()
        .contains("run_interrupted event is missing skippedNodeIds"));
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_interrupted_skipped_node_ids_must_exactly_match_idle_transitions() {
    let cases = [
        (
            "duplicate",
            vec!["node-end", "node-end"],
            vec!["node-end"],
            false,
            "skippedNodeIds are invalid",
        ),
        (
            "unknown",
            vec!["missing-node"],
            vec![],
            false,
            "must reference idle nodes",
        ),
        (
            "non-idle",
            vec!["node-start"],
            vec![],
            true,
            "must reference idle nodes",
        ),
        (
            "omitted",
            vec![],
            vec!["node-end"],
            false,
            "invalid node state transition",
        ),
    ];

    for (case_id, skipped_node_ids, skipped_states, complete_start, expected_error) in cases {
        let temp = temp_dir();
        let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
        let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
        let run = test_run(&workspace_id);
        assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
        let mut previous = run.clone();
        previous["status"] = Value::from("running");
        assert!(append_event(
            &mut store,
            &workspace_id,
            &previous,
            0,
            "running",
            "run_started"
        ));
        let mut expected_sequence = 1;
        if complete_start {
            assert!(append_node_event(
                &mut store,
                &workspace_id,
                &previous,
                expected_sequence,
                "node-start",
                "success",
                "node_completed"
            ));
            previous["nodeStates"]["node-start"]["status"] = Value::from("success");
            expected_sequence += 1;
        }

        let timestamp = format!("2026-09-27T00:00:{:02}.000Z", expected_sequence + 1);
        let mut interrupted = previous.clone();
        interrupted["status"] = Value::from("interrupted");
        interrupted["error"] = Value::from(case_id);
        interrupted["updatedAt"] = Value::from(timestamp.clone());
        for node_id in &skipped_states {
            interrupted["nodeStates"][*node_id]["status"] = Value::from("skipped");
        }
        let event = json!({
            "id": format!("run-test-1:{}", expected_sequence + 1),
            "runId": "run-test-1", "workflowId": "workflow-run-test", "revision": 0,
            "type": "run_interrupted", "timestamp": timestamp,
            "sequence": expected_sequence + 1, "error": case_id,
            "skippedNodeIds": skipped_node_ids
        });
        assert!(store
            .workflow_run_append_event(
                "run-test-1",
                &workspace_id,
                expected_sequence,
                &interrupted,
                &event,
            )
            .unwrap_err()
            .contains(expected_error));
        let saved = store
            .workflow_run_load("run-test-1", &workspace_id)
            .unwrap()
            .unwrap();
        assert_eq!(saved["run"]["status"], "running");
        assert_eq!(
            saved["events"].as_array().unwrap().len() as i64,
            expected_sequence
        );
        drop(store);
        fs::remove_dir_all(temp).unwrap();
    }
}

#[test]
fn legacy_interrupted_event_compatibility_does_not_accept_extra_node_mutations() {
    for tamper_output in [false, true] {
        let temp = temp_dir();
        let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
        let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
        let run = test_run(&workspace_id);
        assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
        assert!(append_event(
            &mut store,
            &workspace_id,
            &run,
            0,
            "running",
            "run_started"
        ));

        let timestamp = "2026-09-27T00:00:02.000Z";
        let mut interrupted = run.clone();
        interrupted["status"] = Value::from("interrupted");
        interrupted["error"] = Value::from("Older Host recovery");
        interrupted["updatedAt"] = Value::from(timestamp);
        interrupted["nodeStates"]["node-end"]["status"] = Value::from("skipped");
        if tamper_output {
            interrupted["nodeStates"]["node-end"]["output"] = json!({ "forged": true });
        }
        interrupted.as_object_mut().unwrap().remove("events");
        store
            .connection
            .execute(
                "UPDATE workflow_runs SET event_sequence = 2, status = 'interrupted', run_json = ?1, updated_at = ?2 WHERE run_id = 'run-test-1'",
                [serde_json::to_string(&interrupted).unwrap(), timestamp.to_string()],
            )
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO workflow_run_events (run_id, sequence, event_json) VALUES ('run-test-1', 2, ?1)",
                [serde_json::to_string(&json!({
                    "id": "run-test-1:2", "runId": "run-test-1", "workflowId": "workflow-run-test",
                    "revision": 0, "type": "run_interrupted", "timestamp": timestamp,
                    "sequence": 2, "error": "Older Host recovery"
                }))
                .unwrap()],
            )
            .unwrap();

        let result = store.workflow_run_load("run-test-1", &workspace_id);
        if tamper_output {
            assert!(result
                .unwrap_err()
                .contains("event history does not replay to the stored Run"));
        } else {
            let loaded = result.unwrap().unwrap();
            assert_eq!(loaded["run"]["status"], "interrupted");
            assert_eq!(loaded["run"]["nodeStates"]["node-end"]["status"], "skipped");
            assert!(loaded["events"][1].get("skippedNodeIds").is_none());
        }
        drop(store);
        fs::remove_dir_all(temp).unwrap();
    }
}

#[test]
fn workflow_run_append_rejects_malformed_node_state_without_persisting_event() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    let mut malformed = run.clone();
    malformed["status"] = Value::from("running");
    malformed["nodeStates"]["node-1"]["status"] = Value::from("running");
    malformed["nodeStates"]["node-1"]["logs"] = json!(["ok", 4]);
    let event = json!({
        "id": "run-test-1:1", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "run_started", "timestamp": "2026-09-27T00:00:01.000Z",
        "sequence": 1
    });
    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 0, &malformed, &event)
        .is_err());
    let saved = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved["run"]["status"], "queued");
    assert!(saved["events"].as_array().unwrap().is_empty());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_append_rejects_unknown_event_type() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    let mut next = run.clone();
    next["status"] = Value::from("running");
    next["nodeStates"]["node-1"]["status"] = Value::from("running");
    let event = json!({
        "id": "run-test-1:1", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "invented_event", "timestamp": "2026-09-27T00:00:01.000Z",
        "sequence": 1
    });
    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 0, &next, &event)
        .is_err());
    let saved = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved["run"]["status"], "queued");
    assert!(saved["events"].as_array().unwrap().is_empty());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_append_rejects_event_and_node_state_mismatches() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    let mut started = run.clone();
    started["status"] = Value::from("running");
    assert!(append_event(
        &mut store,
        &workspace_id,
        &started,
        0,
        "running",
        "run_started"
    ));

    let idle = started.clone();
    assert!(store
        .workflow_run_append_event(
            "run-test-1",
            &workspace_id,
            1,
            &idle,
            &json!({
                "id": "run-test-1:2", "runId": "run-test-1", "workflowId": "workflow-run-test",
                "revision": 0, "type": "node_started", "timestamp": "2026-09-27T00:00:02.000Z",
                "sequence": 2, "nodeId": "node-1"
            })
        )
        .is_err());

    let mut completed = started.clone();
    completed["status"] = Value::from("success");
    assert!(store
        .workflow_run_append_event(
            "run-test-1",
            &workspace_id,
            1,
            &completed,
            &json!({
                "id": "run-test-1:2", "runId": "run-test-1", "workflowId": "workflow-run-test",
                "revision": 0, "type": "run_completed", "timestamp": "2026-09-27T00:00:02.000Z",
                "sequence": 2, "result": null
            })
        )
        .is_err());

    let saved = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved["run"]["status"], "running");
    assert_eq!(saved["events"].as_array().unwrap().len(), 1);
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_append_rejects_interrupted_terminal_state_with_running_nodes() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    assert!(append_event(
        &mut store,
        &workspace_id,
        &run,
        0,
        "running",
        "run_started"
    ));
    let mut active = run.clone();
    active["status"] = Value::from("running");
    active["nodeStates"]["node-1"]["status"] = Value::from("running");
    assert!(append_event(
        &mut store,
        &workspace_id,
        &active,
        1,
        "running",
        "node_started"
    ));

    assert!(store
        .workflow_run_append_event(
            "run-test-1",
            &workspace_id,
            2,
            &{
                let mut interrupted = active.clone();
                interrupted["status"] = Value::from("interrupted");
                interrupted["error"] = Value::from("application stopped");
                interrupted
            },
            &json!({
                "id": "run-test-1:3", "runId": "run-test-1", "workflowId": "workflow-run-test",
                "revision": 0, "type": "run_interrupted", "timestamp": "2026-09-27T00:00:03.000Z",
                "sequence": 3, "error": "application stopped", "skippedNodeIds": []
            })
        )
        .unwrap_err()
        .contains("running node"));

    let saved = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved["run"]["status"], "running");
    assert_eq!(saved["run"]["nodeStates"]["node-1"]["status"], "running");
    assert_eq!(saved["events"].as_array().unwrap().len(), 2);
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_completed_cannot_forge_node_success_states() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    assert!(append_event(
        &mut store,
        &workspace_id,
        &run,
        0,
        "running",
        "run_started"
    ));

    let mut forged = run.clone();
    forged["status"] = Value::from("success");
    forged["result"] = json!({ "value": 42 });
    for state in forged["nodeStates"].as_object_mut().unwrap().values_mut() {
        state["status"] = Value::from("success");
    }
    let event = json!({
        "id": "run-test-1:2", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "run_completed", "timestamp": "2026-09-27T00:00:02.000Z",
        "sequence": 2, "result": { "value": 42 }
    });

    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 1, &forged, &event)
        .unwrap_err()
        .contains("node state changed during run_completed"));
    let saved = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved["run"]["status"], "running");
    assert_eq!(saved["run"]["nodeStates"]["node-1"]["status"], "idle");
    assert_eq!(saved["events"].as_array().unwrap().len(), 1);
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_started_cannot_forge_node_states() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    let mut forged = run.clone();
    forged["status"] = Value::from("running");
    for state in forged["nodeStates"].as_object_mut().unwrap().values_mut() {
        state["status"] = Value::from("success");
    }
    let event = json!({
        "id": "run-test-1:1", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "run_started", "timestamp": "2026-09-27T00:00:01.000Z",
        "sequence": 1
    });

    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 0, &forged, &event)
        .unwrap_err()
        .contains("node state changed during run_started"));
    let saved = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved["run"]["status"], "queued");
    assert_eq!(saved["run"]["nodeStates"]["node-1"]["status"], "idle");
    assert!(saved["events"].as_array().unwrap().is_empty());
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_failed_cannot_forge_node_failure_states() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    assert!(append_event(
        &mut store,
        &workspace_id,
        &run,
        0,
        "running",
        "run_started"
    ));

    let mut forged = run.clone();
    forged["status"] = Value::from("error");
    forged["error"] = Value::from("failure");
    forged["nodeStates"]["node-1"]["status"] = Value::from("error");
    forged["nodeStates"]["node-1"]["error"] = Value::from("forged terminal result");
    let event = json!({
        "id": "run-test-1:2", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "run_failed", "timestamp": "2026-09-27T00:00:02.000Z",
        "sequence": 2, "error": "failure"
    });

    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 1, &forged, &event)
        .unwrap_err()
        .contains("node state changed during run_failed"));
    let saved = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved["run"]["status"], "running");
    assert_eq!(saved["run"]["nodeStates"]["node-1"]["status"], "idle");
    assert_eq!(saved["events"].as_array().unwrap().len(), 1);
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_run_interrupted_only_allows_recovery_state_transitions() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    assert!(append_event(
        &mut store,
        &workspace_id,
        &run,
        0,
        "running",
        "run_started"
    ));

    let mut forged = run.clone();
    forged["status"] = Value::from("interrupted");
    forged["error"] = Value::from("Application exited while the workflow run was active.");
    for state in forged["nodeStates"].as_object_mut().unwrap().values_mut() {
        state["status"] = Value::from("success");
    }
    let event = json!({
        "id": "run-test-1:2", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "run_interrupted", "timestamp": "2026-09-27T00:00:02.000Z",
        "sequence": 2, "error": "Application exited while the workflow run was active.",
        "skippedNodeIds": []
    });

    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 1, &forged, &event)
        .unwrap_err()
        .contains("invalid node state transition"));

    let mut active = run.clone();
    active["status"] = Value::from("running");
    active["nodeStates"]["node-1"]["status"] = Value::from("running");
    assert!(append_node_event(
        &mut store,
        &workspace_id,
        &active,
        1,
        "node-1",
        "running",
        "node_started"
    ));
    let mut recovered = active;
    recovered["status"] = Value::from("interrupted");
    recovered["nodeStates"]["node-1"]["status"] = Value::from("interrupted");
    recovered["nodeStates"]["node-1"]["error"] = Value::from("application stopped");
    recovered["nodeStates"]["node-end"]["status"] = Value::from("skipped");
    recovered["error"] = Value::from("application stopped");
    recovered["updatedAt"] = Value::from("2026-09-27T00:00:03.000Z");
    let event = json!({
        "id": "run-test-1:3", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "run_interrupted", "timestamp": "2026-09-27T00:00:03.000Z",
        "sequence": 3, "error": "application stopped", "skippedNodeIds": ["node-end"]
    });
    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 2, &recovered, &event)
        .unwrap());

    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_node_event_cannot_change_an_unrelated_node_state() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    assert!(append_event(
        &mut store,
        &workspace_id,
        &run,
        0,
        "running",
        "run_started"
    ));

    let mut forged = run.clone();
    forged["status"] = Value::from("running");
    forged["nodeStates"]["node-1"]["status"] = Value::from("running");
    forged["nodeStates"]["node-start"]["status"] = Value::from("success");
    let event = json!({
        "id": "run-test-1:2", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "node_started", "timestamp": "2026-09-27T00:00:02.000Z",
        "sequence": 2, "nodeId": "node-1"
    });
    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 1, &forged, &event)
        .unwrap_err()
        .contains("changed an unrelated node state"));

    let saved = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved["run"]["nodeStates"]["node-start"]["status"], "idle");
    assert_eq!(saved["events"].as_array().unwrap().len(), 1);
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn workflow_node_failure_state_must_match_its_event_payload() {
    let temp = temp_dir();
    let mut store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
    let workspace_id = prepare_workflow(&mut store, &temp.join("workspace"));
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    assert!(append_event(
        &mut store,
        &workspace_id,
        &run,
        0,
        "running",
        "run_started"
    ));
    let mut running = run.clone();
    running["status"] = Value::from("running");
    assert!(append_node_event(
        &mut store,
        &workspace_id,
        &running,
        1,
        "node-1",
        "running",
        "node_started"
    ));
    let mut failed = running.clone();
    failed["nodeStates"]["node-1"]["status"] = Value::from("error");
    failed["nodeStates"]["node-1"]["output"] = Value::Null;
    failed["nodeStates"]["node-1"]["error"] = Value::from("forged failure");
    let event = json!({
        "id": "run-test-1:3", "runId": "run-test-1", "workflowId": "workflow-run-test",
        "revision": 0, "type": "node_failed", "timestamp": "2026-09-27T00:00:03.000Z",
        "sequence": 3, "nodeId": "node-1", "error": "actual failure"
    });

    assert!(store
        .workflow_run_append_event("run-test-1", &workspace_id, 2, &failed, &event)
        .unwrap_err()
        .contains("does not match event node_failed"));
    let saved = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved["run"]["nodeStates"]["node-1"]["status"], "running");
    assert_eq!(saved["events"].as_array().unwrap().len(), 2);
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn reopening_store_marks_inflight_workflow_runs_interrupted_once() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());

    assert!(append_event(
        &mut store,
        &workspace_id,
        &run,
        0,
        "running",
        "run_started"
    ));
    let start_output = json!({ "input": { "seed": "preserve-me" } });
    let mut active = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap()["run"]
        .clone();
    active["nodeStates"]["node-start"]["status"] = Value::from("success");
    active["nodeStates"]["node-start"]["output"] = start_output.clone();
    active["updatedAt"] = Value::from("2026-09-27T00:00:02.000Z");
    assert!(store
        .workflow_run_append_event(
            "run-test-1",
            &workspace_id,
            1,
            &active,
            &json!({
                "id": "run-test-1:2", "runId": "run-test-1",
                "workflowId": "workflow-run-test", "revision": 0,
                "type": "node_completed", "timestamp": "2026-09-27T00:00:02.000Z",
                "sequence": 2, "nodeId": "node-start", "output": start_output
            })
        )
        .unwrap());
    active["nodeStates"]["node-1"]["status"] = Value::from("running");
    active["updatedAt"] = Value::from("2026-09-27T00:00:03.000Z");
    assert!(store
        .workflow_run_append_event(
            "run-test-1",
            &workspace_id,
            2,
            &active,
            &json!({
                "id": "run-test-1:3", "runId": "run-test-1",
                "workflowId": "workflow-run-test", "revision": 0,
                "type": "node_started", "timestamp": "2026-09-27T00:00:03.000Z",
                "sequence": 3, "nodeId": "node-1"
            })
        )
        .unwrap());
    let previous_updated_at = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap()["run"]["updatedAt"]
        .clone();
    drop(store);

    let store = MetadataStore::open(&database).unwrap();
    let recovered = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(recovered["run"]["status"], "interrupted");
    assert_eq!(
        recovered["run"]["nodeStates"]["node-1"]["status"],
        "interrupted"
    );
    assert_eq!(
        recovered["run"]["nodeStates"]["node-start"]["status"],
        "success"
    );
    assert_eq!(
        recovered["run"]["nodeStates"]["node-start"]["output"]["input"]["seed"],
        "preserve-me"
    );
    assert_eq!(recovered["run"]["nodeStates"]["node-end"]["status"], "idle");
    assert_eq!(recovered["events"].as_array().unwrap().len(), 4);
    assert_eq!(recovered["events"][3]["type"], "run_interrupted");
    assert_eq!(recovered["events"][3]["id"], "run-test-1:4");
    assert!(recovered["run"]["updatedAt"].as_str() > previous_updated_at.as_str());
    assert_eq!(
        recovered["events"][3]["timestamp"],
        recovered["run"]["updatedAt"]
    );
    let listed = store
        .workflow_run_list("workflow-run-test", &workspace_id, 50)
        .unwrap();
    assert_eq!(listed[0]["updatedAt"], recovered["run"]["updatedAt"]);
    drop(store);

    let mut store = MetadataStore::open(&database).unwrap();
    let reopened = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(reopened["run"]["status"], "interrupted");
    assert_eq!(reopened["events"].as_array().unwrap().len(), 4);
    let mut retry = test_run(&workspace_id);
    retry["id"] = Value::from("run-test-retry");
    retry["retryOfRunId"] = Value::from("run-test-1");
    retry["resumeFromNodeId"] = Value::from("node-1");
    retry["retrySeedStates"] = json!({
        "node-start": {
            "status": "success",
            "logs": [],
            "output": { "input": { "seed": "preserve-me" } },
            "reusedFromRunId": "run-test-1"
        }
    });
    assert!(store.workflow_run_create(&workspace_id, &retry).unwrap());
    let created_retry = store
        .workflow_run_load("run-test-retry", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(created_retry["run"]["status"], "queued");
    assert_eq!(
        created_retry["run"]["nodeStates"]["node-start"]["status"],
        "idle"
    );
    assert!(created_retry["run"].get("retrySeedStates").is_none());
    let mut retry_running = created_retry["run"].clone();
    retry_running["status"] = Value::from("running");
    retry_running["updatedAt"] = Value::from("2026-09-27T00:00:04.000Z");
    assert!(store
        .workflow_run_append_event(
            "run-test-retry",
            &workspace_id,
            0,
            &retry_running,
            &json!({
                "id": "run-test-retry:1", "runId": "run-test-retry",
                "workflowId": "workflow-run-test", "revision": 0,
                "type": "run_started", "timestamp": "2026-09-27T00:00:04.000Z",
                "sequence": 1, "retryOfRunId": "run-test-1", "resumeFromNodeId": "node-1"
            })
        )
        .unwrap());
    retry_running["nodeStates"]["node-start"]["status"] = Value::from("success");
    retry_running["nodeStates"]["node-start"]["output"] =
        json!({ "input": { "seed": "preserve-me" } });
    retry_running["updatedAt"] = Value::from("2026-09-27T00:00:05.000Z");
    assert!(store
        .workflow_run_append_event(
            "run-test-retry",
            &workspace_id,
            1,
            &retry_running,
            &json!({
                "id": "run-test-retry:2", "runId": "run-test-retry",
                "workflowId": "workflow-run-test", "revision": 0,
                "type": "node_completed", "timestamp": "2026-09-27T00:00:05.000Z",
                "sequence": 2, "nodeId": "node-start",
                "output": { "input": { "seed": "preserve-me" } },
                "reusedFromRunId": "run-test-1"
            })
        )
        .unwrap());
    let retry_record = store
        .workflow_run_load("run-test-retry", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(retry_record["run"]["status"], "running");
    assert_eq!(
        retry_record["run"]["nodeStates"]["node-start"]["output"]["input"]["seed"],
        "preserve-me"
    );
    assert!(retry_record["run"].get("retrySeedStates").is_none());
    assert_eq!(retry_record["events"].as_array().unwrap().len(), 2);
    assert_eq!(retry_record["events"][1]["reusedFromRunId"], "run-test-1");
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn reopening_store_recovers_queued_run_as_replayable_interrupted_record() {
    let temp = temp_dir();
    let database = temp.join("pipline.sqlite3");
    let workspace = temp.join("workspace");
    let mut store = MetadataStore::open(&database).unwrap();
    let workspace_id = prepare_workflow(&mut store, &workspace);
    let run = test_run(&workspace_id);
    assert!(store.workflow_run_create(&workspace_id, &run).unwrap());
    drop(store);

    let store = MetadataStore::open(&database).unwrap();
    let recovered = store
        .workflow_run_load("run-test-1", &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(recovered["run"]["status"], "interrupted");
    assert_eq!(
        recovered["run"]["nodeStates"]["node-start"]["status"],
        "idle"
    );
    assert_eq!(recovered["events"].as_array().unwrap().len(), 1);
    assert_eq!(recovered["events"][0]["type"], "run_interrupted");
    assert_eq!(recovered["events"][0]["sequence"], 1);
    assert_eq!(
        recovered["run"]["updatedAt"],
        recovered["events"][0]["timestamp"]
    );
    drop(store);
    fs::remove_dir_all(temp).unwrap();
}
