use super::super::MetadataStore;
use super::{append_event, append_node_event, prepare_workflow, temp_dir, test_run};
use serde_json::{json, Value};
use std::fs;

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
