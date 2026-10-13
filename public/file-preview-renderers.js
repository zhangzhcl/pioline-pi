/**
 * File preview renderer factory.
 *
 * Creates the appropriate renderer based on file classification.
 * Each renderer follows the interface: mount(container), update(props), destroy().
 * Text/code renderers expose getValue() for dirty-state extraction.
 */

import { createCodeEditor } from "./code-editor.js";
import { classifyFilePath } from "./file-language.js";
import { createPdfRenderer } from "./file-pdf-preview.js";
import { createHtmlRenderer } from "./file-preview-html.js";
import { attachCopyButtonDelegation, renderFileMarkdown } from "./file-preview-markdown.js";
import { flattenDiffLines } from "./workspace/patch-utils.js";

export function createFileRenderer({
  filePath,
  fileName,
  content,
  mode = "preview",
  readOnly = true,
  wrapLines = false,
  onChange,
  onModeChange,
  onError,
  rawUrlForPath,
  gitDiff,
} = {}) {
  // If a diff is requested and available, return diff renderer
  if (mode === "diff" && gitDiff) {
    return createDiffRenderer({ patch: gitDiff.patch || "" });
  }
  const classification = classifyFilePath(filePath || "");

  switch (classification.contentType) {
    case "markdown":
      return createMarkdownRenderer({
        filePath,
        content,
        mode,
        readOnly,
        wrapLines,
        onChange,
        onModeChange,
        onError,
      });

    case "html":
      return createHtmlRenderer({
        filePath,
        fileName,
        content,
        mode,
        wrapLines,
        onChange,
        onModeChange,
        onError,
      });

    case "convertible":
      return createMarkdownRenderer({
        filePath,
        content,
        mode: "preview",
        readOnly: true,
        onError,
        convertedDocument: true,
      });

    case "image":
      return createImageRenderer({ filePath, fileName, rawUrlForPath });

    case "pdf":
      return createPdfRenderer({ filePath, onError, rawUrlForPath });

    default:
      return createTextRenderer({
        filePath,
        content,
        readOnly: classification.contentType === "text" ? readOnly : true,
        wrapLines,
        onChange,
        onError,
      });
  }
}

// ─── Markdown renderer ──────────────────────────────────────────────────

function createMarkdownRenderer({
  filePath,
  content,
  mode = "preview",
  wrapLines = false,
  onChange,
  onModeChange,
  onError,
  convertedDocument = false,
}) {
  let editor = null;
  let cleanupCopy = null;
  let mountedContainer = null;
  let currentMode = mode;
  let currentContent = content || "";
  let currentWrap = wrapLines;

  function teardownCurrent({ syncEditorContent = false } = {}) {
    cleanupCopy?.();
    cleanupCopy = null;
    if (editor) {
      if (syncEditorContent) currentContent = editor.getValue();
      editor.destroy();
      editor = null;
    }
  }

  return {
    mount(container) {
      mountedContainer = container;
      renderCurrent(container);
    },
    update(props) {
      const modeChanged = props.mode !== undefined && props.mode !== currentMode;
      if (props.mode !== undefined) currentMode = props.mode;
      if (props.content !== undefined) currentContent = props.content;
      if (props.wrapLines !== undefined) currentWrap = props.wrapLines;

      if (modeChanged && mountedContainer) {
        teardownCurrent({ syncEditorContent: true });
        renderCurrent(mountedContainer);
      }
    },

    destroy() {
      teardownCurrent();
      mountedContainer = null;
    },

    getValue() {
      if (editor) return editor.getValue();
      return currentContent;
    },

    getMode() {
      return currentMode;
    },

    setMode(newMode, container) {
      if (convertedDocument || currentMode === newMode) return;
      currentMode = newMode;
      teardownCurrent({ syncEditorContent: true });
      renderCurrent(container);
      if (typeof onModeChange === "function") {
        onModeChange(newMode);
      }
    },

    openSearch() {
      editor?.openSearch();
    },

    goToLine(lineNumber) {
      return editor?.goToLine(lineNumber) ?? false;
    },

    setWrapLines(enabled) {
      currentWrap = enabled;
      editor?.setWrapLines(enabled);
    },

    get contentType() {
      return "markdown";
    },
  };

  function renderCurrent(container) {
    if (!container) return;

    if (currentMode === "preview") {
      container.replaceChildren();
      const frag = renderFileMarkdown(currentContent, { convertedDocument });
      const mdDiv = document.createElement("div");
      mdDiv.className = "file-markdown-preview";
      mdDiv.appendChild(frag);
      container.appendChild(mdDiv);
      cleanupCopy = attachCopyButtonDelegation(mdDiv);
    } else {
      // Edit mode: use CodeMirror.
      container.replaceChildren();
      const editorDiv = document.createElement("div");
      editorDiv.className = "file-code-editor";
      container.appendChild(editorDiv);

      editor = createCodeEditor({
        container: editorDiv,
        value: currentContent,
        filePath,
        readOnly: false,
        wrapLines: currentWrap,
        onChange: (val) => {
          currentContent = val;
          if (typeof onChange === "function") onChange(val);
        },
        onError,
      });
    }
  }
}

// ─── Text/code renderer ─────────────────────────────────────────────────

