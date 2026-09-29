use serde_json::{Map, Value};

#[derive(Debug)]
pub struct AuthorizedCodeNode {
    pub node_meta: Value,
    pub params: Value,
}

pub fn authorize_code_node(
    record: &Value,
    run_id: &str,
    workspace_id: &str,
    node_id: &str,
    inputs: &Value,
) -> Result<AuthorizedCodeNode, String> {
    let run = record
        .get("run")
        .filter(|run| run.is_object())
        .ok_or_else(|| "Workflow Run was not found".to_string())?;
    if run.get("id").and_then(Value::as_str) != Some(run_id)
        || run.get("workspaceId").and_then(Value::as_str) != Some(workspace_id)
    {
        return Err("Workflow Run target does not match the request".into());
    }
    if run.get("status").and_then(Value::as_str) != Some("running") {
        return Err("Workflow Run is not running".into());
    }
    if run
        .pointer(&format!("/nodeStates/{}/status", escape_pointer(node_id)))
        .and_then(Value::as_str)
        != Some("running")
    {
        return Err("Workflow code node is not running".into());
    }
    let snapshot = run
        .get("snapshot")
        .filter(|snapshot| snapshot.is_object())
        .ok_or_else(|| "Workflow Run snapshot is missing".to_string())?;
    if snapshot.get("id").and_then(Value::as_str) != run.get("workflowId").and_then(Value::as_str)
        || snapshot.get("revision").and_then(Value::as_i64)
            != run.get("workflowRevision").and_then(Value::as_i64)
    {
        return Err("Workflow Run snapshot identity is invalid".into());
    }
    let node = snapshot
        .get("nodes")
        .and_then(Value::as_array)
        .and_then(|nodes| {
            nodes
                .iter()
                .find(|node| node.get("instanceId").and_then(Value::as_str) == Some(node_id))
        })
        .ok_or_else(|| "Workflow Run node was not found in its snapshot".to_string())?;
    let meta_ref = node
        .get("meta")
        .filter(|reference| reference.is_object())
        .ok_or_else(|| "Workflow node template reference is missing".to_string())?;
    let meta_id = meta_ref
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Workflow node template id is missing".to_string())?;
    let meta_version = meta_ref
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "Workflow node template version is missing".to_string())?;
    let key = format!("{meta_id}@{meta_version}");
    let meta = run
        .pointer(&format!("/nodeMetaSnapshot/{}", escape_pointer(&key)))
        .filter(|meta| meta.is_object())
        .ok_or_else(|| "Frozen Workflow NodeMeta is missing".to_string())?;
    if meta.get("id").and_then(Value::as_str) != Some(meta_id)
        || meta.get("version").and_then(Value::as_str) != Some(meta_version)
        || meta.get("type").and_then(Value::as_str) != Some("custom")
        || meta.pointer("/execution/kind").and_then(Value::as_str) != Some("user-code")
    {
        return Err("Frozen Workflow NodeMeta is not a custom user-code node".into());
    }
    validate_inputs(meta, inputs)?;
    let params = resolve_params(meta, node.get("paramValues"))?;
    Ok(AuthorizedCodeNode {
        node_meta: meta.clone(),
        params,
    })
}

fn validate_inputs(meta: &Value, inputs: &Value) -> Result<(), String> {
    let inputs = inputs
        .as_object()
        .ok_or_else(|| "Workflow code inputs must be an object".to_string())?;
    let definitions = meta
        .get("inputs")
        .and_then(Value::as_array)
        .ok_or_else(|| "Frozen NodeMeta inputs are invalid".to_string())?;
    for definition in definitions {
        let name = definition
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "Frozen NodeMeta input name is invalid".to_string())?;
        match inputs.get(name) {
            Some(value) if matches_port_type(value, definition.get("type")) => {}
            Some(_) => return Err(format!("Workflow code input {name} has an invalid type")),
            None if definition.get("required").and_then(Value::as_bool) == Some(true) => {
                return Err(format!("Workflow code input {name} is required"));
            }
            None => {}
        }
    }
    if inputs.keys().any(|name| {
        !definitions
            .iter()
            .any(|definition| definition.get("name").and_then(Value::as_str) == Some(name))
    }) {
        return Err("Workflow code request contains an unknown input".into());
    }
    Ok(())
}

fn matches_port_type(value: &Value, type_schema: Option<&Value>) -> bool {
    match type_schema {
        Some(Value::String(kind)) => match kind.as_str() {
            "string" => value.is_string(),
            "number" => value.as_f64().is_some_and(f64::is_finite),
            "boolean" => value.is_boolean(),
            "object" => value.is_object(),
            "array" => value.is_array(),
            "any" => true,
            _ => false,
        },
        Some(Value::Object(schema)) => match schema.get("kind").and_then(Value::as_str) {
            Some("array") => value.as_array().is_some_and(|items| {
                items
                    .iter()
                    .all(|item| matches_port_type(item, schema.get("items")))
            }),
            Some("object") => {
                let Some(object) = value.as_object() else {
                    return false;
                };
                let Some(object_schema) = schema.get("schema").and_then(Value::as_object) else {
                    return true;
                };
                let properties = object_schema.get("properties").and_then(Value::as_object);
                let required = object_schema.get("required").and_then(Value::as_array);
                if required.is_some_and(|fields| {
                    fields
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|field| !object.contains_key(field))
                }) {
                    return false;
                }
                properties.is_none_or(|properties| {
                    properties.iter().all(|(name, item_type)| {
                        object
                            .get(name)
                            .is_none_or(|item| matches_port_type(item, Some(item_type)))
                    })
                })
            }
            Some("string") => value.is_string(),
            Some("number") => value.as_f64().is_some_and(f64::is_finite),
            Some("boolean") => value.is_boolean(),
            Some("any") => true,
            _ => false,
        },
        _ => false,
    }
}

