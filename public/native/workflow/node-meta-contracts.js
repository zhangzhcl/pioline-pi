// ABOUTME: NodeMeta schema contracts and value-type validation helpers shared across workflow modules.

export const WORKFLOW_SCHEMA_VERSION = 1;

export const VALUE_TYPES = new Set(["string", "number", "boolean", "object", "array", "any"]);
export const MAX_VALUE_DEPTH = 64;
export const MAX_TYPE_DEPTH = 24;
export const MAX_OBJECT_SCHEMA_FIELDS = 256;
const NODE_META_LOCALES = ["en", "zh", "es", "ja"];

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isJsonValue(value, depth = 0) {
  if (depth > MAX_VALUE_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function typeName(type) {
  return typeof type === "string" ? type : type?.kind;
}

export function edgeValueType(port) {
  return port?.multi === true && isRecord(port.type) && port.type.kind === "array"
    ? port.type.items
    : port?.type;
}

export function isCompatibleType(outputType, inputType, depth = 0) {
  const output = typeName(outputType);
  const input = typeName(inputType);
  if (output === "any" || input === "any") return true;
  if (output !== input || depth > MAX_TYPE_DEPTH) return false;
  if (output === "array" && inputType === "array") return true;
  if (output === "array") return isCompatibleType(outputType.items, inputType.items, depth + 1);
  if (output === "object") {
    const outputSchema =
      isRecord(outputType) && isRecord(outputType.schema) ? outputType.schema : null;
    const inputSchema = isRecord(inputType) && isRecord(inputType.schema) ? inputType.schema : null;
    if (!inputSchema) return true;
    if (!outputSchema) return false;
    const outputProperties = isRecord(outputSchema.properties) ? outputSchema.properties : {};
    const inputProperties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
    const outputRequired = new Set(
      Array.isArray(outputSchema.required) ? outputSchema.required : [],
    );
    const inputRequired = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    if (inputRequired.some((name) => !outputRequired.has(name))) return false;
    return Object.entries(inputProperties).every(
      ([name, type]) =>
        Object.hasOwn(outputProperties, name) &&
        isCompatibleType(outputProperties[name], type, depth + 1),
    );
  }
  return true;
}

export function valueMatchesType(value, type, depth = 0) {
  if (depth > MAX_VALUE_DEPTH) return false;
  switch (typeName(type)) {
    case "any":
      return isJsonValue(value, depth);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      if (!isRecord(value)) return false;
      if (typeof type === "object" && isRecord(type.schema)) {
        const properties = isRecord(type.schema.properties) ? type.schema.properties : {};
        const required = Array.isArray(type.schema.required) ? type.schema.required : [];
        if (required.some((key) => !Object.hasOwn(value, key))) return false;
        return Object.entries(properties).every(
          ([key, propertyType]) =>
            !Object.hasOwn(value, key) || valueMatchesType(value[key], propertyType, depth + 1),
        );
      }
      return true;
    case "array":
      return (
        Array.isArray(value) &&
        (typeof type === "string" ||
          value.every((item) => valueMatchesType(item, type.items, depth + 1)))
      );
    default:
      return false;
  }
}

export function requireString(value, path, errors, { empty = false, maxLength = Infinity } = {}) {
  if (typeof value !== "string" || (!empty && value.trim() === ""))
    errors.push(`${path} must be a non-empty string`);
  else if (Array.from(value).length > maxLength)
    errors.push(`${path} exceeds ${maxLength} characters`);
}

function validateValueType(valueType, path, errors, depth = 0) {
  if (depth > MAX_TYPE_DEPTH) {
    errors.push(`${path} exceeds the maximum type nesting depth`);
    return;
  }
  if (typeof valueType === "string") {
    if (!VALUE_TYPES.has(valueType)) errors.push(`${path} is unsupported`);
    return;
  }
  if (!isRecord(valueType)) {
    errors.push(`${path} must be a supported type`);
    return;
  }
  if (valueType.kind === "array")
    validateValueType(valueType.items, `${path}.items`, errors, depth + 1);
  else if (valueType.kind === "object") {
    if (valueType.schema !== undefined) {
      if (!isRecord(valueType.schema)) {
        errors.push(`${path}.schema must be an object`);
        return;
      }
      const { properties, required } = valueType.schema;
      if (properties !== undefined && !isRecord(properties))
        errors.push(`${path}.schema.properties must be an object`);
      else if (isRecord(properties)) {
        const entries = Object.entries(properties);
        if (entries.length > MAX_OBJECT_SCHEMA_FIELDS)
          errors.push(`${path}.schema.properties exceeds ${MAX_OBJECT_SCHEMA_FIELDS} fields`);
        for (const [key, propertyType] of entries.slice(0, MAX_OBJECT_SCHEMA_FIELDS)) {
          if (Array.from(key).length > 128)
            errors.push(`${path}.schema.properties contains a key longer than 128 characters`);
          validateValueType(propertyType, `${path}.schema.properties.${key}`, errors, depth + 1);
        }
      }
      if (required !== undefined) {
        if (!Array.isArray(required) || required.some((key) => typeof key !== "string")) {
          errors.push(`${path}.schema.required must be an array of field names`);
        } else {
          if (required.length > MAX_OBJECT_SCHEMA_FIELDS)
            errors.push(`${path}.schema.required exceeds ${MAX_OBJECT_SCHEMA_FIELDS} fields`);
          if (new Set(required).size !== required.length)
            errors.push(`${path}.schema.required contains duplicate fields`);
          const knownProperties = isRecord(properties) ? properties : {};
          for (const key of required) {
            if (typeof key === "string" && !Object.hasOwn(knownProperties, key))
              errors.push(`${path}.schema.required references an unknown property: ${key}`);
          }
        }
      }
    }
  } else if (!VALUE_TYPES.has(valueType.kind)) errors.push(`${path}.kind is unsupported`);
}

function validatePort(port, path, errors) {
  if (!isRecord(port)) {
    errors.push(`${path} must be an object`);
    return;
  }
  requireString(port.name, `${path}.name`, errors, { maxLength: 128 });
  requireString(port.label, `${path}.label`, errors, { maxLength: 256 });
  validateValueType(port.type, `${path}.type`, errors);
  if (typeof port.required !== "boolean") errors.push(`${path}.required must be boolean`);
  if (typeof port.allowStaticValue !== "boolean")
    errors.push(`${path}.allowStaticValue must be boolean`);
  if (port.multi !== undefined && typeof port.multi !== "boolean")
    errors.push(`${path}.multi must be boolean`);
  if (port.multi === true && (!isRecord(port.type) || port.type.kind !== "array"))
    errors.push(`${path}.type must declare an array schema when multi is true`);
}

function validateParam(param, path, errors) {
  if (!isRecord(param)) {
    errors.push(`${path} must be an object`);
    return;
  }
  requireString(param.name, `${path}.name`, errors, { maxLength: 128 });
  requireString(param.label, `${path}.label`, errors, { maxLength: 256 });
  if (param.description !== undefined)
    requireString(param.description, `${path}.description`, errors, {
      empty: true,
      maxLength: 4_000,
    });
  if (!VALUE_TYPES.has(param.type) && !new Set(["select", "json"]).has(param.type))
    errors.push(`${path}.type is unsupported`);
  if (typeof param.required !== "boolean") errors.push(`${path}.required must be boolean`);
  if (param.defaultValue !== undefined) {
    const type = param.type === "select" ? "string" : param.type === "json" ? "any" : param.type;
    if (!isJsonValue(param.defaultValue) || !valueMatchesType(param.defaultValue, type))
      errors.push(`${path}.defaultValue does not match ${param.type}`);
  }
  if (param.type === "select") {
    if (
      !Array.isArray(param.options) ||
      param.options.length === 0 ||
      param.options.length > MAX_OBJECT_SCHEMA_FIELDS
    ) {
      errors.push(`${path}.options must contain 1 to ${MAX_OBJECT_SCHEMA_FIELDS} options`);
    } else {
      const values = new Set();
      param.options.forEach((option, index) => {
        if (
          !isRecord(option) ||
          typeof option.label !== "string" ||
          option.label.trim() === "" ||
          Array.from(option.label).length > 256 ||
          typeof option.value !== "string" ||
          option.value.trim() === "" ||
          Array.from(option.value).length > 128
        ) {
          errors.push(`${path}.options[${index}] must have non-empty string label and value`);
          return;
        }
        if (values.has(option.value)) errors.push(`${path}.options[${index}].value is duplicated`);
        values.add(option.value);
      });
      if (param.defaultValue !== undefined && !values.has(param.defaultValue))
        errors.push(`${path}.defaultValue must match a select option`);
    }
  }
}

function validateNodeMetaI18n(meta, errors) {
  if (meta.i18n === undefined) return;
  if (
    !isRecord(meta.i18n) ||
    Object.keys(meta.i18n).length !== NODE_META_LOCALES.length ||
    NODE_META_LOCALES.some((locale) => !Object.hasOwn(meta.i18n, locale))
  ) {
    errors.push("meta.i18n must be an object");
    return;
  }
  for (const locale of NODE_META_LOCALES) {
    const entry = meta.i18n[locale];
    const path = `meta.i18n.${locale}`;
    if (!isRecord(entry)) {
      errors.push(`${path} is required`);
      continue;
    }
    requireString(entry.label, `${path}.label`, errors, { maxLength: 256 });
    requireString(entry.description, `${path}.description`, errors, {
      empty: true,
      maxLength: 4_000,
    });
    for (const group of ["inputs", "outputs", "params"]) {
      const sourceItems = Array.isArray(meta[group]) ? meta[group] : [];
      const translations = entry[group];
      if (!isRecord(translations)) {
        errors.push(`${path}.${group} must be an object`);
        continue;
      }
      const expectedNames = new Set(sourceItems.map((item) => item?.name).filter(Boolean));
      if (Object.keys(translations).length !== expectedNames.size)
        errors.push(`${path}.${group} must contain exactly the declared items`);
      for (const name of expectedNames) {
        const translation = Object.hasOwn(translations, name) ? translations[name] : undefined;
        if (group !== "params") {
          requireString(translation, `${path}.${group}.${name}`, errors, { maxLength: 256 });
          continue;
        }
        if (!isRecord(translation)) {
          errors.push(`${path}.${group}.${name} must be an object`);
          continue;
        }
        requireString(translation.label, `${path}.${group}.${name}.label`, errors, {
          maxLength: 256,
        });
        if (sourceItems.find((item) => item?.name === name)?.description !== undefined)
          requireString(translation.description, `${path}.${group}.${name}.description`, errors, {
            empty: true,
            maxLength: 4_000,
          });
        const param = sourceItems.find((item) => item?.name === name);
        if (Array.isArray(param?.options)) {
          if (!isRecord(translation.options)) {
            errors.push(`${path}.${group}.${name}.options must be an object`);
          } else {
            for (const option of param.options)
              requireString(
                translation.options[option.value],
                `${path}.${group}.${name}.options.${option.value}`,
                errors,
                { maxLength: 256 },
              );
            if (Object.keys(translation.options).length !== param.options.length)
              errors.push(`${path}.${group}.${name}.options must match the declared options`);
          }
        } else if (param?.options !== undefined) {
          errors.push(`meta.params.${name}.options must be an array`);
        }
      }
    }
  }
}

export function validateNodeMeta(meta) {
  const errors = [];
  if (!isRecord(meta)) return ["meta must be an object"];
  if (meta.schemaVersion !== WORKFLOW_SCHEMA_VERSION)
    errors.push("meta.schemaVersion is unsupported");
  for (const key of ["id", "version", "type", "label", "description"]) {
    requireString(meta[key], `meta.${key}`, errors, {
      empty: key === "description",
      maxLength:
        key === "id"
          ? 128
          : key === "version"
            ? 32
            : key === "type"
              ? 64
              : key === "label"
                ? 256
                : 4_000,
    });
  }
  for (const key of ["inputs", "outputs", "params"]) {
    if (!Array.isArray(meta[key])) errors.push(`meta.${key} must be an array`);
  }
  for (const key of ["inputs", "outputs"]) {
    if (Array.isArray(meta[key])) {
      if (meta[key].length > MAX_OBJECT_SCHEMA_FIELDS)
        errors.push(`meta.${key} exceeds ${MAX_OBJECT_SCHEMA_FIELDS} entries`);
      meta[key].slice(0, MAX_OBJECT_SCHEMA_FIELDS).forEach((port, index) => {
        validatePort(port, `meta.${key}[${index}]`, errors);
      });
    }
  }
  if (Array.isArray(meta.params)) {
    if (meta.params.length > MAX_OBJECT_SCHEMA_FIELDS)
      errors.push(`meta.params exceeds ${MAX_OBJECT_SCHEMA_FIELDS} entries`);
    meta.params.slice(0, MAX_OBJECT_SCHEMA_FIELDS).forEach((param, index) => {
      validateParam(param, `meta.params[${index}]`, errors);
    });
  }
  if (
    !isRecord(meta.execution) ||
    !["builtin", "pi-agent", "user-code"].includes(meta.execution.kind)
  ) {
    errors.push("meta.execution.kind is unsupported");
  }
  if (!isRecord(meta.permissions)) errors.push("meta.permissions must be an object");
  for (const key of ["inputs", "outputs", "params"]) {
    if (!Array.isArray(meta[key])) continue;
    const names = new Set();
    for (const [index, item] of meta[key].entries()) {
      if (!isRecord(item) || typeof item.name !== "string") continue;
      if (names.has(item.name)) errors.push(`meta.${key}[${index}].name is duplicated`);
      names.add(item.name);
    }
  }
  validateNodeMetaI18n(meta, errors);
  return errors;
}
