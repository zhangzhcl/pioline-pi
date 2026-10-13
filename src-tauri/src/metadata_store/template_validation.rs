// 自定义节点模板（NodeMeta）字段类型、多语言字典、参数 Schema 与标识符校验辅助函数。

use serde_json::Value;

pub(super) fn valid_workflow_value_type(value_type: &Value, depth: usize) -> bool {
    const MAX_TYPE_DEPTH: usize = 24;
    const MAX_SCHEMA_FIELDS: usize = 256;

    if depth > MAX_TYPE_DEPTH {
        return false;
    }
    if let Some(kind) = value_type.as_str() {
        return matches!(
            kind,
            "string" | "number" | "boolean" | "object" | "array" | "any"
        );
    }
    let Some(object) = value_type.as_object() else {
        return false;
    };
    match object.get("kind").and_then(Value::as_str) {
        Some("array") => object
            .get("items")
            .is_some_and(|items| valid_workflow_value_type(items, depth + 1)),
        Some("object") => {
            let Some(schema) = object.get("schema") else {
                return true;
            };
            let Some(schema) = schema.as_object() else {
                return false;
            };
            let properties = schema.get("properties").and_then(Value::as_object);
            let properties_valid = match schema.get("properties") {
                None => true,
                Some(_) => properties.as_ref().is_some_and(|properties| {
                    properties.len() <= MAX_SCHEMA_FIELDS
                        && properties.iter().all(|(name, property)| {
                            name.chars().count() <= 128
                                && valid_workflow_value_type(property, depth + 1)
                        })
                }),
            };
            let required_valid = match schema.get("required") {
                None => true,
                Some(required) => required.as_array().is_some_and(|required| {
                    if required.len() > MAX_SCHEMA_FIELDS {
                        return false;
                    }
                    let mut seen = std::collections::HashSet::with_capacity(required.len());
                    required.iter().all(|field| {
                        field.as_str().is_some_and(|name| {
                            properties
                                .as_ref()
                                .is_some_and(|properties| properties.contains_key(name))
                                && seen.insert(name)
                        })
                    })
                }),
            };
            properties_valid && required_valid
        }
        Some("string" | "number" | "boolean" | "any") => true,
        _ => false,
    }
}

pub(super) fn valid_workflow_node_meta_i18n(meta: &Value) -> bool {
    let Some(locales) = meta.get("i18n").and_then(Value::as_object) else {
        return false;
    };
    if locales.len() != 4
        || ["en", "zh", "es", "ja"]
            .iter()
            .any(|locale| !locales.contains_key(*locale))
    {
        return false;
    }
    for locale in ["en", "zh", "es", "ja"] {
        let Some(entry) = locales.get(locale).and_then(Value::as_object) else {
            return false;
        };
        if entry
            .get("label")
            .and_then(Value::as_str)
            .is_none_or(|text| text.trim().is_empty() || text.chars().count() > 256)
            || entry
                .get("description")
                .and_then(Value::as_str)
                .is_none_or(|text| text.chars().count() > 4_000)
        {
            return false;
        }
        for group in ["inputs", "outputs", "params"] {
            let Some(source) = meta.get(group).and_then(Value::as_array) else {
                return false;
            };
            let Some(translations) = entry.get(group).and_then(Value::as_object) else {
                return false;
            };
            if translations.len() != source.len() {
                return false;
            }
            for item in source {
                let Some(name) = item.get("name").and_then(Value::as_str) else {
                    return false;
                };
                let Some(translation) = translations.get(name) else {
                    return false;
                };
                if group == "params" {
                    if translation
                        .get("label")
                        .and_then(Value::as_str)
                        .is_none_or(|text| text.trim().is_empty() || text.chars().count() > 256)
                    {
                        return false;
                    }
                    if item.get("description").is_some()
                        && translation
                            .get("description")
                            .and_then(Value::as_str)
                            .is_none_or(|text| text.chars().count() > 4_000)
                    {
                        return false;
                    }
                    if let Some(options) = item.get("options").and_then(Value::as_array) {
                        let Some(option_translations) =
                            translation.get("options").and_then(Value::as_object)
                        else {
                            return false;
                        };
                        if option_translations.len() != options.len()
                            || options.iter().any(|option| {
                                option
                                    .get("value")
                                    .and_then(Value::as_str)
                                    .is_none_or(|value| {
                                        option_translations
                                            .get(value)
                                            .and_then(Value::as_str)
                                            .is_none_or(|text| {
                                                text.trim().is_empty() || text.chars().count() > 256
                                            })
                                    })
                            })
                        {
                            return false;
                        }
                    }
                } else if translation
                    .as_str()
                    .is_none_or(|text| text.trim().is_empty() || text.chars().count() > 256)
                {
                    return false;
                }
            }
        }
    }
    true
}

