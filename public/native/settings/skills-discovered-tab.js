// ABOUTME: Renders the Discovered tab from the server-authoritative Pi skill inventory.
// ABOUTME: Owns Claude root enablement and existing skill toggle/tree behavior.

import { onLocaleChange, t } from "../../i18n.js";
import { createLoadingPlaceholder } from "../../ui/loading-placeholder.js";
import {
  countGroups,
  countItems,
  el,
  flatLeaves,
  renderSkillItemRow,
  renderSkillStateBadge,
  renderSkillSwitch,
  rootsForScope,
} from "./skills-discovered-views.js";
import { manageModalDialog } from "./skills-modal.js";

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.container
 * @param {(cmd:Object)=>Promise<Object>} opts.rpcCommand
 * @param {(msg:string)=>void} [opts.showSuccess]
 * @param {(msg:string)=>void} [opts.showError]
 */
export function setupDiscoveredSkillsTab({ container, rpcCommand, showSuccess, showError }) {
  let scope = "global";
  /** @type {SkillInventory|null} */
  let inventory = null;
  let hasActivated = false;
  /** @type {Record<string, number>} */
  const scopeCounts = {};
  // Groups start collapsed; a user expands one by adding its id here.
  const expandedGroups = new Set();
  const pendingTargets = new Set();
  let loadSeq = 0;
  let errorMessage = null;
  const unsubscribeLocale = onLocaleChange(() => render());

  function renderLoading() {
    container.replaceChildren(
      createLoadingPlaceholder({
        className: "skills-loading",
        label: t("settings.skills.loading"),
      }),
    );
  }

  function renderError(message) {
    errorMessage = message || t("settings.skills.loadFailed");
    container.replaceChildren(
      el("div", { class: "skills-error" }, [
        el("span", { text: errorMessage }),
        el("button", {
          type: "button",
          class: "ui-button ui-button--sm ui-button--secondary skills-rescan",
          text: t("settings.skills.rescan"),
          onClick: () => void load(scope),
        }),
      ]),
    );
  }

  async function load(nextScope = scope) {
    scope = nextScope;
    errorMessage = null;
    const seq = ++loadSeq;
    renderLoading();
    let response;
    try {
      response = await rpcCommand({ type: "list_skill_inventory", scope });
    } catch (e) {
      if (seq !== loadSeq) return;
      inventory = null;
      renderError(e instanceof Error ? e.message : t("settings.skills.loadFailed"));
      return;
    }
    if (seq !== loadSeq) return;
    if (!response?.success) {
      inventory = null;
      renderError(response?.error);
      return;
    }
    inventory = response.data;
    scopeCounts[scope] = countItems(inventory, scope);
    const other = scope === "global" ? "project" : "global";
    scopeCounts[other] = countItems(inventory, other);
    if (seq !== loadSeq) return;
    render();
  }

  async function activate() {
    if (hasActivated) return;
    hasActivated = true;
    await load(scope);
  }

  async function setEnabled(target, enabled) {
    const mutationScope = scope;
    const mutationSeq = loadSeq;
    pendingTargets.add(target.id);
    render();
    let response;
    try {
      response = await rpcCommand({ type: "set_skill_enabled", scope, target, enabled });
    } catch (e) {
      pendingTargets.delete(target.id);
      showError?.(e instanceof Error ? e.message : t("settings.skills.saveFailed"));
      render();
      return;
    }
    pendingTargets.delete(target.id);
    if (!response?.success) {
      showError?.(response?.error || t("settings.skills.saveFailed"));
      render();
      return;
    }
    if (scope !== mutationScope || loadSeq !== mutationSeq) {
      if (scope === mutationScope) void load(scope);
      return;
    }
    inventory = response.data.inventory;
    scopeCounts.global = countItems(inventory, "global");
    scopeCounts.project = countItems(inventory, "project");
    showSuccess?.(t("settings.skills.savedRestartRequired"));
    render();
  }

  function rescan() {
    void load(scope);
  }

  function renderScopeTabs() {
    const tabs = el("div", {
      class: "skills-scope-tabs",
      role: "group",
      aria: { label: t("settings.skills.title") },
    });
    for (const s of ["global", "project"]) {
      const count = scopeCounts[s];
      const active = s === scope;
      tabs.appendChild(
        el(
          "button",
          {
            type: "button",
            class: `skills-scope-tab${active ? " active" : ""}`,
            "aria-pressed": String(active),
            dataset: { scope: s },
            onClick: () => {
              if (s !== scope) void load(s);
            },
          },
          [
            t(`settings.skills.${s}`),
            count !== undefined ? el("small", { text: ` ${count}` }) : null,
          ],
        ),
      );
    }
    return tabs;
  }

  function renderRoot(root, rootDisabled) {
    const rootBasename = root.sourceRoot.split("/").pop() || root.sourceRoot;
    return el("section", { class: "skills-root", dataset: { skillRoot: root.sourceRoot } }, [
      el("div", { class: "skills-root-header" }, [
        el("div", {}, [
          el("code", { class: "skills-root-path", text: root.sourceRoot }),
          el("span", {
            class: "skills-root-scope",
            text: t(`settings.skills.${root.scope === "user" ? "global" : "project"}`),
          }),
        ]),
      ]),
      el(
        "div",
        { class: "skills-root-children" },
        renderTopChildren(root.children, rootDisabled, rootBasename),
      ),
    ]);
  }

  function renderTopChildren(children, parentDisabled, rootBasename) {
    const result = [];
    const topSkills = children.filter((c) => c.kind === "skill");
    if (topSkills.length > 0) {
      result.push(renderTopSkillsCard(topSkills, parentDisabled, rootBasename));
    }
    for (const c of children) {
      if (c.kind === "group") result.push(renderGroupNode(c, parentDisabled));
    }
    return result;
  }

  function renderChildren(children, parentDisabled) {
    return children.map((c) =>
      c.kind === "skill" ? renderSkillRow(c, parentDisabled) : renderGroupNode(c, parentDisabled),
    );
  }

  function renderTopSkillsCard(skills, parentDisabled, rootBasename) {
    return el(
      "section",
      { class: "skills-group skills-single-skill", dataset: { skillCard: rootBasename } },
      [
        el("div", { class: "skills-group-header skills-group-header-readonly" }, [
          el("div", { class: "skills-group-info" }, [
            el("div", { class: "skills-group-name", text: rootBasename }),
          ]),
        ]),
        el(
          "div",
          { class: "skills-group-listing" },
          skills.map((s) => renderSkillRow(s, parentDisabled)),
        ),
      ],
    );
  }

  function renderGroupNode(group, parentDisabled) {
    const expanded = expandedGroups.has(group.id);
    const leaves = flatLeaves(group);
    const enabled = leaves.filter((i) => i.status === "enabled").length;
    const groupPending = pendingTargets.has(group.id);
    const groupDisabled = parentDisabled || group.ambiguous || groupPending;

    const header = el("div", { class: "skills-group-header" }, [
      el("button", {
        type: "button",
        class: `skills-expand${expanded ? "" : " collapsed"}`,
        text: expanded ? "⌄" : "›",
        aria: {
          label: `${t("settings.skills.source")}: ${group.ruleBaseRelativePath}`,
          expanded: String(expanded),
          controls: `skills-group-list-${group.id}`,
        },
        onClick: () => {
          if (expandedGroups.has(group.id)) expandedGroups.delete(group.id);
          else expandedGroups.add(group.id);
          render();
        },
      }),
      el("div", { class: "skills-group-info" }, [
        el("div", { class: "skills-group-name", text: group.name }),
        el("div", { class: "skills-group-source", text: group.ruleBaseRelativePath }),
      ]),
      renderSkillStateBadge(group.state, enabled, leaves.length),
      renderSkillSwitch(
        group.state === "all-on",
        groupDisabled,
        group.state === "mixed",
        `${t("settings.skills.enableGroup")}: ${group.ruleBaseRelativePath}`,
        (checked) => void setEnabled({ kind: "group", id: group.id }, checked),
      ),
    ]);

    if (group.ambiguous) {
      header.appendChild(
        el("div", {
          class: "skills-ambiguous-note",
          text: t("settings.skills.ambiguousRuleTarget"),
        }),
      );
    }

    const listing = el(
      "div",
      { id: `skills-group-list-${group.id}`, class: "skills-group-listing" },
      expanded ? renderChildren(group.children, groupDisabled) : [],
    );

    return el(
      "section",
      {
        class: `skills-group${expanded ? "" : " closed"}`,
        dataset: { skillGroup: group.id },
      },
      [header, listing],
    );
  }

  function renderSkillRow(item, parentDisabled = false) {
    return renderSkillItemRow(item, {
      parentDisabled,
      pendingTargets,
      onSetEnabled: (target, checked) => {
        void setEnabled(target, checked);
      },
    });
  }

  function render() {
    const scrollTop = container.scrollTop;

    if (!inventory) {
      if (errorMessage) renderError(errorMessage);
      else renderLoading();
      return;
    }

    const visibleRoots = rootsForScope(inventory, scope);
    const untrusted = scope === "project" && !inventory.trusted;
    const total = visibleRoots.reduce((n, r) => n + flatLeaves(r).length, 0);
    const groupCount = visibleRoots.reduce((n, r) => n + countGroups(r), 0);
    const rootDisabled = untrusted;

    const fragment = document.createDocumentFragment();

    fragment.appendChild(
      el("div", { class: "skills-header" }, [
        el("div", {}, [
          el("div", { class: "settings-section-title", text: t("settings.skills.title") }),
          el("p", { class: "settings-help skills-intro", text: t("settings.skills.description") }),
        ]),
        el("button", {
          type: "button",
          class: "ui-button ui-button--sm ui-button--secondary skills-rescan",
          text: t("settings.skills.rescan"),
          onClick: rescan,
        }),
      ]),
    );

    fragment.appendChild(renderScopeTabs());

    if (untrusted) {
      fragment.appendChild(
        el("div", { class: "skills-notice", text: t("settings.skills.projectUntrusted") }),
      );
    }

    fragment.appendChild(
      el("div", { class: "skills-scope-meta" }, [
        el("span", { text: t("settings.skills.scopeSummary", { total, groups: groupCount }) }),
      ]),
    );

    if (inventory.customRules && inventory.customRules.length > 0) {
      fragment.appendChild(
        el("div", { class: "skills-custom-rules" }, [
          el("div", { class: "skills-custom-rules-label", text: t("settings.skills.customRules") }),
          ...inventory.customRules.map((r) => el("code", { class: "skills-custom-rule", text: r })),
        ]),
      );
    }

    for (const d of inventory.diagnostics ?? []) {
      console.warn("[skills] diagnostic:", d.message);
    }

    if (visibleRoots.length === 0 || total === 0) {
      fragment.appendChild(el("div", { class: "skills-empty", text: t("settings.skills.empty") }));
    } else {
      const list = el("div", { class: "skills-group-list" });
      for (const root of visibleRoots) list.appendChild(renderRoot(root, rootDisabled));
      fragment.appendChild(list);
    }

    container.replaceChildren(fragment);
    container.scrollTop = scrollTop;
    manageModalDialog(null, { owner: "skills-discovered" });
  }

  function destroy() {
    unsubscribeLocale?.();
    container.replaceChildren();
  }

  return {
    activate,
    load,
    destroy,
    isProjectTrusted: () => Boolean(inventory?.trusted),
  };
}
