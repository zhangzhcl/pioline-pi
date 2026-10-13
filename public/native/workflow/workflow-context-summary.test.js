import { describe, expect, it } from "vitest";
import { BUILTIN_NODE_METAS } from "./builtin-node-registry.js";
import {
  addableNodeTemplates,
  normalizeAgentOperations,
  validateNodeMetaCandidate,
  workflowTypeSummary,
} from "./workflow-context-summary.js";

describe("workflow-context-summary", () => {
  it("excludes start/end and catalogHidden templates from addableNodeTemplates", () => {
    const templates = addableNodeTemplates(BUILTIN_NODE_METAS);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.some((item) => item.key.includes("start"))).toBe(false);
    expect(templates.some((item) => item.key.includes("end"))).toBe(false);
  });

  it("summarizes nested object and array port types within bounded depth", () => {
    const summary = workflowTypeSummary({
      kind: "array",
      items: {
        kind: "object",
        schema: {
          properties: {
            title: "string",
            count: "number",
          },
          required: ["title"],
        },
      },
    });
    expect(summary).toEqual({
      kind: "array",
      items: {
        kind: "object",
        schema: {
          properties: {
            title: "string",
            count: "number",
          },
          required: ["title"],
        },
      },
    });
  });

  it("rejects custom NodeMeta candidates outside custom.<slug> namespace", () => {
    const errors = validateNodeMetaCandidate({
      id: "builtin.bad",
      version: "1.0.0",
      type: "custom",
      label: "Bad",
      inputs: [],
      outputs: [],
      params: [],
      execution: { kind: "user-code" },
      permissions: { filesystem: "none", network: "none", shell: false },
    });
    expect(errors).toContain("custom NodeMeta id must use the custom.<slug> namespace");
  });

  it("normalizes agent add_node operations with default param values from known NodeMeta", () => {
    const operations = normalizeAgentOperations(
      [
        {
          type: "add_node",
          node: {
            instanceId: "node-1",
            meta: { id: "pipline.pi-agent", version: "2.0.0" },
            position: { x: 100, y: 200 },
          },
        },
      ],
      BUILTIN_NODE_METAS,
    );
    expect(operations).toHaveLength(1);
    expect(operations[0].type).toBe("add_node");
    expect(operations[0].node.instanceId).toBe("node-1");
    expect(operations[0].node.position).toEqual({ x: 100, y: 200 });
  });
});