fn resolve_params(meta: &Value, supplied: Option<&Value>) -> Result<Value, String> {
    let supplied = supplied
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let definitions = meta
        .get("params")
        .and_then(Value::as_array)
        .ok_or_else(|| "Frozen NodeMeta parameters are invalid".to_string())?;
    let mut values = Map::new();
    for definition in definitions {
        let name = definition
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "Frozen NodeMeta parameter name is invalid".to_string())?;
        let value = supplied
            .get(name)
            .or_else(|| definition.get("defaultValue"));
        if value.is_none() && definition.get("required").and_then(Value::as_bool) == Some(true) {
            return Err(format!("Workflow code parameter {name} is required"));
        }
        if let Some(value) = value {
            if !matches_param_type(value, definition.get("type").and_then(Value::as_str)) {
                return Err(format!(
                    "Workflow code parameter {name} has an invalid type"
                ));
            }
            values.insert(name.to_owned(), value.clone());
        }
    }
    if supplied.keys().any(|name| !values.contains_key(name)) {
        return Err("Workflow node contains an unknown code parameter".into());
    }
    Ok(Value::Object(values))
}

fn matches_param_type(value: &Value, kind: Option<&str>) -> bool {
    match kind {
        Some("string" | "select") => value.is_string(),
        Some("number") => value.as_f64().is_some_and(f64::is_finite),
        Some("boolean") => value.is_boolean(),
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        _ => false,
    }
}

fn escape_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

#[cfg(test)]
mod tests {
    use super::authorize_code_node;
    use serde_json::json;

    fn running_record() -> serde_json::Value {
        let meta = json!({
            "schemaVersion": 1,
            "id": "custom.append",
            "version": "1.0.0",
            "type": "custom",
            "execution": {"kind": "user-code"},
            "params": [
                {"name": "prefix", "type": "string", "required": true},
                {"name": "suffix", "type": "string", "required": true, "defaultValue": "!"}
            ],
            "inputs": [{"name": "value", "type": "string", "required": true}],
            "outputs": [{"name": "result", "type": "string", "required": true}],
            "implementationDraft": {
                "language": "typescript",
                "source": "export function run() { return {}; }",
                "entryFn": "run",
                "compilerVersion": "esbuild-wasm@0.28.0",
                "compiledSource": "globalThis.__piplineWorkflowExports={__pipline_entry:run};"
            }
        });
        json!({
            "run": {
                "id": "run-1",
                "workspaceId": "workspace-1",
                "workflowId": "workflow-1",
                "workflowRevision": 4,
                "status": "running",
                "snapshot": {"id": "workflow-1", "revision": 4, "nodes": [
                    {"instanceId": "node-1", "meta": {"id": "custom.append", "version": "1.0.0"}, "paramValues": {"prefix": "value="}}
                ]},
                "nodeMetaSnapshot": {"custom.append@1.0.0": meta},
                "nodeStates": {"node-1": {"status": "running"}}
            },
            "events": []
        })
    }

    #[test]
    fn authorizes_only_running_snapshot_node_and_resolves_frozen_parameters() {
        let record = running_record();
        let authorized = authorize_code_node(
            &record,
            "run-1",
            "workspace-1",
            "node-1",
            &json!({"value": "hello"}),
        )
        .unwrap();
        assert_eq!(authorized.node_meta["id"], "custom.append");
        assert_eq!(
            authorized.params,
            json!({"prefix": "value=", "suffix": "!"})
        );
    }

    #[test]
    fn rejects_code_execution_for_a_node_that_is_not_running() {
        let mut record = running_record();
        record["run"]["nodeStates"]["node-1"]["status"] = json!("idle");
        assert!(authorize_code_node(
            &record,
            "run-1",
            "workspace-1",
            "node-1",
            &json!({"value": "hello"})
        )
        .unwrap_err()
        .contains("not running"));
    }

    #[test]
    fn rejects_a_request_for_another_workspace_or_unknown_input() {
        let record = running_record();
        assert!(authorize_code_node(
            &record,
            "run-1",
            "other-workspace",
            "node-1",
            &json!({"value": "hello"})
        )
        .unwrap_err()
        .contains("does not match"));
        assert!(authorize_code_node(
            &record,
            "run-1",
            "workspace-1",
            "node-1",
            &json!({"value": "hello", "unbound": "must reject"})
        )
        .unwrap_err()
        .contains("unknown input"));
    }
}
