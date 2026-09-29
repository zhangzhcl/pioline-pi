// ABOUTME: Starts the native, user-selected Pipline diagnostic log export.

export function setupLogExport({ buttonEl, invoke, notify, t } = {}) {
  if (!buttonEl) return;
  if (typeof invoke !== "function") {
    buttonEl.hidden = true;
    return;
  }

  buttonEl.hidden = false;
  buttonEl.addEventListener("click", async () => {
    if (buttonEl.disabled) return;
    buttonEl.disabled = true;
    buttonEl.setAttribute("aria-busy", "true");
    try {
      const exportedFileCount = await invoke("export_app_logs");
      if (exportedFileCount == null) return;
      notify?.({
        type: "success",
        title: t("status.saved"),
        message: t("settings.exportLogsSuccess"),
      });
    } catch (error) {
      notify?.({
        type: "error",
        title: t("settings.exportLogsFailed"),
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      buttonEl.disabled = false;
      buttonEl.removeAttribute("aria-busy");
    }
  });
}
