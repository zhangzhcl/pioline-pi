// 工作流 Start 节点输入 Schema 与运行时入参递归校验。

use serde_json::Value;
use std::collections::HashSet;

pub(super) const MAX_START_SCHEMA_DEPTH: usize = 16;
const MAX_START_SCHEMA_FIELDS_PER_OBJECT: usize = 256;
const MAX_START_SCHEMA_TOTAL_FIELDS: usize = 1_024;

pub(super) fn validate_start_input_schema(schema: &Value) -> Result<(), String> {
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
    let prop_len = properties.map_or(0, serde_json::Map::len);
    if prop_len > MAX_START_SCHEMA_FIELDS_PER_OBJECT {
        return Err(format!(
            "Start inputSchema.properties exceeds {MAX_START_SCHEMA_FIELDS_PER_OBJECT} fields"
        ));
    }
    let required = start_schema_required_fields(schema.get("required"), "Start inputSchema")?;
    for name in &required {
        if !properties.is_some_and(|props| props.contains_key(*name)) {
            return Err(format!(
                "Start inputSchema.required references an unknown field: {name}"
            ));
        }
    }

    let mut total_fields = prop_len;
    if total_fields > MAX_START_SCHEMA_TOTAL_FIELDS {
        return Err("Start inputSchema exceeds the maximum total field count".into());
    }
    for (name, field_schema) in properties.into_iter().flatten() {
        validate_start_field_schema(
            field_schema,
            &format!("Start inputSchema field {name}"),
            0,
            &mut total_fields,
        )?;
    }
    Ok(())
}

pub(crate) fn validate_workflow_start_input(input: &Value, schema: &Value) -> Result<(), String> {
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
                .ok_or("Start inputSchema.properties must be an object")
        })
        .transpose()?;
    let required = start_schema_required_fields(schema.get("required"), "Start inputSchema")?;
    for name in required {
        if !input.contains_key(name) {
            return Err(format!("Workflow input is missing required field: {name}"));
        }
    }
    for (name, field_schema) in properties.into_iter().flatten() {
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
            let properties = schema.get("properties").and_then(Value::as_object);
            for name in start_schema_required_fields(schema.get("required"), path)? {
                if !value.contains_key(name) {
                    return Err(format!("{path} is missing required field {name}"));
                }
            }
            for (name, property_schema) in properties.into_iter().flatten() {
                if let Some(property) = value.get(name) {
                    validate_start_field_value(
                        property,
                        property_schema,
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
            let prop_len = properties.map_or(0, serde_json::Map::len);
            if prop_len > MAX_START_SCHEMA_FIELDS_PER_OBJECT {
                return Err(format!(
                    "{path}.properties exceeds {MAX_START_SCHEMA_FIELDS_PER_OBJECT} fields"
                ));
            }
            *total_fields += prop_len;
            if *total_fields > MAX_START_SCHEMA_TOTAL_FIELDS {
                return Err(format!("{path} exceeds the maximum total field count"));
            }
            let required = start_schema_required_fields(schema.get("required"), path)?;
            for name in required {
                if !properties.is_some_and(|props| props.contains_key(name)) {
                    return Err(format!(
                        "{path}.required references an unknown field: {name}"
                    ));
                }
            }
            for (name, field_schema) in properties.into_iter().flatten() {
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

fn start_schema_required_fields<'a>(
    required: Option<&'a Value>,
    path: &str,
) -> Result<Vec<&'a str>, String> {
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
        result.push(name);
    }
    Ok(result)
}

fn supported_start_schema_type(kind: &str) -> bool {
    matches!(
        kind,
        "string" | "number" | "boolean" | "object" | "array" | "any"
    )
}
