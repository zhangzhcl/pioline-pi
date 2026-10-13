// ABOUTME: DOM builders, diff rendering, and argument/result formatters for ToolCardRenderer.

import { t } from "../i18n.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export function filePathFromArgs(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["path", "file_path", "filePath"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function createChevronDom(expanded = false) {
  const chevron = document.createElement("span");
  chevron.className = `tool-card-chevron${expanded ? " expanded" : ""}`;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "8");
  svg.setAttribute("height", "8");
  svg.setAttribute("viewBox", "0 0 8 8");
  svg.setAttribute("fill", "currentColor");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M2 1l4 3-4 3z");
  svg.appendChild(path);
  chevron.appendChild(svg);
  return chevron;
}

export function createCopyButtonDom() {
  const copyButton = document.createElement("button");
  copyButton.className = "tool-action-btn copy-output-btn";
  const label = t("tools.copyOutput");
  copyButton.title = label;
  copyButton.setAttribute("aria-label", label);

  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of [
    ["width", "13"],
    ["height", "13"],
    ["viewBox", "0 0 24 24"],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "2"],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
  ]) {
    svg.setAttribute(name, value);
  }
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("width", "14");
  rect.setAttribute("height", "14");
  rect.setAttribute("x", "8");
  rect.setAttribute("y", "8");
  rect.setAttribute("rx", "2");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2");
  svg.append(rect, path);
  copyButton.appendChild(svg);
  return copyButton;
}

export function getToolArgsPreview(_toolName, args) {
  if (!args || Object.keys(args).length === 0) return "";

  const filePath = filePathFromArgs(args);
  if (filePath) return filePath;

  if (args.command) return args.command.substring(0, 80);
  if (args.query) return args.query.substring(0, 60);
  if (args.url) return args.url;

  for (const val of Object.values(args)) {
    if (typeof val === "string" && val.length > 0) {
      return val.substring(0, 60);
    }
  }
  return "";
}

export function createArgsPreviewDom(previewText, args) {
  const filePath = filePathFromArgs(args);
  if (filePath) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tool-args-preview tool-file-ref";
    button.dataset.path = filePath;
    button.textContent = previewText;
    const label = t("tools.openInPreview");
    button.title = label;
    button.setAttribute("aria-label", `${label}: ${filePath}`);
    return button;
  }
  const preview = document.createElement("span");
  preview.className = "tool-args-preview";
  preview.textContent = previewText;
  return preview;
}

export function formatToolArgsJson(obj) {
  try {
    if (Object.keys(obj).length === 0) return "";
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

export function renderToolEditDiff(oldText, newText) {
  const container = document.createElement("div");
  container.className = "tool-diff";

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  for (const line of oldLines) {
    const el = document.createElement("div");
    el.className = "diff-line diff-removed";
    el.textContent = `- ${line}`;
    container.appendChild(el);
  }

  for (const line of newLines) {
    const el = document.createElement("div");
    el.className = "diff-line diff-added";
    el.textContent = `+ ${line}`;
    container.appendChild(el);
  }

  return container;
}

export function formatToolResultText(result) {
  if (!result) return "";

  if (result.content && Array.isArray(result.content)) {
    return result.content
      .filter(Boolean)
      .map((block) => {
        if (block.type === "text") return block.text;
        return JSON.stringify(block);
      })
      .join("\n");
  }

  return JSON.stringify(result, null, 2);
}
