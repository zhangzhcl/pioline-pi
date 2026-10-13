// 包管理器视图构建与纯格式化工具。

import { t } from "../../i18n.js";

export const RESOURCE_GROUPS = [
  ["extensions", "extensions"],
  ["skills", "skills"],
  ["prompts", "prompts"],
  ["themes", "themes"],
];

export function sourceOf(pkg) {
  return typeof pkg?.source === "string" ? pkg.source : "";
}

export function keyOf(pkg) {
  return `${pkg.scope}\0${pkg.source}`;
}

// Normalize a user-typed install source: trim whitespace and unwrap a pasted
// `pi install ...` command so any of `npm:foo`, `pi install npm:foo`, or
// `npm install @scope/pkg` style inputs work.
export function normalizeSource(raw) {
  let value = String(raw || "").trim();
  const installMatch = value.match(/(?:^|\s)(?:pi|npm)\s+install\s+(.+)$/i);
  if (installMatch) {
    value = installMatch[1]
      .split(/\s+/)
      .filter((part) => part && !part.startsWith("-"))
      .join(" ");
  }
  return value.trim();
}

export function shortenPath(path) {
  if (!path) return "";
  return String(path).replace(/^\/?(Users|home)\/[^/]+/, "~");
}

export function statusColor(status) {
  if (status === "loaded") return "var(--accent)";
  if (status === "installed") return "#f59e0b";
  if (status === "disabled") return "var(--text-secondary)";
  return "#ef4444";
}

export function statusLabel(status) {
  return status || "unknown";
}

export function installedPathLabel(pkg) {
  return pkg?.installedPath ? shortenPath(pkg.installedPath) : t("extensions.notOnDisk");
}

export function resourceSummary(pkg) {
  const parts = RESOURCE_GROUPS.map(([key, label]) => {
    const count = pkg?.counts?.[key] ?? 0;
    return count > 0 ? t("extensions.resourceCount", { count, label }) : "";
  }).filter(Boolean);
  return parts.length ? parts.join(" · ") : t("extensions.noResources");
}

export function scopeLabel(scope) {
  return scope === "project" ? t("extensions.scopeProject") : t("extensions.scopeGlobal");
}

export function iconButton(label, { danger = false, disabled = false, title = "" } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "settings-value-btn pkg-manager-btn";
  if (danger) btn.classList.add("is-danger");
  btn.disabled = disabled;
  btn.textContent = label;
  if (title) btn.title = title;
  return btn;
}

export function makeToggle({ enabled, loading, onToggle, label }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pkg-manager-toggle";
  btn.setAttribute("role", "switch");
  btn.setAttribute("aria-checked", String(enabled));
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.addEventListener("click", onToggle);
  const knob = document.createElement("span");
  knob.className = "pkg-manager-toggle-knob";
  btn.appendChild(knob);
  updateToggle(btn, enabled, loading);
  return btn;
}

export function updateToggle(btn, enabled, loading) {
  if (!btn) return;
  btn.classList.toggle("is-on", enabled);
  btn.classList.toggle("is-loading", Boolean(loading));
  btn.setAttribute("aria-checked", String(enabled));
  btn.disabled = Boolean(loading);
}

export function message(text, { isError = false } = {}) {
  const el = document.createElement("div");
  el.className = `pkg-manager-message${isError ? " is-error" : ""}`;
  el.textContent = text;
  return el;
}

export function statusRow(label, value) {
  const row = document.createElement("div");
  row.className = "pkg-manager-status-row";
  const labelEl = document.createElement("span");
  labelEl.className = "pkg-manager-status-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = "pkg-manager-status-value";
  valueEl.textContent = value;
  row.append(labelEl, valueEl);
  return row;
}

export function emptyNote(text) {
  const el = document.createElement("div");
  el.className = "settings-api-keys-empty";
  el.textContent = text;
  return el;
}

export function noticeNote(text, isError = false) {
  const el = document.createElement("div");
  el.className = `pkg-manager-notice${isError ? " pkg-manager-notice-error" : ""}`;
  el.textContent = text;
  return el;
}

