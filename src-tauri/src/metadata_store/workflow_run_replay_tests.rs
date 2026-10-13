use super::super::MetadataStore;
use super::{append_event, append_node_event, prepare_workflow, temp_dir, test_run};
use serde_json::{json, Value};
use std::fs;

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
