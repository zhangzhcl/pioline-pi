use serde_json::Value;
use std::collections::HashSet;

pub(super) fn matches_saved_workflow(saved: &Value, snapshot: &Value) -> bool {
    let Some(edges) = saved.get("edges").and_then(Value::as_array) else {
        return false;
    };
    let Some(saved_nodes) = saved.get("nodes").and_then(Value::as_array) else {
        return false;
    };
    let shadowed_bindings: HashSet<(&str, &str)> = edges
        .iter()
        .filter_map(|edge| {
            Some((
                edge.get("targetNodeId")?.as_str()?,
                edge.get("targetPort")?.as_str()?,
            ))
        })
        .collect();
    let has_shadowed_static = !shadowed_bindings.is_empty()
        && saved_nodes.iter().any(|node| {
            let Some(instance_id) = node.get("instanceId").and_then(Value::as_str) else {
                return false;
            };
            node.get("portValues")
                .and_then(Value::as_object)
                .is_some_and(|bindings| {
                    bindings.iter().any(|(name, binding)| {
                        binding.get("mode").and_then(Value::as_str) == Some("static")
                            && shadowed_bindings.contains(&(instance_id, name.as_str()))
                    })
                })
        });
    if !has_shadowed_static {
        return saved == snapshot;
    }

    let mut normalized = saved.clone();
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
                || !shadowed_bindings.contains(&(instance_id.as_str(), name.as_str()))
        });
    }
    &normalized == snapshot
}
