// ABOUTME: Populates the chat header with workspace path and git branch info.
// ABOUTME: Safe to call repeatedly — each call re-probes and stale probes lose.

import { onLocaleChange, t } from "../../i18n.js";
import { compactWorkspaceLabel } from "../../workspace/path-utils.js";

/**
 * project-header — populates the chat header with workspace path and git
 * branch info fetched from the host data plane.
 *
 * Responsibilities:
 *  - Show the workspace folder name in the #workspace-indicator label inside
 *    #file-sidebar-toggle. Title and aria-label keep the full path.
 *  - Show the current git branch in the #git-branch-indicator label inside
 *    #diff-sidebar-toggle.
 *  - Both labels are hidden when data is unavailable.
 *  - Re-probe on every workspace switch: the caller (app.js adoptTarget)
 *    invokes this again whenever the workspaceId changes, so pill visibility
 *    follows the current workspace even when the git panel is never opened.
 *  - Late/stale probes never win: only the most recently started probe may
 *    touch the DOM.
 *  - Click handling stays on the toggle buttons in app.js: the path label is
 *    display-only, matching the git-branch label.
 */

// Sequence of the most recently started probe. A probe that resolves after a
// newer one started is stale and must not touch the DOM.
let latestProbeSequence = 0;

// Info from the latest probe that got applied. The single locale listener
// reads this instead of capturing a per-call closure, so a re-probe cannot
// leave a stale workspace's label-retranslation behind.
let currentHeaderInfo = null;
let localeListenerRegistered = false;

/** Apply the files-toggle title/aria-label for the given workspace path. */
function applyFilesToggleLabels(filesToggleEl, info) {
  filesToggleEl.title = info.path;
  filesToggleEl.setAttribute(
    "aria-label",
    t("migrated.index.ariaLabel.openFilesPanel", { path: info.path }),
  );
}

/**
 * @param {object} options
 * @param {import('../transport/data-gateway.js').HostDataGateway} options.data
 * @param {string} options.workspaceId
 */
export async function setupProjectHeader({ data, workspaceId } = {}) {
  const sequence = ++latestProbeSequence;
  const workspaceEl = document.getElementById("workspace-indicator");
  const filesToggleEl = workspaceEl?.closest("#file-sidebar-toggle");
  // #git-branch-indicator is the label span inside #diff-sidebar-toggle.
  // The toggle button itself carries the hidden class and is shown only when
  // git info is available.
  const branchLabelEl = document.getElementById("git-branch-indicator");
  const diffToggleEl = branchLabelEl?.closest("#diff-sidebar-toggle");
  if (!workspaceEl && !branchLabelEl) return;

  let info;
  try {
    const response = await data.workspaceInfo(workspaceId);
    info = response?.info;
  } catch {
    // Network or host error — leave the header on its previous state.
    return;
  }
  // A newer probe started while this one was in flight — drop this result so
  // a slow old-workspace answer can never overwrite the new workspace's DOM.
  if (sequence !== latestProbeSequence) return;
  if (!info) return;
  currentHeaderInfo = info;

  if (workspaceEl) {
    if (info.path) {
      workspaceEl.textContent = compactWorkspaceLabel(info.path);
      workspaceEl.classList.remove("hidden");
      if (filesToggleEl) {
        filesToggleEl.classList.add("file-sidebar-toggle--has-label");
        applyFilesToggleLabels(filesToggleEl, info);
        // One listener for the module's lifetime reads currentHeaderInfo, so
        // repeated calls never accumulate listeners nor resurrect stale paths.
        if (!localeListenerRegistered) {
          localeListenerRegistered = true;
          onLocaleChange(() => {
            const currentInfo = currentHeaderInfo;
            if (!currentInfo?.path) return;
            const filesToggle = document
              .getElementById("workspace-indicator")
              ?.closest("#file-sidebar-toggle");
            if (filesToggle) applyFilesToggleLabels(filesToggle, currentInfo);
          });
        }
      }
    } else {
      // No path for this workspace — clear the previous workspace's label
      // instead of leaving it visible.
      workspaceEl.textContent = "";
      workspaceEl.classList.add("hidden");
      if (filesToggleEl) {
        filesToggleEl.classList.remove("file-sidebar-toggle--has-label");
        filesToggleEl.title = t("migrated.index.title.files");
        filesToggleEl.setAttribute("aria-label", t("migrated.index.ariaLabel.toggleFileBrowser"));
      }
    }
  }

  if (diffToggleEl) {
    if (info.gitBranch) {
      if (branchLabelEl) branchLabelEl.textContent = info.gitBranch;
      diffToggleEl.title = t("git.changesWithBranch", { branch: info.gitBranch });
      diffToggleEl.classList.remove("hidden");
    } else {
      diffToggleEl.classList.add("hidden");
    }
  }
}
