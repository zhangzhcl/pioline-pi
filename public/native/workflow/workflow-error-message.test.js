import { beforeEach, describe, expect, it, vi } from "vitest";

const { translate } = vi.hoisted(() => ({ translate: vi.fn((key) => key) }));
vi.mock("../../i18n.js", () => ({ t: translate }));

import { workflowErrorMessage } from "./workflow-error-message.js";

describe("localized Start input validation errors", () => {
  beforeEach(() => translate.mockClear());

  it("localizes missing top-level required fields", () => {
    expect(
      workflowErrorMessage(new Error("Workflow input is missing required field: profile")),
    ).toBe("workflow.errors.startInputMissing");
    expect(translate).toHaveBeenCalledWith("workflow.errors.startInputMissing", {
      field: "profile",
    });
  });

  it("localizes nested required fields", () => {
    workflowErrorMessage(
      new Error("Workflow input field profile is missing required field preferences"),
    );
    expect(translate).toHaveBeenCalledWith("workflow.errors.startInputNestedMissing", {
      parent: "profile",
      field: "preferences",
    });
  });

  it("localizes nested type and array item errors", () => {
    workflowErrorMessage(new Error("Workflow input field profile.tags[1] must be string"));
    expect(translate).toHaveBeenNthCalledWith(1, "workflow.inputTypes.string");
    expect(translate).toHaveBeenNthCalledWith(2, "workflow.errors.startInputType", {
      field: "profile.tags[1]",
      type: "workflow.inputTypes.string",
    });
  });

  it("localizes invalid, unsupported, and oversized Start schemas", () => {
    expect(workflowErrorMessage(new Error("Start inputSchema.properties must be an object"))).toBe(
      "workflow.errors.startSchemaInvalid",
    );
    expect(
      workflowErrorMessage(
        new Error("Start inputSchema field request contains unsupported schema fields"),
      ),
    ).toBe("workflow.errors.startSchemaUnsupported");
    expect(
      workflowErrorMessage(new Error("Start inputSchema exceeds the maximum total field count")),
    ).toBe("workflow.errors.startSchemaLimit");
    expect(translate).toHaveBeenNthCalledWith(1, "workflow.errors.startSchemaInvalid");
    expect(translate).toHaveBeenNthCalledWith(2, "workflow.errors.startSchemaUnsupported");
    expect(translate).toHaveBeenNthCalledWith(3, "workflow.errors.startSchemaLimit");
  });

  it("localizes Start schema errors wrapped by workflow command validation", () => {
    expect(
      workflowErrorMessage(
        new Error(
          "Workflow command produced invalid state: Start inputSchema.properties must be an object",
        ),
      ),
    ).toBe("workflow.errors.startSchemaInvalid");
  });

  it("localizes stale and mismatched Run snapshot errors from the Host", () => {
    expect(
      workflowErrorMessage(new Error("Workflow changed after this Run snapshot was prepared")),
    ).toBe("workflow.errors.runStaleRevision");
    expect(
      workflowErrorMessage(new Error("Run snapshot does not match the saved workflow revision")),
    ).toBe("workflow.errors.runSnapshotMismatch");
  });

  it("explains that nodes without trusted executors cannot run yet", () => {
    expect(
      workflowErrorMessage(new Error("No trusted executor is registered for: Generated step")),
    ).toBe("workflow.executorUnavailable");
    expect(translate).toHaveBeenCalledWith("workflow.executorUnavailable", {
      nodes: "Generated step",
    });
  });
});
