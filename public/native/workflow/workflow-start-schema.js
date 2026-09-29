// ABOUTME: Validates bounded, declarative Start-node input schemas and values.

const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_FIELDS = 256;
const MAX_SCHEMA_TOTAL_FIELDS = 1_024;
const SUPPORTED_TYPES = new Set(["string", "number", "boolean", "object", "array", "any"]);

export function validateWorkflowStartSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new TypeError("Start inputSchema must be an object");
  if (Object.keys(schema).some((key) => key !== "properties" && key !== "required"))
    throw new TypeError("Start inputSchema contains unsupported schema fields");
  const properties = Object.hasOwn(schema, "properties") ? schema.properties : {};
  const required = Object.hasOwn(schema, "required") ? schema.required : [];
  if (!properties || typeof properties !== "object" || Array.isArray(properties))
    throw new TypeError("Start inputSchema.properties must be an object");
  if (Object.keys(properties).length > MAX_SCHEMA_FIELDS)
    throw new RangeError(`Start inputSchema.properties exceeds ${MAX_SCHEMA_FIELDS} fields`);
  if (
    !Array.isArray(required) ||
    required.length > MAX_SCHEMA_FIELDS ||
    required.some((name) => typeof name !== "string") ||
    new Set(required).size !== required.length
  )
    throw new TypeError("Start inputSchema.required must contain unique field names");
  for (const name of required) {
    if (!Object.hasOwn(properties, name))
      throw new TypeError(`Start inputSchema.required references an unknown field: ${name}`);
  }
  const budget = { fields: Object.keys(properties).length };
  if (budget.fields > MAX_SCHEMA_TOTAL_FIELDS)
    throw new RangeError(`Start inputSchema exceeds the maximum total field count`);
  for (const [name, fieldSchema] of Object.entries(properties)) {
    assertFieldSchema(fieldSchema, `Start inputSchema field ${name}`, 0, budget);
  }
  return { properties, required };
}

export function validateWorkflowStartInput(input, schema) {
  const { properties, required } = validateWorkflowStartSchema(schema);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Workflow input must be an object");
  for (const name of required) {
    if (!Object.hasOwn(input, name))
      throw new TypeError(`Workflow input is missing required field: ${name}`);
  }
  for (const [name, fieldSchema] of Object.entries(properties)) {
    if (Object.hasOwn(input, name))
      validateField(input[name], fieldSchema, `Workflow input field ${name}`, 0);
  }
}

function assertFieldSchema(schema, path, depth, budget) {
  if (depth > MAX_SCHEMA_DEPTH) throw new RangeError(`${path} exceeds the maximum schema depth`);
  if (typeof schema === "string") {
    if (!SUPPORTED_TYPES.has(schema)) throw new TypeError(`${path} has an unsupported type`);
    return;
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new TypeError(`${path} must be a supported type or schema object`);
  const type = schema.type;
  if (!SUPPORTED_TYPES.has(type)) throw new TypeError(`${path} has an unsupported type`);
  const allowedKeys =
    type === "object"
      ? new Set(["type", "properties", "required"])
      : type === "array"
        ? new Set(["type", "items"])
        : new Set(["type"]);
  if (Object.keys(schema).some((key) => !allowedKeys.has(key)))
    throw new TypeError(`${path} contains unsupported schema fields`);
  if (type === "object") {
    const properties = Object.hasOwn(schema, "properties") ? schema.properties : {};
    const required = Object.hasOwn(schema, "required") ? schema.required : [];
    if (!properties || typeof properties !== "object" || Array.isArray(properties))
      throw new TypeError(`${path}.properties must be an object`);
    const entries = Object.entries(properties);
    if (entries.length > MAX_SCHEMA_FIELDS)
      throw new RangeError(`${path}.properties exceeds ${MAX_SCHEMA_FIELDS} fields`);
    budget.fields += entries.length;
    if (budget.fields > MAX_SCHEMA_TOTAL_FIELDS)
      throw new RangeError(`${path} exceeds the maximum total field count`);
    if (
      !Array.isArray(required) ||
      required.length > MAX_SCHEMA_FIELDS ||
      required.some((name) => typeof name !== "string") ||
      new Set(required).size !== required.length
    )
      throw new TypeError(`${path}.required must contain unique field names`);
    for (const name of required) {
      if (!Object.hasOwn(properties, name))
        throw new TypeError(`${path}.required references an unknown field: ${name}`);
    }
    for (const [name, propertySchema] of entries)
      assertFieldSchema(propertySchema, `${path}.${name}`, depth + 1, budget);
  } else if (type === "array") {
    if (!Object.hasOwn(schema, "items")) throw new TypeError(`${path}.items is required`);
    assertFieldSchema(schema.items, `${path}[]`, depth + 1, budget);
  }
}

function validateField(value, schema, path, depth) {
  if (depth > MAX_SCHEMA_DEPTH) throw new RangeError(`${path} exceeds the maximum data depth`);
  const type = typeof schema === "string" ? schema : schema.type;
  if (!matchesType(value, type)) throw new TypeError(`${path} must be ${type}`);
  if (type === "object" && typeof schema === "object") {
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const name of required) {
      if (!Object.hasOwn(value, name))
        throw new TypeError(`${path} is missing required field ${name}`);
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, name))
        validateField(value[name], propertySchema, `${path}.${name}`, depth + 1);
    }
  } else if (type === "array" && typeof schema === "object") {
    value.forEach((item, index) => {
      validateField(item, schema.items, `${path}[${index}]`, depth + 1);
    });
  }
}

function matchesType(value, type) {
  switch (type) {
    case "any":
      return isJsonValue(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

function isJsonValue(value, depth = 0) {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
