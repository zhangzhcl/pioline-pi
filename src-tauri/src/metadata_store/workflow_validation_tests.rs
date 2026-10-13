use super::{validate_custom_node_contracts, validate_workflow_structure, MAX_START_SCHEMA_DEPTH};
use serde_json::{json, Value};
use std::collections::HashMap;

fn graph() -> Value {
    json!({
        "nodes": [
            { "instanceId": "node-a", "meta": { "id": "pipline.start", "version": "1.0.0" }, "position": { "x": 0, "y": 0 }, "paramValues": {}, "portValues": {} },
            { "instanceId": "node-b", "meta": { "id": "pipline.end", "version": "1.0.0" }, "position": { "x": 10, "y": 0 }, "paramValues": {}, "portValues": {} }
        ],
        "edges": [
            { "id": "edge-a", "sourceNodeId": "node-a", "sourcePort": "output", "targetNodeId": "node-b", "targetPort": "input" }
        ]
    })
}

#[test]
fn accepts_well_formed_graphs_with_static_values() {
    let mut workflow = graph();
    workflow["nodes"][0]["portValues"] = json!({
        "input": { "mode": "static", "staticValue": null }
    });
    assert!(validate_workflow_structure(&workflow).is_ok());
}

#[test]
fn rejects_runtime_state_on_persisted_workflow_nodes() {
    let mut workflow = graph();
    workflow["nodes"][0]["runtime"] = json!({ "status": "success", "logs": [], "result": {} });
    assert!(validate_workflow_structure(&workflow)
        .unwrap_err()
        .contains("runtime state belongs to WorkflowRun"));
}

#[test]
fn requires_one_start_and_at_least_one_end_for_non_empty_graphs() {
    let mut missing_start = graph();
    missing_start["nodes"][0]["meta"]["id"] = Value::from("custom.example");
    assert!(validate_workflow_structure(&missing_start)
        .unwrap_err()
        .contains("exactly one Start"));

    let mut duplicate_start = graph();
    duplicate_start["nodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "instanceId": "node-c",
            "meta": { "id": "pipline.start", "version": "1.0.0" },
            "position": { "x": 20, "y": 0 },
            "paramValues": {},
            "portValues": {}
        }));
    assert!(validate_workflow_structure(&duplicate_start)
        .unwrap_err()
        .contains("exactly one Start"));

    let mut missing_end = graph();
    missing_end["nodes"].as_array_mut().unwrap().pop();
    missing_end["edges"] = json!([]);
    assert!(validate_workflow_structure(&missing_end)
        .unwrap_err()
        .contains("at least one End"));
}

#[test]
fn rejects_duplicate_nodes_dangling_edges_and_cycles() {
    let mut duplicate = graph();
    duplicate["nodes"][1]["instanceId"] = json!("node-a");
    assert!(validate_workflow_structure(&duplicate)
        .unwrap_err()
        .contains("duplicated"));

    let mut dangling = graph();
    dangling["edges"][0]["targetNodeId"] = json!("missing");
    assert!(validate_workflow_structure(&dangling)
        .unwrap_err()
        .contains("does not exist"));

    let mut cycle = graph();
    cycle["edges"].as_array_mut().unwrap().push(json!({
        "id": "edge-b", "sourceNodeId": "node-b", "sourcePort": "out", "targetNodeId": "node-a", "targetPort": "in"
    }));
    assert!(validate_workflow_structure(&cycle)
        .unwrap_err()
        .contains("cycle"));
}

#[test]
fn rejects_non_static_or_incomplete_bindings() {
    let mut workflow = graph();
    workflow["nodes"][0]["portValues"] = json!({
        "input": { "mode": "link" }
    });
    assert!(validate_workflow_structure(&workflow)
        .unwrap_err()
        .contains("binding is invalid"));
}

#[test]
fn rejects_unsupported_builtin_start_input_schema_fields() {
    let mut workflow = graph();
    workflow["nodes"][0]["paramValues"] = json!({
        "inputSchema": {
            "properties": { "request": { "type": "string", "pattern": ".+" } }
        }
    });

    assert!(validate_workflow_structure(&workflow)
        .unwrap_err()
        .contains("Start inputSchema field request contains unsupported schema fields"));
}

#[test]
fn accepts_bounded_nested_start_objects_and_arrays() {
    let mut workflow = graph();
    workflow["nodes"][0]["paramValues"] = json!({
        "inputSchema": {
            "properties": {
                "profile": {
                    "type": "object",
                    "properties": { "name": "string" },
                    "required": ["name"]
                },
                "tags": { "type": "array", "items": "string" }
            },
            "required": ["profile"]
        }
    });

    assert!(validate_workflow_structure(&workflow).is_ok());
}

#[test]
fn rejects_start_schema_depth_over_the_shared_limit() {
    let mut field_schema = json!("string");
    for _ in 0..=MAX_START_SCHEMA_DEPTH {
        field_schema = json!({ "type": "object", "properties": { "next": field_schema } });
    }
    let mut workflow = graph();
    workflow["nodes"][0]["paramValues"] = json!({
        "inputSchema": { "properties": { "request": field_schema } }
    });

    assert!(validate_workflow_structure(&workflow)
        .unwrap_err()
        .contains("exceeds the maximum schema depth"));
}

