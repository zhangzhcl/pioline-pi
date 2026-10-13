// ABOUTME: DOM template and rendering helpers for the "Connect to a remote host" dialog.

import { applyTranslations, t } from "../../i18n.js";

export const MANUAL_HOST_VALUE = "";
export const SSH_CONFIG_PREFIX = "ssh-config:";

export function hostLabel(alias, entry) {
  const target = entry.user ? `${entry.user}@${entry.host}` : entry.host;
  return entry.port ? `${alias} · ${target}:${entry.port}` : `${alias} · ${target}`;
}

/**
 * Build the dialog DOM once. Markup lives here (not index.html) so the feature
 * owns its own template, per the module rules in AGENTS.md.
 */
export function createDialogDom() {
  const overlay = document.createElement("div");
  overlay.className = "ui-overlay remote-workspace-overlay hidden";

  const dialog = document.createElement("div");
  dialog.className = "ui-dialog remote-workspace-dialog hidden";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = `
    <header class="remote-workspace-header">
      <strong data-i18n="remoteWorkspace.dialogTitle">Connect to a remote host</strong>
      <p class="remote-workspace-help" data-i18n="remoteWorkspace.dialogHelp">
        Pipline opens the project where it lives. Read, write, edit and bash run on the remote host over SSH — no local copy is required.
      </p>
    </header>
    <div class="remote-workspace-body">
      <div class="remote-workspace-field">
        <span class="remote-workspace-label" data-i18n="remoteWorkspace.savedHost">Saved host</span>
        <div class="remote-workspace-host-row">
          <select class="ui-select" data-field="savedHost"></select>
          <button type="button" class="ui-button ui-button--sm ui-button--ghost hidden" data-action="edit-host"
            data-i18n="sshHosts.edit">Edit</button>
          <button type="button" class="ui-button ui-button--sm ui-button--ghost hidden" data-action="delete-host"
            data-i18n="sshHosts.delete">Delete</button>
        </div>
      </div>
      <div class="remote-workspace-grid" data-manual-fields>
        <label class="remote-workspace-field">
          <span class="remote-workspace-label" data-i18n="sshRemote.hostLabel">Host</span>
          <input class="ui-input" data-field="host" type="text" autocomplete="off" spellcheck="false"
            placeholder="192.168.1.50 or my-server.example.com" data-i18n-ph="sshRemote.hostPlaceholder" />
        </label>
        <label class="remote-workspace-field remote-workspace-field--sm">
          <span class="remote-workspace-label" data-i18n="sshRemote.portLabel">Port</span>
          <input class="ui-input" data-field="port" type="number" min="1" max="65535" autocomplete="off"
            placeholder="22" data-i18n-ph="sshRemote.portPlaceholder" />
        </label>
        <label class="remote-workspace-field remote-workspace-field--sm">
          <span class="remote-workspace-label" data-i18n="sshRemote.userLabel">Username</span>
          <input class="ui-input" data-field="user" type="text" autocomplete="off" spellcheck="false"
            placeholder="ubuntu" data-i18n-ph="sshRemote.userPlaceholder" />
        </label>
        <label class="remote-workspace-field">
          <span class="remote-workspace-label" data-i18n="sshRemote.identityFileLabel">Identity file</span>
          <input class="ui-input" data-field="identityFile" type="text" autocomplete="off" spellcheck="false"
            placeholder="~/.ssh/id_ed25519" data-i18n-ph="sshRemote.identityFilePlaceholder" />
        </label>
        <label class="remote-workspace-field">
          <span class="remote-workspace-label" data-i18n="remoteWorkspace.saveAs">Remember this host as</span>
          <input class="ui-input" data-field="alias" type="text" autocomplete="off" spellcheck="false"
            placeholder="gpu-box" data-i18n-ph="remoteWorkspace.saveAsPlaceholder" />
        </label>
      </div>
      <label class="remote-workspace-field">
        <span class="remote-workspace-label" data-i18n="remoteWorkspace.password">Password</span>
        <input class="ui-input" data-field="password" type="password" autocomplete="new-password" />
        <span class="remote-workspace-help" data-i18n="remoteWorkspace.passwordHelp">
          Only needed when the host has no key set up. Kept in memory for this connection and never saved to disk.
        </span>
      </label>
      <div class="remote-workspace-field">
        <span class="remote-workspace-label" data-i18n="remoteWorkspace.remotePath">Remote project path</span>
        <div class="remote-workspace-path-row">
          <input class="ui-input" data-field="remotePath" type="text" autocomplete="off" spellcheck="false"
            placeholder="/home/ubuntu/my-project" data-i18n-ph="remoteWorkspace.remotePathPlaceholder" />
          <button type="button" class="ui-button ui-button--secondary" data-action="browse"
            data-i18n="remoteWorkspace.browse">Browse…</button>
        </div>
      </div>
      <div class="remote-workspace-browser hidden" data-browser>
        <div class="remote-workspace-browser-path" data-browser-path></div>
        <ul class="remote-workspace-browser-list" data-browser-list></ul>
      </div>
      <p class="remote-workspace-status hidden" data-status aria-live="polite" role="status"></p>
    </div>
    <footer class="remote-workspace-actions">
      <button type="button" class="ui-button ui-button--ghost" data-action="test"
        data-i18n="sshRemote.testConnection">Test Connection</button>
      <button type="button" class="ui-button ui-button--ghost" data-action="save-host"
        data-i18n="sshHosts.save">Save host</button>
      <span class="remote-workspace-spacer"></span>
      <button type="button" class="ui-button ui-button--secondary" data-action="cancel"
        data-i18n="remoteWorkspace.cancel">Cancel</button>
      <button type="button" class="ui-button ui-button--primary" data-action="connect"
        data-i18n="remoteWorkspace.connect">Connect</button>
    </footer>
  `;
  document.body.append(overlay, dialog);
  applyTranslations(dialog);
  return { overlay, dialog };
}

