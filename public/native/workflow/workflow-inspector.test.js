import { describe, expect, it } from "vitest";
import * as workflowInspector from "./workflow-inspector.js";
import {
  createInspectorDescription,
  createInspectorError,
  resolveInspectorBooleanParamValue,
  resolveInspectorParamLabel,
} from "./workflow-inspector.js";

describe("workflow inspector descriptions", () => {
  it("uses the localized parameter label for accessible field names", () => {
    const translate = (key) => ({ "workflow.nodeFields.jsonPath": "字段路径" })[key] ?? key;

    expect(
      resolveInspectorParamLabel(
        { label: "JSON path", labelKey: "workflow.nodeFields.jsonPath" },
        translate,
      ),
    ).toBe("字段路径");
  });

  it("renders parameter help as localized text beside its control", () => {
    const description = createInspectorDescription("声明嵌套对象和数组输入结构。", document);

    expect(description.tagName).toBe("P");
    expect(description.className).toBe("workflow-inspector__field-description");
    expect(description.textContent).toBe("声明嵌套对象和数组输入结构。");
  });

  it("does not create empty helper text", () => {
    expect(createInspectorDescription("", document)).toBeNull();
    expect(createInspectorDescription(undefined, document)).toBeNull();
  });

  it("renders validation errors with the inspector error primitive", () => {
    const error = createInspectorError("Start input schema is invalid.", document);

    expect(error.tagName).toBe("SPAN");
    expect(error.className).toBe("workflow-inspector__field-error");
    expect(error.textContent).toBe("Start input schema is invalid.");
  });

  it("keeps an explicitly saved null JSON value instead of showing the template default", () => {
    const resolveValue = workflowInspector.resolveInspectorParamValue;
    expect(resolveValue).toBeTypeOf("function");
    expect(
      resolveValue(
        { paramValues: { expected: null } },
        {
          name: "expected",
          type: "json",
          defaultValue: "fallback",
        },
      ),
    ).toBeNull();
  });

  it("shows boolean parameter defaults and gives explicit values precedence", () => {
    expect(
      resolveInspectorBooleanParamValue(
        { paramValues: {} },
        { name: "enabled", defaultValue: true },
      ),
    ).toBe(true);
    expect(
      resolveInspectorBooleanParamValue(
        { paramValues: { enabled: false } },
        { name: "enabled", defaultValue: true },
      ),
    ).toBe(false);
  });

  it.each([
    ["null", null],
    ["false", false],
    ["zero", 0],
  ])("preserves an explicitly saved static input value: %s", (_label, staticValue) => {
    const resolveValue = workflowInspector.resolveInspectorInputValue;
    expect(resolveValue).toBeTypeOf("function");
    expect(
      resolveValue(
        { portValues: { value: { mode: "static", staticValue } } },
        { name: "value", type: "any" },
      ),
    ).toBe(staticValue);
  });
});
