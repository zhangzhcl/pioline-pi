use super::super::MetadataStore;
use super::{append_event, custom_template, prepare_workflow, temp_dir, test_run};
use serde_json::{json, Value};
use std::fs;

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
    let store = MetadataStore::open(&database).unwrap();
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
    let store = MetadataStore::open(&temp.join("pipline.sqlite3")).unwrap();
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
    let store = MetadataStore::open(&database).unwrap();
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
