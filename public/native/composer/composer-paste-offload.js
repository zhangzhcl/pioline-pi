// ABOUTME: Offers an explicit file-offload action for large pasted composer text.
// ABOUTME: Replaces only confirmed paste ranges with workspace-local @-file references.

export const PASTE_OFFLOAD_BYTE_THRESHOLD = 4 * 1024;

const TEXT_ENCODER = new TextEncoder();

function utf8ByteLength(text) {
  return TEXT_ENCODER.encode(text).byteLength;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function pastedText(event) {
  return event.clipboardData?.getData("text/plain") || "";
}

/**
 * Add an explicit large-paste offload affordance to a textarea.
 * `offload(text)` resolves to a workspace-relative path.
 */
export function setupComposerPasteOffload({
  textarea,
  container,
  document: doc = globalThis.document,
  offload,
  t = (key) => key,
}) {
  if (!textarea || !container || typeof offload !== "function") {
    return { destroy() {}, dismiss() {}, isBusy: () => false };
  }

  let pending = null;
  let pasteCapture = null;
  let applyingReplacement = false;
  let busy = false;

  const prompt = doc.createElement("div");
  prompt.className = "paste-offload-prompt hidden";
  prompt.setAttribute("role", "status");
  const label = doc.createElement("span");
  label.className = "paste-offload-label";
  const asFileButton = doc.createElement("button");
  asFileButton.type = "button";
  asFileButton.className = "paste-offload-as-file";
  const keepInlineButton = doc.createElement("button");
  keepInlineButton.type = "button";
  keepInlineButton.className = "paste-offload-keep-inline";
  prompt.append(label, asFileButton, keepInlineButton);
  textarea.before(prompt);

  const dismiss = () => {
    pending = null;
    pasteCapture = null;
    prompt.classList.add("hidden");
    asFileButton.disabled = false;
    keepInlineButton.disabled = false;
  };

  const renderPending = () => {
    if (!pending) {
      prompt.classList.add("hidden");
      return;
    }
    label.textContent = t("input.pasteDetected", { size: formatSize(pending.bytes) });
    asFileButton.textContent = t("input.pasteAsFile");
    keepInlineButton.textContent = t("input.keepInline");
    prompt.classList.remove("hidden");
  };

  const onPaste = (event) => {
    const text = pastedText(event);
    if (!text) return;
    const bytes = utf8ByteLength(text);
    if (bytes < PASTE_OFFLOAD_BYTE_THRESHOLD) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    pasteCapture = { before: textarea.value, text, start, end, bytes };
  };

  const onInput = () => {
    if (applyingReplacement || busy) return;
    if (pasteCapture) {
      const { before, text, start, end, bytes } = pasteCapture;
      const expected = `${before.slice(0, start)}${text}${before.slice(end)}`;
      pasteCapture = null;
      if (textarea.value === expected) {
        pending = { text, start, end: start + text.length, bytes };
        renderPending();
        return;
      }
    }
    if (pending) dismiss();
  };

  const onKeepInline = () => dismiss();

  const onAsFile = async () => {
    if (!pending) return;
    const current = pending;
    if (textarea.value.slice(current.start, current.end) !== current.text) {
      dismiss();
      return;
    }
    busy = true;
    textarea.dataset.pasteOffloadBusy = "true";
    asFileButton.disabled = true;
    keepInlineButton.disabled = true;
    try {
      const relativePath = await offload(current.text);
      if (typeof relativePath !== "string" || !relativePath) throw new Error("Invalid paste path");
      if (textarea.value.slice(current.start, current.end) !== current.text) {
        busy = false;
        delete textarea.dataset.pasteOffloadBusy;
        dismiss();
        return;
      }
      applyingReplacement = true;
      const beforePaste = textarea.value[current.start - 1] || "";
      const afterPaste = textarea.value[current.end] || "";
      const prefix = beforePaste && beforePaste !== "\n" ? "\n" : "";
      const suffix = afterPaste && afterPaste !== "\n" ? "\n" : "";
      textarea.setRangeText(`@${relativePath}${suffix}`, current.start, current.end, "end");
      if (prefix) textarea.setRangeText(prefix, current.start, current.start, "end");
      applyingReplacement = false;
      busy = false;
      delete textarea.dataset.pasteOffloadBusy;
      dismiss();
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    } catch {
      applyingReplacement = false;
      busy = false;
      delete textarea.dataset.pasteOffloadBusy;
      asFileButton.disabled = false;
      keepInlineButton.disabled = false;
      label.textContent = t("input.pasteOffloadFailed");
    }
  };

  asFileButton.addEventListener("click", onAsFile);
  keepInlineButton.addEventListener("click", onKeepInline);
  textarea.addEventListener("paste", onPaste);
  textarea.addEventListener("input", onInput);

  return {
    dismiss,
    isBusy: () => busy,
    destroy() {
      busy = false;
      delete textarea.dataset.pasteOffloadBusy;
      dismiss();
      asFileButton.removeEventListener("click", onAsFile);
      keepInlineButton.removeEventListener("click", onKeepInline);
      textarea.removeEventListener("paste", onPaste);
      textarea.removeEventListener("input", onInput);
      prompt.remove();
    },
  };
}
