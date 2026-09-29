use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

use super::workflow_edge_validation::validate_known_node_edges;

const MAX_START_SCHEMA_DEPTH: usize = 16;
const MAX_START_SCHEMA_FIELDS_PER_OBJECT: usize = 256;
const MAX_START_SCHEMA_TOTAL_FIELDS: usize = 1_024;

pub(super) fn builtin_node_metas() -> HashMap<String, Value> {
    serde_json::from_str::<Vec<Value>>(include_str!(
        "../../../shared/workflow/builtin-node-metas.json"
    ))
    .expect("embedded built-in NodeMeta catalog must be valid JSON")
    .into_iter()
    .map(|meta| {
        let key = format!(
            "{}@{}",
            meta.get("id").and_then(Value::as_str).unwrap_or_default(),
            meta.get("version")
                .and_then(Value::as_str)
                .unwrap_or_default()
        );
        (key, meta)
    })
    .collect()
}

pub(super) fn validate_workflow_structure(workflow: &Value) -> Result<(), String> {
    let nodes = workflow
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or("Workflow nodes must be an array")?;
    let edges = workflow
        .get("edges")
        .and_then(Value::as_array)
        .ok_or("Workflow edges must be an array")?;
    let mut node_ids = HashSet::with_capacity(nodes.len());
    let mut start_count = 0;
    let mut end_count = 0;

    for node in nodes {
        if node.get("runtime").is_some() {
            return Err("Workflow node runtime state belongs to WorkflowRun".into());
        }
        let instance_id = node
            .get("instanceId")
            .and_then(Value::as_str)
            .filter(|id| valid_name(id))
            .ok_or("Workflow node instance id is invalid")?;
        if !node_ids.insert(instance_id.to_string()) {
            return Err("Workflow node instance id is duplicated".into());
        }
        let meta = node
            .get("meta")
            .and_then(Value::as_object)
            .ok_or("Workflow node template reference is invalid")?;
        for key in ["id", "version"] {
            if !meta
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(valid_name)
            {
                return Err(format!("Workflow node template {key} is invalid"));
            }
        }
        match meta.get("id").and_then(Value::as_str) {
            Some("pipline.start") => start_count += 1,
            Some("pipline.end") => end_count += 1,
            _ => {}
        }
        let position = node
            .get("position")
            .and_then(Value::as_object)
            .ok_or("Workflow node position is invalid")?;
        for axis in ["x", "y"] {
            if position.get(axis).and_then(Value::as_f64).is_none() {
                return Err("Workflow node position must have numeric x and y values".into());
            }
        }
        for field in ["paramValues", "portValues"] {
            if !node.get(field).is_some_and(Value::is_object) {
                return Err(format!("Workflow node {field} must be an object"));
            }
        }
        if let Some(params) = node.get("paramValues").and_then(Value::as_object) {
            if params.keys().any(|name| !valid_name(name)) {
                return Err("Workflow node parameter name is invalid".into());
            }
        }
        if meta.get("id").and_then(Value::as_str) == Some("pipline.start") {
            if let Some(schema) = node.pointer("/paramValues/inputSchema") {
                validate_start_input_schema(schema)?;
            }
        }
        if let Some(bindings) = node.get("portValues").and_then(Value::as_object) {
            for (name, binding) in bindings {
                if !valid_name(name)
                    || binding.get("mode").and_then(Value::as_str) != Some("static")
                    || !binding
                        .as_object()
                        .is_some_and(|object| object.contains_key("staticValue"))
                {
                    return Err("Workflow static input binding is invalid".into());
                }
            }
        }
    }

    let mut edge_ids = HashSet::with_capacity(edges.len());
    let mut indegree: HashMap<String, usize> = node_ids.iter().cloned().map(|id| (id, 0)).collect();
    let mut outgoing: HashMap<String, Vec<String>> = HashMap::new();
    for edge in edges {
        let edge_id = edge
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_name(id))
            .ok_or("Workflow edge id is invalid")?;
        if !edge_ids.insert(edge_id.to_string()) {
            return Err("Workflow edge id is duplicated".into());
        }
        let source = edge
            .get("sourceNodeId")
            .and_then(Value::as_str)
            .filter(|id| node_ids.contains(*id))
            .ok_or("Workflow edge source node does not exist")?;
        let target = edge
            .get("targetNodeId")
            .and_then(Value::as_str)
            .filter(|id| node_ids.contains(*id))
            .ok_or("Workflow edge target node does not exist")?;
        if source == target {
            return Err("Workflow edge cannot connect a node to itself".into());
        }
        for field in ["sourcePort", "targetPort"] {
            if !edge
                .get(field)
                .and_then(Value::as_str)
                .is_some_and(valid_name)
            {
                return Err(format!("Workflow edge {field} is invalid"));
            }
        }
        *indegree.get_mut(target).expect("target id was validated") += 1;
        outgoing
            .entry(source.to_string())
            .or_default()
            .push(target.to_string());
    }

    let mut ready: VecDeque<String> = indegree
        .iter()
        .filter(|(_, degree)| **degree == 0)
        .map(|(id, _)| id.clone())
        .collect();
    let mut visited = 0;
    while let Some(source) = ready.pop_front() {
        visited += 1;
        for target in outgoing.get(&source).into_iter().flatten() {
            let degree = indegree.get_mut(target).expect("target id was validated");
            *degree -= 1;
            if *degree == 0 {
                ready.push_back(target.clone());
            }
        }
    }
    if visited != node_ids.len() {
        return Err("Workflow graph contains a cycle".into());
    }
    if !nodes.is_empty() && start_count != 1 {
        return Err("Workflow must contain exactly one Start node".into());
    }
    if !nodes.is_empty() && end_count == 0 {
        return Err("Workflow must contain at least one End node".into());
    }
    Ok(())
}

