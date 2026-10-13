use super::super::MetadataStore;
use super::{append_event, append_node_event, prepare_workflow, temp_dir, test_run};
use serde_json::{json, Value};
use std::fs;

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
