import { onLocaleChange, t } from "../i18n.js";
import { isSuperAgentEnabled, setSuperAgentEnabled } from "../super-agent/settings.js";

/**
 * <chat-settings-panel> Web Component
 *
 * The "Agent Inbox" tab inside Settings. The normal Telegram setup flow only asks
 * for a bot token; Picot validates the bot, waits for the user's first DM, and
 * writes the full internal ~/.pi/agent/chat/config.json automatically.
 */

class ChatSettingsPanel extends HTMLElement {
  connectedCallback() {
    if (this._initialized) return;
    this._initialized = true;
    this.innerHTML = `
      <div class="settings-body">
        <div class="settings-section">
          <div class="settings-section-title chat-settings-title-row">
            <span data-i18n="settings.agentInbox">Agent Inbox</span>
            <span class="ui-badge chat-settings-beta-badge" data-i18n="inbox.beta">Beta</span>
          </div>
          <div class="settings-row" id="setting-super-agent">
            <span class="settings-label settings-label-stack">
              <span class="settings-label-main" data-i18n="inbox.startAutomatically">Start automatically</span>
              <span class="settings-label-sub" data-i18n="inbox.launchOnOpen">Launch Agent Inbox when Pipline opens</span>
            </span>
            <button class="settings-toggle" id="toggle-super-agent"></button>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title" data-i18n="inbox.telegram">Telegram</div>
          <p class="settings-help">
            <span data-i18n="inbox.tokenHelpPre">Paste a Telegram bot token from</span>
            <code>@BotFather</code>
            <span data-i18n="inbox.tokenHelpMid">. Pipline will detect your Telegram DM automatically after you send</span>
            <code>/start</code>
            <span data-i18n="inbox.tokenHelpPost">to the bot.</span>
          </p>
          <p class="settings-help telegram-safety-note" data-i18n="inbox.safety">
            Telegram messages enter Agent Inbox first. Pipline keeps project-agent dispatch
            behind local approval.
          </p>
          <div class="telegram-setup-card">
            <label class="telegram-token-label" for="telegram-bot-token" data-i18n="inbox.botToken">Bot token</label>
            <div class="telegram-token-row">
              <input id="telegram-bot-token" class="ui-input telegram-token-input"
                data-token-input type="password" autocomplete="off" spellcheck="false"
                placeholder="123456:ABCDEF…" data-i18n-ph="inbox.tokenPlaceholder" />
              <button class="ui-button ui-button--primary" data-action="connect-telegram" data-i18n="inbox.connectTelegram">Connect Telegram</button>
              <button class="ui-button ui-button--secondary" data-action="cancel-telegram" hidden data-i18n="actions.cancel">Cancel</button>
            </div>
            <div class="settings-save-status hidden" data-status aria-live="polite" role="status"></div>
            <div class="telegram-bind-instructions hidden" data-bind-instructions></div>
          </div>
          <div class="telegram-doctor-card" data-telegram-doctor>
            <div class="chat-account-header">
              <span class="chat-account-name" data-i18n="inbox.telegramDoctor">Telegram Doctor</span>
              <button class="ui-button ui-button--secondary" data-action="run-telegram-doctor" data-i18n="inbox.runDoctor">Run Doctor</button>
            </div>
            <div class="settings-help" data-telegram-doctor-summary data-i18n="inbox.notCheckedYet">Not checked yet.</div>
            <div class="telegram-doctor-checks" data-telegram-doctor-checks></div>
          </div>
          <div class="chat-accounts-list" data-accounts-list></div>
        </div>

        <details class="settings-section chat-advanced-config" hidden>
          <summary class="settings-section-title" data-i18n="inbox.advancedRawConfig">Advanced Raw Config</summary>
          <p class="settings-help">
            <span data-i18n="inbox.advancedHelpPre">Internal config stored in</span>
            <code data-i18n="inbox.chatConfigPath">~/.pi/agent/chat/config.json</code>
            <span data-i18n="inbox.advancedHelpPost">. You normally do not need to edit this manually.</span>
          </p>
          <textarea class="ui-textarea config-editor-textarea settings-config-textarea"
            data-textarea spellcheck="false" autocomplete="off"
            autocorrect="off" autocapitalize="off" placeholder="Loading…" data-i18n-ph="files.loading"></textarea>
          <div class="settings-config-actions">
            <div class="settings-config-button-group">
              <button class="ui-button ui-button--primary" data-action="save" data-i18n="inbox.saveRawConfig">Save Raw Config</button>
            </div>
          </div>
        </details>
      </div>
    `;

    this._setupSuperAgentToggle();

    this._textarea = this.querySelector("[data-textarea]");
    this._statusEl = this.querySelector("[data-status]");
    this._accountsEl = this.querySelector("[data-accounts-list]");
    this._tokenInput = this.querySelector("[data-token-input]");
    this._bindInstructionsEl = this.querySelector("[data-bind-instructions]");
    this._doctorSummaryEl = this.querySelector("[data-telegram-doctor-summary]");
    this._doctorChecksEl = this.querySelector("[data-telegram-doctor-checks]");

    this.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "save") this._save();
      if (action === "connect-telegram") this._connectTelegram();
      if (action === "cancel-telegram") this._cancelTelegram();
      if (action === "disconnect-telegram") this._disconnectTelegram();
      if (action === "run-telegram-doctor") this._loadTelegramDoctor();
    });

    this._tokenInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this._connectTelegram();
      }
    });

    document.querySelectorAll(".settings-nav-item").forEach((btn) => {
      if (btn.dataset.settingsTab === "chat") {
        btn.addEventListener("click", () => this._load());
      }
    });

    this._handleConfigGatewayReady = () => this._load();
    window.addEventListener("picot-config-gateway-ready", this._handleConfigGatewayReady);
    this._unsubscribeLocale = onLocaleChange(() => {
      this._renderAccounts(this._textarea?.value);
      if (this._lastDoctorReport) this._renderTelegramDoctor(this._lastDoctorReport);
    });
    this._load();
  }

  disconnectedCallback() {
    if (this._handleConfigGatewayReady) {
      window.removeEventListener("picot-config-gateway-ready", this._handleConfigGatewayReady);
    }
    this._unsubscribeLocale?.();
  }

  // ── Super Agent toggle ──────────────────────────────────────────────────

  _setupSuperAgentToggle() {
    const button = this.querySelector("#toggle-super-agent");
    if (!button) return;

    const isEnabled = isSuperAgentEnabled();
    button.classList.toggle("on", isEnabled);
    button.setAttribute("aria-checked", String(isEnabled));
    button.setAttribute("role", "switch");

    button.addEventListener("click", () => {
      const newState = !button.classList.contains("on");
      button.classList.toggle("on", newState);
      button.setAttribute("aria-checked", String(newState));
      setSuperAgentEnabled(newState);
      window.dispatchEvent(
        new CustomEvent("picot-super-agent-autostart-changed", { detail: { enabled: newState } }),
      );
    });
  }

  // ── API ───────────────────────────────────────────────────────────────────

  async _load() {
    try {
      const { content } = await readChatConfig();
      this._setRawContent(content || "{}");
      this._renderAccounts(content);
      await this._loadTelegramDoctor();
    } catch {}
  }

  async _save() {
    const content = this._textarea.value;
    try {
      JSON.parse(content);
    } catch {
      this._showError(t("inbox.invalidJson"));
      return;
    }
    this._clearStatus();
    const saveBtn = this.querySelector('[data-action="save"]');
    saveBtn.disabled = true;
    try {
      await writeChatConfig(content);
      this._renderAccounts(content);
      this._showSuccess(t("inbox.savedRawConfig"));
      await this._loadTelegramDoctor();
    } catch (e) {
      this._showError(messageFromError(e));
    } finally {
      saveBtn.disabled = false;
    }
  }

  async _connectTelegram() {
    const botToken = this._tokenInput.value.trim();
    if (!botToken) {
      this._showError(t("inbox.pasteTokenFirst"));
      this._tokenInput.focus();
      return;
    }

    this._cancelTelegram();
    const controller = new AbortController();
    this._telegramSetupAbort = controller;
    this._setTelegramBusy(true);
    this._clearBindInstructions();

    try {
      this._showInfo(t("inbox.validatingToken"));
      const validated = await telegramValidate({ botToken }, { signal: controller.signal });
      const bot = validated.bot || {};
      this._renderBindInstructions(bot);
      this._showInfo(t("inbox.botConnectedSendStart"));

      const bound = await telegramBind(
        { botToken, afterUpdateId: validated.afterUpdateId },
        { signal: controller.signal },
      );
      this._setRawContent(bound.content || "{}");
      this._renderAccounts(bound.content);
      this._tokenInput.value = "";
      this._showSuccess(t("inbox.telegramConnected"));
      this._clearBindInstructions();
      await this._loadTelegramDoctor();
      window.dispatchEvent(new CustomEvent("picot-chat-config-updated"));
    } catch (e) {
      if (controller.signal.aborted) {
        this._showInfo(t("inbox.setupCanceled"));
      } else {
        this._showError(messageFromError(e));
      }
    } finally {
      if (this._telegramSetupAbort === controller) this._telegramSetupAbort = null;
      this._setTelegramBusy(false);
    }
  }

  _cancelTelegram() {
    if (this._telegramSetupAbort) {
      this._telegramSetupAbort.abort();
      this._telegramSetupAbort = null;
    }
  }

  async _disconnectTelegram() {
    if (!window.confirm(t("inbox.disconnectConfirm"))) return;
    try {
      const config = JSON.parse(this._textarea.value || "{}");
      const accounts = Object.entries(config.accounts || {}).filter(
        ([, account]) => account?.service !== "telegram",
      );
      config.accounts = Object.fromEntries(accounts);
      const content = `${JSON.stringify(config, null, "\t")}\n`;
      await writeChatConfig(content);
      this._setRawContent(content);
      this._renderAccounts(content);
      this._showSuccess(t("inbox.disconnected"));
      await this._loadTelegramDoctor();
      window.dispatchEvent(new CustomEvent("picot-chat-config-updated"));
    } catch (e) {
      this._showError(messageFromError(e));
    }
  }

  async _loadTelegramDoctor() {
    const runBtn = this.querySelector('[data-action="run-telegram-doctor"]');
    runBtn.disabled = true;
    this._doctorSummaryEl.textContent = t(
      "migrated.components.chatSettingsPanel.textcontent.checkingTelegram",
    );
    this._doctorChecksEl.innerHTML = "";
    try {
      const { report } = await telegramDoctor();
      this._lastDoctorReport = report;
      this._renderTelegramDoctor(report);
    } catch (e) {
      this._doctorSummaryEl.textContent = messageFromError(e);
      this._doctorChecksEl.innerHTML = "";
    } finally {
      runBtn.disabled = false;
    }
  }

  _renderTelegramDoctor(report) {
    const summary = report?.summary || "error";
    const label =
      summary === "ready"
        ? t("inbox.ready")
        : summary === "warning"
          ? t("inbox.needsAttention")
          : t("inbox.notReady");
    this._doctorSummaryEl.textContent = label;
    this._doctorChecksEl.innerHTML = (report?.checks || [])
      .map(
        (check) => `
          <div class="telegram-doctor-check ${doctorStatusClass(check.status)}">
            <span class="telegram-doctor-label">${esc(check.label)}</span>
            <span class="telegram-doctor-message">${esc(check.message)}</span>
          </div>
        `,
      )
      .join("");
  }

  // ── Render accounts list ──────────────────────────────────────────────────

  _renderAccounts(rawContent) {
    if (!this._accountsEl) return;
    try {
      const config = JSON.parse(rawContent || "{}");
      const accountEntry = Object.entries(config.accounts || {}).find(
        ([, account]) => account?.service === "telegram",
      );
      if (!accountEntry) {
        this._accountsEl.innerHTML = `<p class="settings-help">${esc(t("inbox.notConnected"))}</p>`;
        this._tokenInput.placeholder = t("inbox.tokenPlaceholder");
        this.querySelector('[data-action="connect-telegram"]').textContent =
          t("inbox.connectTelegram");
        return;
      }

      const [id, account] = accountEntry;
      const dm = Object.values(account.channels || {}).find((channel) => channel?.dm === true);
      const botName = account.botUsername ? `@${account.botUsername}` : account.name || id;
      const authorizedUser =
        dm?.name || dm?.access?.allowedUserIds?.[0] || dm?.id || t("inbox.detectedDm");
      this._tokenInput.placeholder = t(
        "migrated.components.chatSettingsPanel.placeholder.pasteANewTokenToReconnect",
      );
      this.querySelector('[data-action="connect-telegram"]').textContent =
        t("inbox.reconnectTelegram");
      this._accountsEl.innerHTML = `
        <div class="chat-account-card">
          <div class="chat-account-header">
            <span class="chat-account-name">${esc(botName)}</span>
          </div>
          <div class="chat-account-detail">${esc(t("inbox.authorizedDm", { user: authorizedUser }))}</div>
          <div class="chat-account-detail">${esc(t("inbox.internalId"))} <code>${esc(id)}</code></div>
          <div class="chat-account-actions">
            <button class="ui-button ui-button--danger" data-action="disconnect-telegram">${esc(t("inbox.disconnect"))}</button>
          </div>
        </div>
      `;
    } catch {
      this._accountsEl.innerHTML = "";
    }
  }

  _renderBindInstructions(bot) {
    const username = bot.username;
    const link = bot.webUrl || (username ? `https://web.telegram.org/k/#@${username}` : "");
    this._bindInstructionsEl.innerHTML = `
      <div class="telegram-bind-title">${esc(t("inbox.waitingForDm"))}</div>
      <ol class="telegram-bind-steps">
        <li>${esc(username ? t("inbox.openBot", { bot: `@${username}` }) : t("inbox.openTheBot"))}</li>
        <li>${esc(t("inbox.sendStartStep"))}</li>
      </ol>
      ${
        link
          ? `<a class="ui-button ui-button--secondary telegram-open-link" href="${escAttr(link)}" target="_blank" rel="noreferrer">${esc(t("inbox.openTelegram"))}</a>`
          : ""
      }
    `;
    this._bindInstructionsEl.classList.remove("hidden");
  }

  _clearBindInstructions() {
    this._bindInstructionsEl.classList.add("hidden");
    this._bindInstructionsEl.innerHTML = "";
  }

  _setRawContent(content) {
    this._textarea.value = content || "{}";
  }

  _setTelegramBusy(isBusy) {
    this._tokenInput.disabled = isBusy;
    this.querySelector('[data-action="connect-telegram"]').disabled = isBusy;
    this.querySelector('[data-action="cancel-telegram"]').hidden = !isBusy;
  }

  // ── Status helpers ────────────────────────────────────────────────────────

  _showError(msg) {
    this._statusEl.textContent = msg;
    this._statusEl.style.color = "";
    this._statusEl.classList.remove("hidden");
  }

  _showInfo(msg) {
    this._statusEl.textContent = msg;
    this._statusEl.style.color = "var(--text-secondary)";
    this._statusEl.classList.remove("hidden");
  }

  _showSuccess(msg) {
    this._statusEl.textContent = msg;
    this._statusEl.style.color = "var(--color-success, #4ade80)";
    this._statusEl.classList.remove("hidden");
  }

  _clearStatus() {
    this._statusEl.classList.add("hidden");
  }
}