pub(super) fn valid_workflow_node_param(param: &Value) -> bool {
    let Some(object) = param.as_object() else {
        return false;
    };
    let Some(name) = object.get("name").and_then(Value::as_str) else {
        return false;
    };
    let Some(label) = object.get("label").and_then(Value::as_str) else {
        return false;
    };
    let Some(kind) = object.get("type").and_then(Value::as_str) else {
        return false;
    };
    if name.trim().is_empty()
        || name.chars().count() > 128
        || label.trim().is_empty()
        || label.chars().count() > 256
        || object.get("description").is_some_and(|description| {
            description
                .as_str()
                .is_none_or(|text| text.chars().count() > 4_000)
        })
        || object.get("required").and_then(Value::as_bool).is_none()
        || !matches!(
            kind,
            "string" | "number" | "boolean" | "object" | "array" | "any" | "select" | "json"
        )
    {
        return false;
    }

    let options = if kind == "select" {
        let Some(options) = object.get("options").and_then(Value::as_array) else {
            return false;
        };
        if options.is_empty() || options.len() > 256 {
            return false;
        }
        let mut values = std::collections::HashSet::with_capacity(options.len());
        for option in options {
            let Some(option) = option.as_object() else {
                return false;
            };
            let Some(option_label) = option.get("label").and_then(Value::as_str) else {
                return false;
            };
            let Some(value) = option.get("value").and_then(Value::as_str) else {
                return false;
            };
            if option_label.trim().is_empty()
                || option_label.chars().count() > 256
                || value.trim().is_empty()
                || value.chars().count() > 128
                || !values.insert(value)
            {
                return false;
            }
        }
        Some(values)
    } else {
        None
    };

    if let Some(default) = object.get("defaultValue") {
        let value_type = match kind {
            "select" => "string",
            "json" => "any",
            _ => kind,
        };
        if !value_matches_workflow_type(default, value_type, 0) {
            return false;
        }
        if kind == "select"
            && !options
                .as_ref()
                .is_some_and(|values| default.as_str().is_some_and(|value| values.contains(value)))
        {
            return false;
        }
    }
    true
}

pub(super) fn value_matches_workflow_type(value: &Value, value_type: &str, depth: usize) -> bool {
    const MAX_VALUE_DEPTH: usize = 64;
    if depth > MAX_VALUE_DEPTH {
        return false;
    }
    match value_type {
        "any" => match value {
            Value::Array(items) => items
                .iter()
                .all(|item| valid_workflow_json_value(item, depth + 1)),
            Value::Object(items) => items
                .values()
                .all(|item| valid_workflow_json_value(item, depth + 1)),
            _ => true,
        },
        "string" => value.is_string(),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "object" => value
            .as_object()
            .is_some_and(|_| valid_workflow_json_value(value, depth)),
        "array" => value.as_array().is_some_and(|items| {
            items
                .iter()
                .all(|item| valid_workflow_json_value(item, depth + 1))
        }),
        _ => false,
    }
}

pub(super) fn workflow_node_names_are_unique(items: &[Value]) -> bool {
    let mut names = std::collections::HashSet::with_capacity(items.len());
    for item in items {
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            return false;
        };
        if !names.insert(name) {
            return false;
        }
    }
    true
}

pub(super) fn valid_workflow_json_value(value: &Value, depth: usize) -> bool {
    if depth > 64 {
        return false;
    }
    match value {
        Value::Array(items) => items
            .iter()
            .all(|item| valid_workflow_json_value(item, depth + 1)),
        Value::Object(items) => items
            .values()
            .all(|item| valid_workflow_json_value(item, depth + 1)),
        _ => true,
    }
}

pub(super) fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub(super) fn valid_custom_node_id(value: &str) -> bool {
    let Some(slug) = value.strip_prefix("custom.") else {
        return false;
    };
    let mut bytes = slug.bytes();
    if !bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return false;
    }
    bytes.all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
    })
}
