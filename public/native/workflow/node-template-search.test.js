import { describe, expect, it, vi } from "vitest";

vi.mock("../../i18n.js", () => ({ getLocale: () => "zh", t: (key) => key }));

import { BUILTIN_NODE_METAS } from "./builtin-node-registry.js";
import { searchNodeTemplateMetas } from "./node-template-search.js";

describe("workflow node template catalog search", () => {
  it("offers Condition v2 and hides the legacy v1 template", () => {
    const result = searchNodeTemplateMetas(BUILTIN_NODE_METAS, "condition");

    expect(result.matches.map((meta) => `${meta.id}@${meta.version}`)).toContain(
      "pipline.condition@2.0.0",
    );
    expect(result.matches.map((meta) => `${meta.id}@${meta.version}`)).not.toContain(
      "pipline.condition@1.0.0",
    );
  });
});