export function renderSavedHostOptionsIntoSelect(select, savedHosts, configHosts) {
  const previous = select.value;
  select.replaceChildren();
  const manual = document.createElement("option");
  manual.value = MANUAL_HOST_VALUE;
  manual.textContent = t("remoteWorkspace.enterManually");
  select.append(manual);
  for (const [alias, entry] of Object.entries(savedHosts)) {
    const option = document.createElement("option");
    option.value = alias;
    option.textContent = hostLabel(alias, entry);
    select.append(option);
  }
  if (configHosts.length > 0) {
    const group = document.createElement("optgroup");
    group.label = t("remoteWorkspace.fromSshConfig");
    for (const entry of configHosts) {
      if (savedHosts[entry.alias]) continue;
      const option = document.createElement("option");
      option.value = `${SSH_CONFIG_PREFIX}${entry.alias}`;
      option.textContent = hostLabel(entry.alias, entry);
      group.append(option);
    }
    if (group.childElementCount > 0) select.append(group);
  }
  select.value = [...select.querySelectorAll("option")].some((o) => o.value === previous)
    ? previous
    : MANUAL_HOST_VALUE;
}

export function renderDirectoryBrowser(dialog, remotePathInput, browserPath, directories, browse) {
  const browser = dialog.querySelector("[data-browser]");
  browser.classList.remove("hidden");
  dialog.querySelector("[data-browser-path]").textContent = browserPath;
  const list = dialog.querySelector("[data-browser-list]");
  list.replaceChildren();
  const addRow = (label, onClick) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "remote-workspace-browser-item";
    button.textContent = label;
    button.addEventListener("click", onClick);
    item.append(button);
    list.append(item);
  };
  if (browserPath && browserPath !== "/") {
    const parent = browserPath.slice(0, browserPath.lastIndexOf("/")) || "/";
    addRow(t("remoteWorkspace.parentDirectory"), () => void browse(parent));
  }
  for (const name of directories) {
    const child = browserPath.endsWith("/") ? `${browserPath}${name}` : `${browserPath}/${name}`;
    addRow(name, () => {
      remotePathInput.value = child;
      void browse(child);
    });
  }
  remotePathInput.value = browserPath;
}