fn custom_template() -> Value {
    json!({
        "id": "custom.example",
        "version": "1.0.0",
        "inputs": [{ "name": "input", "type": "number", "allowStaticValue": true }],
        "outputs": [{ "name": "output", "type": "string" }],
        "params": [{ "name": "count", "type": "number" }]
    })
}

fn custom_graph() -> Value {
    json!({
        "nodes": [{
            "instanceId": "custom-node",
            "meta": { "id": "custom.example", "version": "1.0.0" },
            "position": { "x": 0, "y": 0 },
            "paramValues": { "count": 3 },
            "portValues": { "input": { "mode": "static", "staticValue": 5 } }
        }],
        "edges": []
    })
}

#[test]
fn validates_custom_node_parameters_and_static_port_types() {
    let mut templates = HashMap::new();
    templates.insert("custom.example@1.0.0".into(), custom_template());
    let mut workflow = custom_graph();
    assert!(validate_custom_node_contracts(&workflow, &templates).is_ok());

    workflow["nodes"][0]["paramValues"]["count"] = json!("three");
    assert!(validate_custom_node_contracts(&workflow, &templates)
        .unwrap_err()
        .contains("custom parameter"));

    workflow = custom_graph();
    workflow["nodes"][0]["portValues"]["input"]["staticValue"] = json!(false);
    assert!(validate_custom_node_contracts(&workflow, &templates)
        .unwrap_err()
        .contains("custom input has an invalid value"));

    workflow = custom_graph();
    workflow["nodes"][0]["portValues"]["unknown"] = json!({
        "mode": "static", "staticValue": 5
    });
    assert!(validate_custom_node_contracts(&workflow, &templates)
        .unwrap_err()
        .contains("unknown input"));
}

#[test]
fn validates_nested_static_array_values_against_the_full_port_schema() {
    let mut template = custom_template();
    template["inputs"][0]["type"] = json!({
        "kind": "array",
        "items": { "kind": "object", "schema": {
            "properties": { "score": "number" },
            "required": ["score"]
        } }
    });
    let mut templates = HashMap::new();
    templates.insert("custom.example@1.0.0".into(), template);

    let mut workflow = custom_graph();
    workflow["nodes"][0]["portValues"]["input"]["staticValue"] = json!([{ "score": 5 }]);
    assert!(validate_custom_node_contracts(&workflow, &templates).is_ok());

    workflow["nodes"][0]["portValues"]["input"]["staticValue"] = json!([{ "score": "five" }]);
    assert!(validate_custom_node_contracts(&workflow, &templates)
        .unwrap_err()
        .contains("custom input has an invalid value"));
}

#[test]
fn validates_builtin_static_inputs_when_frozen_metadata_is_available() {
    let workflow = json!({
        "nodes": [{
            "instanceId": "builtin-node",
            "meta": { "id": "pipline.test", "version": "1.0.0" },
            "portValues": {
                "input": { "mode": "static", "staticValue": "wrong type" }
            }
        }],
        "edges": []
    });
    let builtin = json!({
        "id": "pipline.test",
        "version": "1.0.0",
        "inputs": [{
            "name": "input",
            "type": "number",
            "allowStaticValue": true
        }],
        "outputs": []
    });
    let templates = HashMap::from([("pipline.test@1.0.0".to_string(), builtin)]);

    assert!(validate_custom_node_contracts(&workflow, &templates)
        .unwrap_err()
        .contains("built-in input has an invalid value"));

    let legacy_meta = json!({ "id": "pipline.test", "version": "1.0.0" });
    let legacy_templates = HashMap::from([("pipline.test@1.0.0".to_string(), legacy_meta)]);
    assert!(validate_custom_node_contracts(&workflow, &legacy_templates).is_ok());
}

#[test]
fn accepts_explicit_null_for_any_typed_builtin_static_input() {
    let workflow = json!({
        "nodes": [{
            "instanceId": "builtin-node",
            "meta": { "id": "pipline.test", "version": "1.0.0" },
            "portValues": {
                "input": { "mode": "static", "staticValue": null }
            }
        }],
        "edges": []
    });
    let builtin = json!({
        "id": "pipline.test",
        "version": "1.0.0",
        "inputs": [{
            "name": "input",
            "type": "any",
            "allowStaticValue": true
        }],
        "outputs": []
    });
    let templates = HashMap::from([("pipline.test@1.0.0".to_string(), builtin)]);

    assert!(validate_custom_node_contracts(&workflow, &templates).is_ok());
}

#[test]
fn validates_custom_edge_ports_and_types() {
    let mut templates = HashMap::new();
    templates.insert("custom.example@1.0.0".into(), custom_template());
    let mut workflow = custom_graph();
    workflow["nodes"].as_array_mut().unwrap().push(json!({
        "instanceId": "custom-target",
        "meta": { "id": "custom.example", "version": "1.0.0" },
        "position": { "x": 100, "y": 0 },
        "paramValues": {},
        "portValues": {}
    }));
    workflow["nodes"][0]["portValues"] = json!({});
    workflow["edges"] = json!([{
        "id": "edge-1",
        "sourceNodeId": "custom-node",
        "sourcePort": "output",
        "targetNodeId": "custom-target",
        "targetPort": "input"
    }]);
    assert!(validate_custom_node_contracts(&workflow, &templates)
        .unwrap_err()
        .contains("incompatible port types"));
}