export function updateBadge() {
  const badge = document.createElement("span");
  badge.className = "pkg-manager-update-badge";
  badge.textContent = t("extensions.updateAvailable");
  badge.title = t("extensions.updateAvailable");
  badge.setAttribute("role", "status");
  return badge;
}

export function renderPackageDetailView({
  detailEl,
  pkg,
  busyScope,
  canManage,
  updatingAll,
  cwd,
  onToggle,
  onUpdate,
  onRemove,
}) {
  if (!detailEl) return;
  detailEl.innerHTML = "";
  if (!pkg) return;
  const key = keyOf(pkg);
  const busy = busyScope === key;

  const header = document.createElement("div");
  header.className = "pkg-manager-detail-header";
  const toggle = makeToggle({
    enabled: !pkg.disabled,
    loading: busy,
    label: pkg.disabled ? t("extensions.enablePackage") : t("extensions.disablePackage"),
    onToggle: () => onToggle(pkg, key),
  });
  header.appendChild(toggle);

  const scopeTag = document.createElement("span");
  scopeTag.className = "pkg-manager-scope";
  scopeTag.textContent = scopeLabel(pkg.scope);
  header.appendChild(scopeTag);

  const sourceEl = document.createElement("span");
  sourceEl.className = "pkg-manager-source";
  sourceEl.textContent = pkg.source;
  sourceEl.title = pkg.source;
  header.appendChild(sourceEl);
  if (pkg.updateAvailable === true) {
    header.appendChild(updateBadge());
  }
  detailEl.appendChild(header);

  const actions = document.createElement("div");
  actions.className = "settings-extension-actions pkg-manager-actions";

  const updateBtn = iconButton(t("extensions.update"), {
    disabled: busy || !canManage || pkg.updateAvailable !== true || updatingAll,
    title: t("extensions.updateTip"),
  });
  updateBtn.addEventListener("click", () => onUpdate(pkg, key));
  actions.appendChild(updateBtn);

  const removeBtn = iconButton(t("extensions.remove"), {
    danger: true,
    disabled: busy || !canManage,
    title: t("extensions.removeTip"),
  });
  removeBtn.addEventListener("click", () => onRemove(pkg, key));
  actions.appendChild(removeBtn);
  detailEl.appendChild(actions);

  const statusGrid = document.createElement("div");
  statusGrid.className = "pkg-manager-status-grid";
  statusGrid.appendChild(statusRow(t("extensions.status"), statusLabel(pkg.status)));
  if (pkg.version) statusGrid.appendChild(statusRow(t("extensions.version"), pkg.version));
  if (pkg.packageName) statusGrid.appendChild(statusRow(t("extensions.package"), pkg.packageName));
  if (pkg.description)
    statusGrid.appendChild(statusRow(t("extensions.description"), pkg.description));
  statusGrid.appendChild(statusRow(t("extensions.resources"), resourceSummary(pkg)));
  statusGrid.appendChild(statusRow(t("extensions.installPath"), installedPathLabel(pkg)));
  if (cwd) statusGrid.appendChild(statusRow(t("extensions.cwd"), cwd));
  detailEl.appendChild(statusGrid);

  const resolvedTitle = document.createElement("div");
  resolvedTitle.className = "settings-section-title settings-section-title-small";
  resolvedTitle.textContent = t("extensions.resolvedResources");
  detailEl.appendChild(resolvedTitle);

  const resourceList = document.createElement("div");
  resourceList.className = "pkg-manager-resource-list";
  if (!pkg.resources.length) {
    resourceList.appendChild(emptyNote(t("extensions.noResources")));
  } else {
    for (const entry of pkg.resources) {
      const row = document.createElement("div");
      row.className = "pkg-manager-resource-row";
      const name = document.createElement("span");
      name.className = "pkg-manager-resource-name";
      name.textContent = entry.name;
      const path = document.createElement("span");
      path.className = "pkg-manager-resource-path";
      path.textContent = entry.relativePath;
      row.append(name, path);
      resourceList.appendChild(row);
    }
  }
  detailEl.appendChild(resourceList);
}
