use super::super::MetadataStore;
use super::{prepare_workflow, temp_dir, test_run};
use serde_json::{json, Value};
use std::fs;

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
    assert!(
        super::super::workflow_validation::validate_workflow_start_input(
            &json!({}),
            &json!({ "required": [] })
        )
        .is_ok()
    );
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
    assert!(
        super::super::workflow_validation::validate_workflow_start_input(
            &json!({
                "profile": { "name": "Pipline", "settings": { "enabled": true } },
                "tags": ["workflow"]
            }),
            &schema
        )
        .is_ok()
    );
    assert!(
        super::super::workflow_validation::validate_workflow_start_input(
            &json!({
                "profile": { "name": "Pipline", "settings": { "enabled": "yes" } }
            }),
            &schema
        )
        .unwrap_err()
        .contains("Workflow input field profile.settings.enabled must be boolean")
    );
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