fn validate_start_input_schema(schema: &Value) -> Result<(), String> {
    let schema = schema
        .as_object()
        .ok_or("Start inputSchema must be an object")?;
    if schema
        .keys()
        .any(|key| !matches!(key.as_str(), "properties" | "required"))
    {
        return Err("Start inputSchema contains unsupported schema fields".into());
    }
    let properties = match schema.get("properties") {
        None => None,
        Some(value) => Some(
            value
                .as_object()
                .ok_or("Start inputSchema.properties must be an object")?,
        ),
    };
    let properties = properties.cloned().unwrap_or_default();
    if properties.len() > MAX_START_SCHEMA_FIELDS_PER_OBJECT {
        return Err(format!(
            "Start inputSchema.properties exceeds {MAX_START_SCHEMA_FIELDS_PER_OBJECT} fields"
        ));
    }
    let required = start_schema_required_fields(schema.get("required"), "Start inputSchema")?;
    for name in &required {
        if !properties.contains_key(name) {
            return Err(format!(
                "Start inputSchema.required references an unknown field: {name}"
            ));
        }
    }

    let mut total_fields = properties.len();
    if total_fields > MAX_START_SCHEMA_TOTAL_FIELDS {
        return Err("Start inputSchema exceeds the maximum total field count".into());
    }
    for (name, field_schema) in &properties {
        validate_start_field_schema(
            field_schema,
            &format!("Start inputSchema field {name}"),
            0,
            &mut total_fields,
        )?;
    }
    Ok(())
}

pub(super) fn validate_workflow_start_input(input: &Value, schema: &Value) -> Result<(), String> {
    let input = input
        .as_object()
        .ok_or("Workflow input must be an object")?;
    let schema = schema
        .as_object()
        .ok_or("Start inputSchema must be an object")?;
    let properties = schema
        .get("properties")
        .map(|value| {
            value
                .as_object()
                .cloned()
                .ok_or("Start inputSchema.properties must be an object")
        })
        .transpose()?
        .unwrap_or_default();
    let required = start_schema_required_fields(schema.get("required"), "Start inputSchema")?;
    for name in required {
        if !input.contains_key(&name) {
            return Err(format!("Workflow input is missing required field: {name}"));
        }
    }
    for (name, field_schema) in &properties {
        if let Some(value) = input.get(name) {
            validate_start_field_value(
                value,
                field_schema,
                &format!("Workflow input field {name}"),
                0,
            )?;
        }
    }
    Ok(())
}