function createTextRenderer({
  filePath,
  content,
  readOnly = true,
  wrapLines = false,
  onChange,
  onError,
}) {
  let editor = null;
  let currentReadOnly = readOnly;
  let currentWrap = wrapLines;

  return {
    mount(container) {
      container.replaceChildren();
      const editorDiv = document.createElement("div");
      editorDiv.className = "file-code-editor";
      container.appendChild(editorDiv);

      editor = createCodeEditor({
        container: editorDiv,
        value: content || "",
        filePath,
        readOnly: currentReadOnly,
        wrapLines: currentWrap,
        onChange,
        onError,
      });
    },

    update(props) {
      if (props.readOnly !== undefined && props.readOnly !== currentReadOnly) {
        currentReadOnly = props.readOnly;
        if (editor) editor.setReadOnly(currentReadOnly);
      }
      if (props.wrapLines !== undefined && props.wrapLines !== currentWrap) {
        currentWrap = props.wrapLines;
        if (editor) editor.setWrapLines(currentWrap);
      }
    },

    destroy() {
      if (editor) {
        editor.destroy();
        editor = null;
      }
    },

    getValue() {
      if (editor) return editor.getValue();
      return content || "";
    },

    getEditor() {
      return editor;
    },

    openSearch() {
      editor?.openSearch();
    },

    goToLine(lineNumber) {
      return editor?.goToLine(lineNumber) ?? false;
    },

    setWrapLines(enabled) {
      currentWrap = enabled;
      editor?.setWrapLines(enabled);
    },

    get contentType() {
      return "text";
    },
  };
}

// ─── Image renderer ─────────────────────────────────────────────────────

function createImageRenderer({ filePath, fileName, rawUrlForPath }) {
  let imgEl = null;
  let containerEl = null;

  return {
    mount(container) {
      container.replaceChildren();
      containerEl = document.createElement("div");
      containerEl.className = "file-image-preview";

      imgEl = document.createElement("img");
      imgEl.className = "file-image-img";
      imgEl.alt = fileName || filePath || "";
      imgEl.src =
        typeof rawUrlForPath === "function"
          ? rawUrlForPath(filePath)
          : `/api/files/raw?path=${encodeURIComponent(filePath)}`;
      imgEl.onerror = () => {
        if (containerEl) {
          containerEl.classList.add("file-image-error");
        }
      };

      containerEl.appendChild(imgEl);
      container.appendChild(containerEl);
    },

    update() {
      // Images have no props to update.
    },

    destroy() {
      if (imgEl) {
        imgEl.src = "";
        imgEl = null;
      }
      if (containerEl?.parentNode) {
        containerEl.parentNode.removeChild(containerEl);
      }
      containerEl = null;
    },

    get contentType() {
      return "image";
    },
  };
}

// ─── Diff renderer ───────────────────────────────────────────────────────────

const CONTEXT_LINES = 3;

/**
 * Render a unified diff patch as an inline colour-coded diff.
 * Exposes the same mount/update/destroy interface as the other renderers.
 */
function createDiffRenderer({ patch = "" } = {}) {
  let containerEl = null;

  function renderDiff(container) {
    container.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "file-diff-view";
    container.appendChild(wrap);

    const lines = patch?.trim() ? flattenDiffLines(patch) : [];
    const hasChanges = lines.some((l) => l.type !== "unchanged");
    if (!hasChanges) {
      const empty = document.createElement("div");
      empty.className = "file-diff-empty";
      empty.textContent = "No changes";
      wrap.appendChild(empty);
      return;
    }

    // Determine which line indices are visible (changed ± CONTEXT_LINES)
    const changed = new Set();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].type !== "unchanged") changed.add(i);
    }
    const visible = new Set();
    for (const ci of changed) {
      for (
        let j = Math.max(0, ci - CONTEXT_LINES);
        j <= Math.min(lines.length - 1, ci + CONTEXT_LINES);
        j++
      ) {
        visible.add(j);
      }
    }

    let i = 0;
    while (i < lines.length) {
      if (visible.has(i)) {
        // Emit a block of visible lines
        while (i < lines.length && visible.has(i)) {
          wrap.appendChild(makeDiffLineEl(lines[i]));
          i++;
        }
      } else {
        // Count collapsed lines
        let count = 0;
        while (i < lines.length && !visible.has(i)) {
          count++;
          i++;
        }
        const collapseEl = document.createElement("div");
        collapseEl.className = "file-diff-collapse";
        collapseEl.textContent = `\u2026 ${count} unchanged line${count !== 1 ? "s" : ""} \u2026`;
        wrap.appendChild(collapseEl);
      }
    }
  }

  function makeDiffLineEl(line) {
    const row = document.createElement("div");
    let cls = "file-diff-line";
    if (line.type === "added") cls += " file-diff-line--added";
    else if (line.type === "removed") cls += " file-diff-line--removed";
    row.className = cls;

    const gutter = document.createElement("span");
    gutter.className = "file-diff-gutter";
    gutter.textContent =
      line.type === "removed" ? String(line.oldLineNo ?? "") : String(line.newLineNo ?? "");

    const sign = document.createElement("span");
    sign.className = "file-diff-sign";
    sign.setAttribute("aria-hidden", "true");
    sign.textContent = line.type === "added" ? "+" : line.type === "removed" ? "\u2212" : " ";

    const content = document.createElement("span");
    content.className = "file-diff-content";
    content.textContent = line.text || "\u00a0";

    row.appendChild(gutter);
    row.appendChild(sign);
    row.appendChild(content);
    return row;
  }

  return {
    mount(container) {
      containerEl = container;
      renderDiff(container);
    },

    update({ patch: newPatch } = {}) {
      if (newPatch !== undefined) patch = newPatch;
      if (containerEl) renderDiff(containerEl);
    },

    destroy() {
      if (containerEl) containerEl.replaceChildren();
      containerEl = null;
    },

    get contentType() {
      return "diff";
    },
  };
}
