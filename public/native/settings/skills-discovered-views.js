// ABOUTME: Tree traversal helpers and DOM row builders for the Discovered Skills tab.

import { t } from "../../i18n.js";

export function expectedScopeFor(scope) {
  return scope === "global" ? "user" : "project";
}

export function flatLeaves(node) {
  const out = [];
  for (const c of node.children ?? []) {
    if (c.kind === "skill") out.push(c);
    else out.push(...flatLeaves(c));
  }
  return out;
}

export function countGroups(node) {
  let n = 0;
  for (const c of node.children ?? []) {
    if (c.kind === "group") n += 1 + countGroups(c);
  }
  return n;
}

export function rootsForScope(inventory, scope) {
  const want = expectedScopeFor(scope);
  return (inventory?.roots ?? []).filter((r) => r.scope === want);
}

export function countItems(inventory, scope) {
  return rootsForScope(inventory, scope).reduce((n, r) => n + flatLeaves(r).length, 0);
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") {
      for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = dv;
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "aria") {
      for (const [ak, av] of Object.entries(value)) node.setAttribute(`aria-${ak}`, av);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function renderSkillSwitch(checked, disabled, indeterminate, ariaLabel, onChange) {
  const button = el("button", {
    type: "button",
    class: `settings-toggle skills-switch${indeterminate ? " mixed" : ""}`,
    "aria-checked": String(Boolean(checked)),
    "aria-label": ariaLabel,
    role: "switch",
  });
  if (checked) button.classList.add("on");
  if (indeterminate) button.dataset.mixed = "true";
  if (disabled) button.disabled = true;
  button.addEventListener("click", () => {
    if (button.disabled) return;
    onChange(!button.classList.contains("on"));
  });
  return button;
}

export function renderSkillStateBadge(state, enabled, total) {
  const label =
    state === "all-on"
      ? t("settings.skills.allEnabled")
      : state === "all-off"
        ? t("settings.skills.allDisabled")
        : t("settings.skills.enabledCount", { enabled, total });
  return el("span", {
    class: `skills-group-status ${state}`,
    text: label,
    dataset: { skillGroupState: state },
  });
}

export function renderSkillItemRow(item, { parentDisabled = false, pendingTargets, onSetEnabled }) {
  const shadowed = item.status === "shadowed";
  const rowDisabled = item.ambiguous || shadowed || pendingTargets.has(item.id) || parentDisabled;
  return el(
    "div",
    { class: "skills-skill-row", dataset: { skillRow: item.name, skillToggle: item.name } },
    [
      el("div", { class: "skills-skill-info" }, [
        el("div", { class: "skills-skill-name", text: item.name }),
        el("div", { class: "skills-skill-description", text: item.description }),
        shadowed && item.shadowedBy
          ? el("div", {
              class: "skills-shadowed-note",
              text: t("settings.skills.shadowedBy", { name: item.shadowedBy.name }),
            })
          : null,
      ]),
      renderSkillSwitch(
        item.status === "enabled",
        rowDisabled,
        false,
        `${t("settings.skills.enableSkill")}: ${item.name}`,
        (checked) => void onSetEnabled({ kind: "skill", id: item.id }, checked),
      ),
    ],
  );
}
