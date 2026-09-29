import { describe, expect, it } from "vitest";
import { BUILTIN_NODE_METAS, createStarterWorkflow, nodeMetaKey } from "./builtin-node-registry.js";
import { validateNodeMeta, validateWorkflow } from "./workflow-contracts.js";

describe("built-in workflow node contracts", () => {
  it("validates every shipped immutable NodeMeta version", () => {
    expect(BUILTIN_NODE_METAS.size).toBe(16);

    for (const [key, meta] of BUILTIN_NODE_METAS) {
      expect(nodeMetaKey(meta)).toBe(key);
      expect(validateNodeMeta(meta), key).toEqual([]);
    }
  });

  it("starts new workflows with the current visible template versions", () => {
    let instanceSequence = 0;
    const workflow = createStarterWorkflow({
      id: "starter-test",
      workspaceId: "workspace-test",
      makeId: () => `instance-${++instanceSequence}`,
      timestamp: "2026-09-27T00:00:00.000Z",
    });
    const metas = new Map(
      [...BUILTIN_NODE_METAS].filter(([, meta]) => meta.catalogHidden !== true),
    );

    expect(workflow.nodes.filter((node) => node.meta.id === "pipline.start")).toHaveLength(1);
    expect(workflow.nodes.filter((node) => node.meta.id === "pipline.end")).toHaveLength(1);
    for (const node of workflow.nodes) {
      const meta = metas.get(nodeMetaKey(node.meta));
      expect(meta).toBeDefined();
      expect(validateNodeMeta(meta)).toEqual([]);
    }
    expect(metas.get("pipline.assign@2.0.0")).toBeDefined();
    expect(metas.get("pipline.extract@2.0.0")).toBeDefined();
    expect(metas.get("pipline.merge@3.0.0")).toBeDefined();
    expect(metas.get("pipline.merge-by-port@1.0.0")).toBeDefined();
    expect(metas.get("pipline.condition@2.0.0")).toBeDefined();
    expect(metas.has("pipline.assign@1.0.0")).toBe(false);
    expect(metas.has("pipline.extract@1.0.0")).toBe(false);
    expect(metas.has("pipline.merge@1.0.0")).toBe(true);
    expect(metas.has("pipline.merge@2.0.0")).toBe(false);
    expect(metas.has("pipline.condition@1.0.0")).toBe(false);
    expect(workflow.nodes.find((node) => node.meta.id === "pipline.pi-agent")?.meta.version).toBe(
      "2.0.0",
    );
    expect(validateWorkflow(workflow, BUILTIN_NODE_METAS)).toEqual([]);
  });

  it("rejects an invalid Start input schema in workflow validation", () => {
    let instanceSequence = 0;
    const workflow = createStarterWorkflow({
      id: "invalid-start-schema",
      workspaceId: "workspace-test",
      makeId: () => `instance-${++instanceSequence}`,
      timestamp: "2026-09-27T00:00:00.000Z",
    });
    const start = workflow.nodes.find((node) => node.meta.id === "pipline.start");
    start.paramValues.inputSchema = {
      properties: { request: { type: "string", pattern: ".+" } },
    };

    expect(validateWorkflow(workflow, BUILTIN_NODE_METAS)).toContain(
      "Start inputSchema field request contains unsupported schema fields",
    );
  });

  it("validates static input values against their complete port schemas", () => {
    let instanceSequence = 0;
    const workflow = createStarterWorkflow({
      id: "static-port-type-test",
      workspaceId: "workspace-test",
      makeId: () => `instance-${++instanceSequence}`,
      timestamp: "2026-09-27T00:00:00.000Z",
    });
    const agent = workflow.nodes.find((node) => node.meta.id === "pipline.pi-agent");
    agent.portValues.context = { mode: "static", staticValue: "not an object" };

    expect(
      validateWorkflow(workflow, BUILTIN_NODE_METAS).some((error) =>
        error.includes("portValues.context.staticValue does not match"),
      ),
    ).toBe(true);
  });

  it.each([
    {
      label: "array item types",
      outputType: { kind: "array", items: "number" },
      inputType: { kind: "array", items: "string" },
      compatible: false,
    },
    {
      label: "nested object property types",
      outputType: {
        kind: "object",
        schema: {
          properties: { payload: { kind: "array", items: "number" } },
          required: ["payload"],
        },
      },
      inputType: {
        kind: "object",
        schema: {
          properties: { payload: { kind: "array", items: "string" } },
          required: ["payload"],
        },
      },
      compatible: false,
    },
    {
      label: "compatible array item types",
      outputType: { kind: "array", items: "number" },
      inputType: { kind: "array", items: "number" },
      compatible: true,
    },
  ])(
    "checks recursive connection compatibility for $label",
    ({ outputType, inputType, compatible }) => {
      let instanceSequence = 0;
      const workflow = createStarterWorkflow({
        id: "recursive-port-type-test",
        workspaceId: "workspace-test",
        makeId: () => `instance-${++instanceSequence}`,
        timestamp: "2026-09-27T00:00:00.000Z",
      });
      const metas = new Map(BUILTIN_NODE_METAS);
      const piMeta = structuredClone(metas.get("pipline.pi-agent@2.0.0"));
      const endMeta = structuredClone(metas.get("pipline.end@1.0.0"));
      piMeta.outputs[0].type = outputType;
      endMeta.inputs[0].type = inputType;
      metas.set("pipline.pi-agent@2.0.0", piMeta);
      metas.set("pipline.end@1.0.0", endMeta);

      const errors = validateWorkflow(workflow, metas);
      expect(errors.some((error) => error.includes("connects incompatible port types"))).toBe(
        !compatible,
      );
    },
  );
});
