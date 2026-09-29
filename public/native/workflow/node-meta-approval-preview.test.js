import { describe, expect, it } from "vitest";
import { nodeMetaApprovalPreview } from "./node-meta-approval-preview.js";

const candidate = {
  schemaVersion: 1,
  id: "custom.lookup",
  version: "1.0.0",
  type: "custom",
  label: "Lookup",
  description: "Find a record.",
  inputs: [{ name: "query", label: "Query", type: "string", required: true }],
  outputs: [{ name: "record", label: "Record", type: "object", required: false }],
  params: [
    {
      name: "strategy",
      label: "Strategy",
      type: "select",
      required: true,
      defaultValue: "exact",
      description: "How to match.",
      options: [
        { label: "Exact", value: "exact" },
        { label: "Fuzzy", value: "fuzzy" },
      ],
    },
  ],
  execution: { kind: "user-code", entrypoint: "custom.lookup" },
  permissions: { filesystem: "none", network: "none", shell: "none" },
  implementationDraft: {
    language: "typescript",
    source: "export function run() {}",
    entryFn: "run",
  },
  i18n: {
    en: {
      label: "Lookup",
      description: "Find a record.",
      inputs: { query: "Query" },
      outputs: { record: "Record" },
      params: {
        strategy: {
          label: "Strategy",
          description: "How to match.",
          options: { exact: "Exact", fuzzy: "Fuzzy" },
        },
      },
    },
    zh: {
      label: "查找",
      description: "查找一条记录。",
      inputs: { query: "查询词" },
      outputs: { record: "记录" },
      params: {
        strategy: {
          label: "匹配方式",
          description: "如何匹配。",
          options: { exact: "精确", fuzzy: "模糊" },
        },
      },
    },
    es: {
      label: "Buscar",
      description: "Buscar un registro.",
      inputs: { query: "Consulta" },
      outputs: { record: "Registro" },
      params: {
        strategy: {
          label: "Estrategia",
          description: "Cómo buscar.",
          options: { exact: "Exacta", fuzzy: "Difusa" },
        },
      },
    },
    ja: {
      label: "検索",
      description: "レコードを検索します。",
      inputs: { query: "検索語" },
      outputs: { record: "レコード" },
      params: {
        strategy: {
          label: "照合方法",
          description: "照合方法の説明。",
          options: { exact: "完全一致", fuzzy: "あいまい" },
        },
      },
    },
  },
};

describe("NodeMeta approval preview", () => {
  it.each([
    ["en", "Lookup", "Find a record.", "Query", "Record", "Strategy", "How to match.", "Exact"],
    ["zh", "查找", "查找一条记录。", "查询词", "记录", "匹配方式", "如何匹配。", "精确"],
    [
      "es",
      "Buscar",
      "Buscar un registro.",
      "Consulta",
      "Registro",
      "Estrategia",
      "Cómo buscar.",
      "Exacta",
    ],
    [
      "ja",
      "検索",
      "レコードを検索します。",
      "検索語",
      "レコード",
      "照合方法",
      "照合方法の説明。",
      "完全一致",
    ],
  ])(
    "shows all candidate labels in the selected %s locale",
    (locale, label, description, input, output, param, paramDescription, option) => {
      const preview = nodeMetaApprovalPreview(candidate, locale);

      expect(preview.label).toBe(label);
      expect(preview.description).toBe(description);
      expect(preview.inputs[0].label).toBe(input);
      expect(preview.outputs[0].label).toBe(output);
      expect(preview.params[0].label).toBe(param);
      expect(preview.params[0].description).toBe(paramDescription);
      expect(preview.params[0].options[0].label).toBe(option);
      expect(preview).not.toHaveProperty("i18n");
    },
  );

  it("retains machine contracts and implementation details without mutating the candidate", () => {
    const before = structuredClone(candidate);
    const preview = nodeMetaApprovalPreview(candidate, "zh");

    expect(preview).toMatchObject({
      id: "custom.lookup",
      version: "1.0.0",
      inputs: [{ name: "query", type: "string", required: true }],
      execution: { kind: "user-code", entrypoint: "custom.lookup" },
      permissions: { filesystem: "none", network: "none", shell: "none" },
      implementationDraft: { source: "export function run() {}" },
    });
    expect(preview.params[0]).toMatchObject({ name: "strategy", defaultValue: "exact" });
    expect(preview.params[0].options.map((option) => option.value)).toEqual(["exact", "fuzzy"]);
    expect(candidate).toEqual(before);
  });
});
