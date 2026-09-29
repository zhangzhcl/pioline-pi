import { describe, expect, it } from "vitest";
import { shouldBlockWorkflowWindowNavigation } from "./workflow-window-navigation.js";

describe("workflow window navigation", () => {
  it.each(["queued", "running"])("blocks navigation during a %s run", (runStatus) => {
    expect(
      shouldBlockWorkflowWindowNavigation({
        currentWorkflowId: "one",
        nextWorkflowId: "two",
        runStatus,
      }),
    ).toBe(true);
  });

  it("blocks navigation while run cleanup is still in flight", () => {
    expect(
      shouldBlockWorkflowWindowNavigation({
        currentWorkflowId: "one",
        nextWorkflowId: "two",
        runStatus: "success",
        runInFlight: true,
      }),
    ).toBe(true);
  });

  it("allows navigation after a run settles and for the current workflow", () => {
    expect(
      shouldBlockWorkflowWindowNavigation({
        currentWorkflowId: "one",
        nextWorkflowId: "two",
        runStatus: "success",
      }),
    ).toBe(false);
    expect(
      shouldBlockWorkflowWindowNavigation({
        currentWorkflowId: "one",
        nextWorkflowId: "one",
        runStatus: "running",
      }),
    ).toBe(false);
  });
});
