import { describe, expect, it } from "vitest";
import en from "../../locales/en.json";
import es from "../../locales/es.json";
import ja from "../../locales/ja.json";
import zh from "../../locales/zh.json";
import { formatWorkflowChatContext } from "./workflow-chat-context.js";

const locales = [
  ["en", en, "Use the current Pipline workflow"],
  ["zh", zh, "请结合当前 Pipline 工作流"],
  ["es", es, "Usa el flujo de trabajo actual de Pipline"],
  ["ja", ja, "現在の Pipline ワークフロー"],
];

function translateFrom(messages, key, params) {
  const value = key.split(".").reduce((current, part) => current?.[part], messages);
  if (typeof value !== "string") throw new Error(`Missing locale key: ${key}`);
  return value.replace("{{revision}}", String(params.revision));
}

describe("workflow chat context localization", () => {
  it.each(locales)("formats the current workflow in %s", (_locale, messages, expectedText) => {
    const summary = { id: "workflow-1", revision: 12, nodes: [{ id: "start" }] };
    const context = formatWorkflowChatContext(summary, (key, params) =>
      translateFrom(messages, key, params),
    );

    expect(context).toContain(expectedText);
    expect(context).toContain("r12");
    expect(context).toContain(JSON.stringify(summary, null, 2));
  });

  it("returns empty context for an invalid event payload", () => {
    expect(formatWorkflowChatContext(null, () => "unused")).toBe("");
    expect(formatWorkflowChatContext({}, null)).toBe("");
  });
});
