import { beforeEach, describe, expect, it, vi } from "vitest";

const { translate } = vi.hoisted(() => ({ translate: vi.fn((key) => key) }));
vi.mock("../../i18n.js", () => ({ getLocale: () => "zh", t: translate }));

import { BUILTIN_NODE_METAS } from "./builtin-node-registry.js";
import { localizeNodeMeta } from "./node-meta-localization.js";

describe("built-in node metadata localization", () => {
  beforeEach(() => translate.mockClear());

  it("localizes the Start input schema help text", () => {
    const start = BUILTIN_NODE_METAS.get("pipline.start@1.0.0");
    const localized = localizeNodeMeta(start);
    const schemaParam = localized.params.find((param) => param.name === "inputSchema");

    expect(schemaParam.description).toBe("workflow.nodeParamDescriptions.startInputSchema");
    expect(translate).toHaveBeenCalledWith("workflow.nodeParamDescriptions.startInputSchema");
    expect(schemaParam.description).not.toContain("Supported types");
  });

  it("localizes the Pi Agent prompt help text for both supported versions", () => {
    for (const version of ["1.0.0", "2.0.0"]) {
      const meta = BUILTIN_NODE_METAS.get(`pipline.pi-agent@${version}`);
      const localized = localizeNodeMeta(meta);
      const prompt = localized.params.find((param) => param.name === "prompt");

      expect(prompt.description).toBe("workflow.nodeParamDescriptions.piAgentPrompt");
    }
    expect(translate).toHaveBeenCalledWith("workflow.nodeParamDescriptions.piAgentPrompt");
  });

  it("localizes the Extract v2 array path description and parameter label", () => {
    const extract = BUILTIN_NODE_METAS.get("pipline.extract@2.0.0");
    const localized = localizeNodeMeta(extract);

    expect(localized.description).toBe("workflow.nodeDescriptions.extractStructured");
    expect(localized.params.find((param) => param.name === "path").label).toBe(
      "workflow.nodeFields.jsonPath",
    );
    expect(translate).toHaveBeenCalledWith("workflow.nodeDescriptions.extractStructured");
    expect(translate).toHaveBeenCalledWith("workflow.nodeFields.jsonPath");
  });

  it("localizes the Condition v2 comparison path help", () => {
    const condition = BUILTIN_NODE_METAS.get("pipline.condition@2.0.0");
    const localized = localizeNodeMeta(condition);

    expect(localized.params.find((param) => param.name === "path").description).toBe(
      "workflow.nodeParamDescriptions.conditionPath",
    );
    expect(translate).toHaveBeenCalledWith("workflow.nodeParamDescriptions.conditionPath");
  });
});