async function postJson(url, payload, options = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || "Request failed");
  return data;
}

async function callPicotConfig(op, params = {}, options = {}) {
  if (typeof window.__picotConfigCall !== "function") return null;
  const result = await window.__picotConfigCall(op, params, options);
  if (!result?.ok) throw new Error(result?.error || `${op} failed`);
  return result.data || {};
}

async function readChatConfig() {
  if (typeof window.__picotConfigCall === "function") {
    return callPicotConfig("read_chat_config");
  }
  const res = await fetch("/api/chat-config");
  if (!res.ok) throw new Error("Failed to load chat config");
  return res.json();
}

async function writeChatConfig(content) {
  if (typeof window.__picotConfigCall === "function") {
    return callPicotConfig("write_chat_config", { content });
  }
  const res = await fetch("/api/chat-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Save failed");
  return data;
}

async function telegramValidate(payload, options) {
  if (typeof window.__picotConfigCall === "function") {
    return callPicotConfig("telegram_validate", payload, options);
  }
  return postJson("/api/chat-telegram/validate", payload, options);
}

async function telegramBind(payload, options) {
  if (typeof window.__picotConfigCall === "function") {
    return callPicotConfig("telegram_bind", payload, options);
  }
  return postJson("/api/chat-telegram/bind", payload, options);
}

async function telegramDoctor() {
  if (typeof window.__picotConfigCall === "function") {
    return callPicotConfig("telegram_doctor");
  }
  const res = await fetch("/api/chat-telegram/doctor");
  const data = await res.json();
  if (!res.ok || data.success === false) throw new Error(data.error || "Telegram doctor failed");
  return data;
}

function messageFromError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(str) {
  return esc(str).replace(/'/g, "&#39;");
}

function doctorStatusClass(status) {
  if (status === "ok") return "ok";
  if (status === "warning") return "warning";
  return "error";
}

customElements.define("chat-settings-panel", ChatSettingsPanel);
