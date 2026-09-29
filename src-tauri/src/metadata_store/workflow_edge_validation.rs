use serde_json::Value;
use std::collections::HashMap;

pub(super) fn validate_known_node_edges(
    nodes: &[Value],
    edges: &[Value],
    metas_by_node: &HashMap<String, &Value>,
) -> Result<(), String> {
    let mut incoming = HashMap::<(String, String), usize>::new();
    for edge in edges {
        let source_id = edge
            .get("sourceNodeId")
            .and_then(Value::as_str)
            .ok_or("Workflow edge source node is invalid")?;
        let target_id = edge
            .get("targetNodeId")
            .and_then(Value::as_str)
            .ok_or("Workflow edge target node is invalid")?;
        let source_port_name = edge
            .get("sourcePort")
            .and_then(Value::as_str)
            .ok_or("Workflow edge source port is invalid")?;
        let target_port_name = edge
            .get("targetPort")
            .and_then(Value::as_str)
            .ok_or("Workflow edge target port is invalid")?;
        let source_port = metas_by_node
            .get(source_id)
            .filter(|meta| meta.get("outputs").and_then(Value::as_array).is_some())
            .map(|meta| find_port(meta, "outputs", source_port_name))
            .transpose()?;
        let target_port = metas_by_node
            .get(target_id)
            .filter(|meta| meta.get("inputs").and_then(Value::as_array).is_some())
            .map(|meta| find_port(meta, "inputs", target_port_name))
            .transpose()?;

        if let Some(port) = target_port {
            let key = (target_id.to_string(), target_port_name.to_string());
            let count = incoming.entry(key).or_default();
            *count += 1;
            if node_has_static_binding(nodes, target_id, target_port_name) {
                return Err(format!(
                    "Workflow input cannot have both a static value and connection: {target_port_name}"
                ));
            }
            if *count > 1 && port.get("multi").and_then(Value::as_bool) != Some(true) {
                return Err(format!(
                    "Workflow input accepts only one connection: {target_port_name}"
                ));
            }
        }

        if let (Some(source), Some(target)) = (source_port, target_port) {
            let source_type = source
                .get("type")
                .ok_or("Workflow output port type is invalid")?;
            let target_type = if target.get("multi").and_then(Value::as_bool) == Some(true) {
                target
                    .get("type")
                    .and_then(|value_type| value_type.get("items"))
                    .ok_or("Workflow multi input item type is invalid")?
            } else {
                target
                    .get("type")
                    .ok_or("Workflow input port type is invalid")?
            };
            if !compatible_type(source_type, target_type, 0) {
                return Err(format!(
                    "Workflow connection has incompatible port types: {source_port_name} to {target_port_name}"
                ));
            }
        }
    }
    Ok(())
}

fn find_port<'a>(meta: &'a Value, group: &str, name: &str) -> Result<&'a Value, String> {
    meta.get(group)
        .and_then(Value::as_array)
        .and_then(|ports| {
            ports
                .iter()
                .find(|port| port.get("name").and_then(Value::as_str) == Some(name))
        })
        .ok_or_else(|| format!("Workflow node references unknown {group} port: {name}"))
}

fn node_has_static_binding(nodes: &[Value], node_id: &str, port_name: &str) -> bool {
    nodes.iter().any(|node| {
        node.get("instanceId").and_then(Value::as_str) == Some(node_id)
            && node
                .get("portValues")
                .and_then(Value::as_object)
                .and_then(|bindings| bindings.get(port_name))
                .and_then(|binding| binding.get("mode"))
                .and_then(Value::as_str)
                == Some("static")
    })
}

fn type_name(value_type: &Value) -> Option<&str> {
    value_type
        .as_str()
        .or_else(|| value_type.get("kind").and_then(Value::as_str))
}

fn compatible_type(output: &Value, input: &Value, depth: usize) -> bool {
    const MAX_TYPE_DEPTH: usize = 24;
    let output_kind = type_name(output);
    let input_kind = type_name(input);
    if output_kind == Some("any") || input_kind == Some("any") {
        return true;
    }
    if output_kind != input_kind || depth > MAX_TYPE_DEPTH {
        return false;
    }
    match output_kind {
        Some("array") => {
            if input.as_str() == Some("array") {
                return true;
            }
            output.get("items").zip(input.get("items")).is_some_and(
                |(output_items, input_items)| compatible_type(output_items, input_items, depth + 1),
            )
        }
        Some("object") => {
            let input_schema = input.get("schema").and_then(Value::as_object);
            let Some(input_schema) = input_schema else {
                return true;
            };
            let Some(output_schema) = output.get("schema").and_then(Value::as_object) else {
                return false;
            };
            let output_properties = output_schema.get("properties").and_then(Value::as_object);
            let input_properties = input_schema.get("properties").and_then(Value::as_object);
            let output_required = output_schema
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<std::collections::HashSet<_>>();
            let input_required = input_schema
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str);
            if input_required
                .into_iter()
                .any(|name| !output_required.contains(name))
            {
                return false;
            }
            input_properties
                .into_iter()
                .flatten()
                .all(|(name, input_type)| {
                    output_properties
                        .and_then(|properties| properties.get(name))
                        .is_some_and(|output_type| {
                            compatible_type(output_type, input_type, depth + 1)
                        })
                })
        }
        Some("string" | "number" | "boolean") => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::validate_known_node_edges;
    use serde_json::{json, Value};
    use std::collections::HashMap;

    fn validate_edge(source_type: Value, target_type: Value) -> Result<(), String> {
        let source_meta = json!({
            "inputs": [],
            "outputs": [{ "name": "output", "type": source_type }]
        });
        let target_meta = json!({
            "inputs": [{ "name": "input", "type": target_type, "multi": false }],
            "outputs": []
        });
        let nodes = vec![
            json!({ "instanceId": "source", "portValues": {} }),
            json!({ "instanceId": "target", "portValues": {} }),
        ];
        let edges = vec![json!({
            "sourceNodeId": "source",
            "sourcePort": "output",
            "targetNodeId": "target",
            "targetPort": "input"
        })];
        let metas = HashMap::from([
            ("source".to_string(), &source_meta),
            ("target".to_string(), &target_meta),
        ]);
        validate_known_node_edges(&nodes, &edges, &metas)
    }

    #[test]
    fn compares_array_item_types_recursively() {
        let result = validate_edge(
            json!({ "kind": "array", "items": "number" }),
            json!({ "kind": "array", "items": "string" }),
        );

        assert!(result.unwrap_err().contains("incompatible port types"));
    }

    #[test]
    fn compares_nested_object_property_types_recursively() {
        let result = validate_edge(
            json!({
                "kind": "object",
                "schema": {
                    "properties": { "payload": { "kind": "array", "items": "number" } },
                    "required": ["payload"]
                }
            }),
            json!({
                "kind": "object",
                "schema": {
                    "properties": { "payload": { "kind": "array", "items": "string" } },
                    "required": ["payload"]
                }
            }),
        );

        assert!(result.unwrap_err().contains("incompatible port types"));
    }
}
