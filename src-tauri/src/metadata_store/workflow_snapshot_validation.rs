use serde_json::Value;
use std::collections::HashSet;

pub(super) fn matches_saved_workflow(saved: &Value, snapshot: &Value) -> bool {
    let mut normalized = saved.clone();
    let Some(edges) = normalized.get("edges").and_then(Value::as_array) else {
        return false;
    };
    let shadowed_bindings: HashSet<(String, String)> = edges
        .iter()
        .filter_map(|edge| {
            Some((
                edge.get("targetNodeId")?.as_str()?.to_string(),
                edge.get("targetPort")?.as_str()?.to_string(),
            ))
        })
        .collect();
    let Some(nodes) = normalized.get_mut("nodes").and_then(Value::as_array_mut) else {
        return false;
    };
    for node in nodes {
        let Some(instance_id) = node
            .get("instanceId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        let Some(bindings) = node.get_mut("portValues").and_then(Value::as_object_mut) else {
            continue;
        };
        bindings.retain(|name, binding| {
            binding.get("mode").and_then(Value::as_str) != Some("static")
                || !shadowed_bindings.contains(&(instance_id.clone(), name.clone()))
        });
    }
    &normalized == snapshot
}
