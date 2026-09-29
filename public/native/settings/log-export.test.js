import { afterEach, describe, expect, it, vi } from "vitest";
import { setupLogExport } from "./log-export.js";

function createHarness(invoke) {
  const buttonEl = document.createElement("button");
  const notify = vi.fn();
  const t = (key) => key;
  setupLogExport({ buttonEl, invoke, notify, t });
  return { buttonEl, notify };
}

describe("Pipline diagnostic log export", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("exports through the native command and reports success", async () => {
    const invoke = vi.fn(async () => 3);
    const { buttonEl, notify } = createHarness(invoke);
    document.body.append(buttonEl);

    buttonEl.click();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());

    expect(invoke).toHaveBeenCalledWith("export_app_logs");
    expect(notify).toHaveBeenCalledWith({
      type: "success",
      title: "status.saved",
      message: "settings.exportLogsSuccess",
    });
  });

  it("does not show a message when the user cancels the save dialog", async () => {
    const invoke = vi.fn(async () => null);
    const { buttonEl, notify } = createHarness(invoke);

    buttonEl.click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());

    expect(notify).not.toHaveBeenCalled();
  });

  it("shows a localized error when export fails", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const { buttonEl, notify } = createHarness(invoke);

    buttonEl.click();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());

    expect(notify).toHaveBeenCalledWith({
      type: "error",
      title: "settings.exportLogsFailed",
      message: "permission denied",
    });
  });

  it("disables the export button until the native export completes", async () => {
    let finishExport;
    const invoke = vi.fn(
      () =>
        new Promise((resolve) => {
          finishExport = resolve;
        }),
    );
    const { buttonEl } = createHarness(invoke);

    buttonEl.click();
    expect(buttonEl.disabled).toBe(true);
    finishExport(null);
    await vi.waitFor(() => expect(buttonEl.disabled).toBe(false));
  });
});