fn validate_start_field_value(
    value: &Value,
    schema: &Value,
    path: &str,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_START_SCHEMA_DEPTH {
        return Err(format!("{path} exceeds the maximum data depth"));
    }
    let kind = schema
        .as_str()
        .or_else(|| schema.get("type").and_then(Value::as_str))
        .ok_or_else(|| format!("{path} has an unsupported type"))?;
    let matches_type = match kind {
        "any" => true,
        "string" => value.is_string(),
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "boolean" => value.is_boolean(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        _ => false,
    };
    if !matches_type {
        return Err(format!("{path} must be {kind}"));
    }
    let Some(schema) = schema.as_object() else {
        return Ok(());
    };
    match kind {
        "object" => {
            let value = value.as_object().expect("object type was checked");
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for name in start_schema_required_fields(schema.get("required"), path)? {
                if !value.contains_key(&name) {
                    return Err(format!("{path} is missing required field {name}"));
                }
            }
            for (name, property_schema) in properties {
                if let Some(property) = value.get(&name) {
                    validate_start_field_value(
                        property,
                        &property_schema,
                        &format!("{path}.{name}"),
                        depth + 1,
                    )?;
                }
            }
        }
        "array" => {
            let item_schema = schema
                .get("items")
                .ok_or_else(|| format!("{path}.items is required"))?;
            for (index, item) in value
                .as_array()
                .expect("array type was checked")
                .iter()
                .enumerate()
            {
                validate_start_field_value(
                    item,
                    item_schema,
                    &format!("{path}[{index}]"),
                    depth + 1,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_start_field_schema(
    schema: &Value,
    path: &str,
    depth: usize,
    total_fields: &mut usize,
) -> Result<(), String> {
    if depth > MAX_START_SCHEMA_DEPTH {
        return Err(format!("{path} exceeds the maximum schema depth"));
    }
    if let Some(kind) = schema.as_str() {
        return if supported_start_schema_type(kind) {
            Ok(())
        } else {
            Err(format!("{path} has an unsupported type"))
        };
    }
    let schema = schema
        .as_object()
        .ok_or_else(|| format!("{path} must be a supported type or schema object"))?;
    let kind = schema
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| supported_start_schema_type(kind))
        .ok_or_else(|| format!("{path} has an unsupported type"))?;
    let allowed_keys: &[&str] = match kind {
        "object" => &["type", "properties", "required"],
        "array" => &["type", "items"],
        _ => &["type"],
    };
    if schema
        .keys()
        .any(|key| !allowed_keys.contains(&key.as_str()))
    {
        return Err(format!("{path} contains unsupported schema fields"));
    }

    match kind {
        "object" => {
            let properties = match schema.get("properties") {
                None => None,
                Some(value) => Some(
                    value
                        .as_object()
                        .ok_or_else(|| format!("{path}.properties must be an object"))?,
                ),
            };
            let properties = properties.cloned().unwrap_or_default();
            if properties.len() > MAX_START_SCHEMA_FIELDS_PER_OBJECT {
                return Err(format!(
                    "{path}.properties exceeds {MAX_START_SCHEMA_FIELDS_PER_OBJECT} fields"
                ));
            }
            *total_fields += properties.len();
            if *total_fields > MAX_START_SCHEMA_TOTAL_FIELDS {
                return Err(format!("{path} exceeds the maximum total field count"));
            }
            let required = start_schema_required_fields(schema.get("required"), path)?;
            for name in required {
                if !properties.contains_key(&name) {
                    return Err(format!(
                        "{path}.required references an unknown field: {name}"
                    ));
                }
            }
            for (name, field_schema) in &properties {
                validate_start_field_schema(
                    field_schema,
                    &format!("{path}.{name}"),
                    depth + 1,
                    total_fields,
                )?;
            }
        }
        "array" => {
            let items = schema
                .get("items")
                .ok_or_else(|| format!("{path}.items is required"))?;
            validate_start_field_schema(items, &format!("{path}[]"), depth + 1, total_fields)?;
        }
        _ => {}
    }
    Ok(())
}

fn start_schema_required_fields(
    required: Option<&Value>,
    path: &str,
) -> Result<Vec<String>, String> {
    let Some(required) = required else {
        return Ok(Vec::new());
    };
    let fields = required
        .as_array()
        .filter(|fields| {
            fields.len() <= MAX_START_SCHEMA_FIELDS_PER_OBJECT
                && fields.iter().all(Value::is_string)
        })
        .ok_or_else(|| format!("{path}.required must contain unique field names"))?;
    let mut unique = HashSet::with_capacity(fields.len());
    let mut result = Vec::with_capacity(fields.len());
    for field in fields {
        let name = field.as_str().expect("field type was checked");
        if !unique.insert(name) {
            return Err(format!("{path}.required must contain unique field names"));
        }
        result.push(name.to_string());
    }
    Ok(result)
}

fn supported_start_schema_type(kind: &str) -> bool {
    matches!(
        kind,
        "string" | "number" | "boolean" | "object" | "array" | "any"
    )
}

pub(super) fn validate_custom_node_contracts(
    workflow: &Value,
    templates: &HashMap<String, Value>,
) -> Result<(), String> {
    let nodes = workflow
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or("Workflow nodes must be an array")?;
    let edges = workflow
        .get("edges")
        .and_then(Value::as_array)
        .ok_or("Workflow edges must be an array")?;
    let mut metas_by_node = HashMap::new();

    for node in nodes {
        let instance_id = node
            .get("instanceId")
            .and_then(Value::as_str)
            .ok_or("Workflow node instance id is invalid")?;
        let id = node
            .pointer("/meta/id")
            .and_then(Value::as_str)
            .ok_or("Workflow node template id is invalid")?;
        if !id.starts_with("custom.") {
            let version = node
                .pointer("/meta/version")
                .and_then(Value::as_str)
                .ok_or("Workflow node template version is invalid")?;
            let key = format!("{id}@{version}");
            if let Some(meta) = templates.get(&key).filter(|meta| {
                meta.get("id").and_then(Value::as_str) == Some(id)
                    && meta.get("version").and_then(Value::as_str) == Some(version)
                    && meta.get("inputs").and_then(Value::as_array).is_some()
                    && meta.get("outputs").and_then(Value::as_array).is_some()
            }) {
                validate_builtin_static_inputs(node, meta)?;
                metas_by_node.insert(instance_id.to_string(), meta);
            }
            continue;
        }
        let version = node
            .pointer("/meta/version")
            .and_then(Value::as_str)
            .ok_or("Workflow node template version is invalid")?;
        let key = format!("{id}@{version}");
        let meta = templates
            .get(&key)
            .filter(|meta| {
                meta.get("id").and_then(Value::as_str) == Some(id)
                    && meta.get("version").and_then(Value::as_str) == Some(version)
            })
            .ok_or_else(|| format!("Workflow custom NodeMeta is unavailable: {key}"))?;
        let params = meta
            .get("params")
            .and_then(Value::as_array)
            .ok_or("Workflow custom NodeMeta parameters are invalid")?;
        let inputs = meta
            .get("inputs")
            .and_then(Value::as_array)
            .ok_or("Workflow custom NodeMeta inputs are invalid")?;
        let param_values = node
            .get("paramValues")
            .and_then(Value::as_object)
            .ok_or("Workflow node paramValues must be an object")?;
        for (name, value) in param_values {
            let param = params
                .iter()
                .find(|param| param.get("name").and_then(Value::as_str) == Some(name))
                .ok_or_else(|| format!("Workflow custom node has unknown parameter: {name}"))?;
            let kind = param
                .get("type")
                .and_then(Value::as_str)
                .ok_or("Workflow custom NodeMeta parameter type is invalid")?;
            let value_type = match kind {
                "select" => Value::from("string"),
                "json" => Value::from("any"),
                _ => param
                    .get("type")
                    .cloned()
                    .ok_or("Workflow custom NodeMeta parameter type is invalid")?,
            };
            if !value_matches_schema(value, &value_type, 0)
                || (kind == "select"
                    && !param
                        .get("options")
                        .and_then(Value::as_array)
                        .is_some_and(|options| {
                            options.iter().any(|option| {
                                option.get("value").and_then(Value::as_str) == value.as_str()
                            })
                        }))
            {
                return Err(format!(
                    "Workflow custom parameter has an invalid value: {name}"
                ));
            }
        }

        let port_values = node
            .get("portValues")
            .and_then(Value::as_object)
            .ok_or("Workflow node portValues must be an object")?;
        for (name, binding) in port_values {
            let port = inputs
                .iter()
                .find(|port| port.get("name").and_then(Value::as_str) == Some(name))
                .ok_or_else(|| format!("Workflow custom node has unknown input: {name}"))?;
            if port.get("allowStaticValue").and_then(Value::as_bool) != Some(true) {
                return Err(format!(
                    "Workflow custom input does not allow static values: {name}"
                ));
            }
            let value = binding
                .get("staticValue")
                .ok_or("Workflow static input binding is incomplete")?;
            let value_type = port
                .get("type")
                .ok_or("Workflow custom NodeMeta input type is invalid")?;
            if !value_matches_schema(value, value_type, 0) {
                return Err(format!(
                    "Workflow custom input has an invalid value: {name}"
                ));
            }
        }
        metas_by_node.insert(instance_id.to_string(), meta);
    }

    validate_known_node_edges(nodes, edges, &metas_by_node)
}

fn validate_builtin_static_inputs(node: &Value, meta: &Value) -> Result<(), String> {
    let Some(inputs) = meta.get("inputs").and_then(Value::as_array) else {
        return Ok(());
    };
    let Some(bindings) = node.get("portValues").and_then(Value::as_object) else {
        return Ok(());
    };
    for (name, binding) in bindings {
        let port = inputs
            .iter()
            .find(|port| port.get("name").and_then(Value::as_str) == Some(name))
            .ok_or_else(|| format!("Workflow built-in node has an unknown input: {name}"))?;
        if port.get("allowStaticValue").and_then(Value::as_bool) != Some(true) {
            return Err(format!(
                "Workflow built-in input does not allow static values: {name}"
            ));
        }
        let value = binding
            .get("staticValue")
            .ok_or("Workflow static input binding is incomplete")?;
        let value_type = port
            .get("type")
            .ok_or("Workflow built-in NodeMeta input type is invalid")?;
        if !value_matches_schema(value, value_type, 0) {
            return Err(format!(
                "Workflow built-in input has an invalid value: {name}"
            ));
        }
    }
    Ok(())
}

fn type_name(value_type: &Value) -> Option<&str> {
    value_type
        .as_str()
        .or_else(|| value_type.get("kind").and_then(Value::as_str))
}

fn value_matches_schema(value: &Value, value_type: &Value, depth: usize) -> bool {
    if depth > 64 {
        return false;
    }
    match type_name(value_type) {
        Some("any") => true,
        Some("string") => value.is_string(),
        Some("number") => value.is_number(),
        Some("boolean") => value.is_boolean(),
        Some("object") => {
            let Some(object) = value.as_object() else {
                return false;
            };
            let Some(schema) = value_type.get("schema") else {
                return true;
            };
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let required = schema
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str);
            if required.into_iter().any(|key| !object.contains_key(key)) {
                return false;
            }
            properties.iter().all(|(key, property_type)| {
                object
                    .get(key)
                    .is_none_or(|property| value_matches_schema(property, property_type, depth + 1))
            })
        }
        Some("array") => {
            let Some(items) = value.as_array() else {
                return false;
            };
            value_type.get("items").is_none_or(|item_type| {
                items
                    .iter()
                    .all(|item| value_matches_schema(item, item_type, depth + 1))
            })
        }
        _ => false,
    }
}

fn valid_name(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 128
}

#[cfg(test)]
mod tests {
    use super::{
        validate_custom_node_contracts, validate_workflow_structure, MAX_START_SCHEMA_DEPTH,
    };
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
}
