import { describe, expect, it, vi } from "vitest";
import { createWorkflowExtensionDialogHandler } from "./workflow-extension-dialog.js";

const MARKER = "__PIPLINE_WORKFLOW_TOOL_V1__";

describe("workflow extension dialog routing", () => {
  it("routes Pi workflow input into the workflow handler and returns its result", async () => {
    const handleWorkflowRequest = vi
      .fn()
      .mockResolvedValue({ ok: true, applied: true, revision: 7 });
    const showNativeDialog = vi.fn();
    const handler = createWorkflowExtensionDialogHandler({
      handleWorkflowRequest,
      showNativeDialog,
    });
    const dismissSignal = Promise.resolve();
    const request = {
      method: "input",
      title: "Pipline workflow bridge",
      placeholder: `${MARKER}{"operation":"propose","baseRevision":6}`,
    };

    const result = await handler(request, { dismissSignal });

    expect(handleWorkflowRequest).toHaveBeenCalledWith(
      { operation: "propose", baseRevision: 6 },
      { dismissSignal },
    );
    expect(result).toEqual({
      value: JSON.stringify({ ok: true, applied: true, revision: 7 }),
    });
    expect(showNativeDialog).not.toHaveBeenCalled();
  });

  it("keeps unrelated extension inputs on the native dialog path", async () => {
    const showNativeDialog = vi.fn().mockResolvedValue({ value: "user input" });
    const handler = createWorkflowExtensionDialogHandler({
      handleWorkflowRequest: vi.fn(),
      showNativeDialog,
    });
    const request = { method: "input", title: "Extension question" };
    const options = { dismissSignal: Promise.resolve() };

    await expect(handler(request, options)).resolves.toEqual({ value: "user input" });
    expect(showNativeDialog).toHaveBeenCalledWith(request, undefined, options);
  });

  it("returns a structured error to Pi when the workflow request payload is invalid", async () => {
    const handleWorkflowRequest = vi.fn();
    const showNativeDialog = vi.fn();
    const handler = createWorkflowExtensionDialogHandler({
      handleWorkflowRequest,
      showNativeDialog,
    });

    const result = await handler({
      method: "input",
      title: "Pipline workflow bridge",
      placeholder: `${MARKER}{broken`,
    });

    expect(JSON.parse(result.value)).toMatchObject({ ok: false });
    expect(handleWorkflowRequest).not.toHaveBeenCalled();
    expect(showNativeDialog).not.toHaveBeenCalled();
  });
});
