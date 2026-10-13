use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::OnceLock;

use super::workflow_edge_validation::validate_known_node_edges;

#[path = "workflow_start_schema.rs"]
mod workflow_start_schema;

use workflow_start_schema::validate_start_input_schema;
pub(super) use workflow_start_schema::validate_workflow_start_input;
#[cfg(test)]
use workflow_start_schema::MAX_START_SCHEMA_DEPTH;

#[cfg(test)]
#[path = "workflow_validation_tests.rs"]
mod tests;

pub(super) trait NodeMetaLookup {
    fn get_meta(&self, key: &str) -> Option<&Value>;
}

impl NodeMetaLookup for HashMap<String, Value> {
    fn get_meta(&self, key: &str) -> Option<&Value> {
        self.get(key)
    }
}

impl NodeMetaLookup for serde_json::Map<String, Value> {
    fn get_meta(&self, key: &str) -> Option<&Value> {
        self.get(key)
    }
}

pub(super) struct CombinedNodeMetas<'a> {
    pub builtins: &'a HashMap<String, Value>,
    pub custom: &'a HashMap<String, Value>,
}

impl NodeMetaLookup for CombinedNodeMetas<'_> {
    fn get_meta(&self, key: &str) -> Option<&Value> {
        self.builtins.get(key).or_else(|| self.custom.get(key))
    }
}

pub(super) fn builtin_node_metas() -> &'static HashMap<String, Value> {
    static BUILTIN_METAS: OnceLock<HashMap<String, Value>> = OnceLock::new();
    BUILTIN_METAS.get_or_init(|| {
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
    })
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
        if !node_ids.insert(instance_id) {
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
    let mut indegree: HashMap<&str, usize> = node_ids.iter().copied().map(|id| (id, 0)).collect();
    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in edges {
        let edge_id = edge
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_name(id))
            .ok_or("Workflow edge id is invalid")?;
        if !edge_ids.insert(edge_id) {
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
        outgoing.entry(source).or_default().push(target);
    }

    let mut ready: VecDeque<&str> = indegree
        .iter()
        .filter(|(_, degree)| **degree == 0)
        .map(|(&id, _)| id)
        .collect();
    let mut visited = 0;
    while let Some(source) = ready.pop_front() {
        visited += 1;
        for &target in outgoing.get(source).into_iter().flatten() {
            let degree = indegree.get_mut(target).expect("target id was validated");
            *degree -= 1;
            if *degree == 0 {
                ready.push_back(target);
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

pub(super) fn validate_custom_node_contracts(
    workflow: &Value,
    templates: &impl NodeMetaLookup,
) -> Result<(), String> {
    let nodes = workflow
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or("Workflow nodes must be an array")?;
    let edges = workflow
        .get("edges")
        .and_then(Value::as_array)
        .ok_or("Workflow edges must be an array")?;
    let mut metas_by_node = HashMap::with_capacity(nodes.len());

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
            if let Some(meta) = templates.get_meta(&key).filter(|meta| {
                meta.get("id").and_then(Value::as_str) == Some(id)
                    && meta.get("version").and_then(Value::as_str) == Some(version)
                    && meta.get("inputs").and_then(Value::as_array).is_some()
                    && meta.get("outputs").and_then(Value::as_array).is_some()
            }) {
                validate_builtin_static_inputs(node, meta)?;
                metas_by_node.insert(instance_id, meta);
            }
            continue;
        }
        let version = node
            .pointer("/meta/version")
            .and_then(Value::as_str)
            .ok_or("Workflow node template version is invalid")?;
        let key = format!("{id}@{version}");
        let meta = templates
            .get_meta(&key)
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
            let matches_schema = match kind {
                "select" => value.is_string(),
                "json" => true,
                _ => {
                    let value_type = param
                        .get("type")
                        .ok_or("Workflow custom NodeMeta parameter type is invalid")?;
                    value_matches_schema(value, value_type, 0)
                }
            };
            if !matches_schema
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
        metas_by_node.insert(instance_id, meta);
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
            let properties = schema.get("properties").and_then(Value::as_object);
            let required = schema
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str);
            if required.into_iter().any(|key| !object.contains_key(key)) {
                return false;
            }
            properties
                .into_iter()
                .flatten()
                .all(|(key, property_type)| {
                    object.get(key).is_none_or(|property| {
                        value_matches_schema(property, property_type, depth + 1)
                    })
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
