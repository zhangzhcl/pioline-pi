import { describe, expect, it } from "vitest";
import { validateWorkflowStartInput } from "./workflow-start-schema.js";

describe("workflow Start input schemas", () => {
  it("validates nested object requirements and array items", () => {
    const schema = {
      properties: {
        profile: {
          type: "object",
          properties: {
            name: "string",
            preferences: {
              type: "object",
              properties: { digest: "boolean" },
              required: ["digest"],
            },
          },
          required: ["name", "preferences"],
        },
        tags: { type: "array", items: "string" },
      },
      required: ["profile"],
    };

    expect(() =>
      validateWorkflowStartInput(
        { profile: { name: "Pipline", preferences: { digest: true } }, tags: ["workflow"] },
        schema,
      ),
    ).not.toThrow();
    expect(() =>
      validateWorkflowStartInput({ profile: { name: "Pipline" }, tags: ["workflow"] }, schema),
    ).toThrow("Workflow input field profile is missing required field preferences");
    expect(() =>
      validateWorkflowStartInput(
        { profile: { name: "Pipline", preferences: { digest: true } }, tags: ["workflow", 4] },
        schema,
      ),
    ).toThrow("Workflow input field tags[1] must be string");
  });

  it("rejects unsupported schema keywords and excessive nesting", () => {
    expect(() =>
      validateWorkflowStartInput(
        {},
        { properties: { request: { type: "string", pattern: ".+" } } },
      ),
    ).toThrow("Start inputSchema field request contains unsupported schema fields");

    let fieldSchema = "string";
    for (let depth = 0; depth <= 16; depth += 1) {
      fieldSchema = { type: "object", properties: { next: fieldSchema } };
    }
    expect(() => validateWorkflowStartInput({}, { properties: { value: fieldSchema } })).toThrow(
      "exceeds the maximum schema depth",
    );
  });

  it("rejects unsupported root schema keywords and excessive total fields", () => {
    expect(() =>
      validateWorkflowStartInput({}, { properties: {}, additionalProperties: false }),
    ).toThrow("Start inputSchema contains unsupported schema fields");

    let fieldSchema = "string";
    for (let depth = 0; depth < 10; depth += 1) {
      fieldSchema = {
        type: "object",
        properties: { left: fieldSchema, right: fieldSchema },
      };
    }
    expect(() => validateWorkflowStartInput({}, { properties: { value: fieldSchema } })).toThrow(
      "exceeds the maximum total field count",
    );
  });

  it("rejects null where an optional schema object or list was explicitly provided", () => {
    expect(() => validateWorkflowStartInput({}, { properties: null })).toThrow(
      "Start inputSchema.properties must be an object",
    );
    expect(() => validateWorkflowStartInput({}, { required: null })).toThrow(
      "Start inputSchema.required must contain unique field names",
    );
  });
});
