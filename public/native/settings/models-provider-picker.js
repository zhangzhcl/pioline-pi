// 模型设置页：供应商图标、供应商选择弹窗与 OAuth/终端订阅引导对话框。

import { t } from "../../i18n.js";
import { bindDialogEscape } from "../../ui/dialog-escape.js";
import { openCustomProviderEditor } from "./settings-custom-provider.js";

export const PROVIDER_ICON_ALIASES = {
  "amazon-bedrock": "aws",
  "azure-openai-responses": "azure",
  "github-copilot": "github-copilot",
  "google-vertex": "google",
  "ant-ling": "ant-group",
  "cloudflare-ai-gateway": "cloudflare",
  "cloudflare-workers-ai": "cloudflare",
  deepseek: "deep-seek",
  fireworks: "fireworks",
  huggingface: "hugging-face",
  openrouter: "open-router",
  opencode: "open-code",
  "opencode-go": "open-code",
  xai: "x-a-i",
  "vercel-ai-gateway": "vercel",
  "minimax-cn": "minimax",
  moonshotai: "moonshot",
  "moonshotai-cn": "moonshot",
  "xiaomi-token-plan-ams": "xiaomi-mi-mo",
  "xiaomi-token-plan-cn": "xiaomi-mi-mo",
  "xiaomi-token-plan-sgp": "xiaomi-mi-mo",
};

export function providerIcon(provider, className = "provider-logo") {
  const key = PROVIDER_ICON_ALIASES[provider] || provider;
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.src = `/icons/providers/${key}.svg`;
  img.onerror = () => {
    img.replaceWith(
      Object.assign(document.createElement("span"), {
        className,
        textContent: provider.slice(0, 1).toUpperCase(),
      }),
    );
  };
  return img;
}

export function isCodexProvider(provider) {
  return provider?.provider === "openai-codex";
}

export function escapeSelectorValue(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}

export function getProviderModels(provider) {
  return Array.isArray(provider?.models) ? provider.models : [];
}

/** OAuth 管理的 Codex 供应商已连接状态卡片。 */
export function buildCodexConnectedCard({ onLogout }) {
  const card = document.createElement("div");
  card.className = "provider-manager-card oauth-connected-card";
  const title = document.createElement("div");
  title.className = "api-key-row-name";
  title.textContent = t("settings.models.oauth.connected");
  const logoutBtn = document.createElement("button");
  logoutBtn.type = "button";
  logoutBtn.className = "ui-button ui-button--secondary";
  logoutBtn.textContent = t("settings.models.oauth.logout");
  logoutBtn.addEventListener("click", () => void onLogout?.());
  card.append(title, logoutBtn);
  return card;
}

export function dismissOnEscape(backdrop) {
  const unbind = bindDialogEscape(() => backdrop.remove(), {
    isActive: () => backdrop.isConnected && !backdrop.classList.contains("hidden"),
  });
  const nativeRemove = backdrop.remove.bind(backdrop);
  backdrop.remove = () => {
    unbind();
    nativeRemove();
  };
}

export function setupDialog(title, subtitle) {
  const backdrop = document.createElement("div");
  backdrop.className = "ui-overlay provider-picker-backdrop";
  const dialog = document.createElement("div");
  dialog.className = "ui-dialog provider-setup-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const head = document.createElement("div");
  head.className = "provider-picker-head";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const caption = document.createElement("p");
  caption.textContent = subtitle;
  const titleWrap = document.createElement("div");
  titleWrap.append(heading, caption);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ui-icon-button ui-icon-button--ghost provider-picker-close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.onclick = () => backdrop.remove();
  head.append(titleWrap, close);
  dialog.appendChild(head);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  dismissOnEscape(backdrop);
  return { backdrop, dialog };
}

export function createProviderPickerController({
  call,
  apiKeysContainer,
  hasOAuthGateway,
  getCodexOAuthCapability,
  startOAuthLogin,
  logoutCodex,
  buildApiKeyRow,
  openApiKeyEditor,
  onCustomProviderSaved,
}) {
  function showTerminalLoginDialog(p) {
    const { backdrop, dialog } = setupDialog(
      `Connect ${p.displayName || p.provider}`,
      "This provider uses your subscription account.",
    );
    const note = document.createElement("div");
    note.className = "provider-setup-note";
    note.textContent =
      "OAuth login is run by the pi agent. Start the login flow from a terminal, then return here to refresh the provider status.";
    dialog.appendChild(note);
    const command = document.createElement("code");
    command.className = "provider-login-command";
    command.textContent = `pi /login ${p.provider}`;
    dialog.appendChild(command);
    const actions = document.createElement("div");
    actions.className = "provider-setup-actions";
    const close = document.createElement("button");
    close.className = "ui-button ui-button--secondary";
    close.textContent = "Close";
    close.onclick = () => backdrop.remove();
    actions.appendChild(close);
    dialog.appendChild(actions);
  }

  function openSubscriptionSetup(p) {
    const isCodex = hasOAuthGateway() && isCodexProvider(p);
    if (isCodex) {
      if (getCodexOAuthCapability()?.configured) {
        void logoutCodex();
        return;
      }
      startOAuthLogin();
      return;
    }
    showTerminalLoginDialog(p);
  }

  function openProviderPicker(providers) {
    const backdrop = document.createElement("div");
    backdrop.className = "ui-overlay provider-picker-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "ui-dialog provider-picker-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "provider-picker-title");
    const head = document.createElement("div");
    head.className = "provider-picker-head";
    head.innerHTML = `<div><h2 id="provider-picker-title">Add provider</h2><p>Connect a provider to start using its models.</p></div>`;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ui-icon-button ui-icon-button--ghost provider-picker-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    head.appendChild(close);
    const search = document.createElement("input");
    search.className = "ui-input provider-picker-search";
    search.placeholder = "Search providers…";
    const toolbar = document.createElement("div");
    toolbar.className = "provider-picker-toolbar";
    toolbar.append(head, search);
    const body = document.createElement("div");
    body.className = "provider-picker-body";
    dialog.append(toolbar, body);

    const pickerSubtitle = (section, p) => {
      if (section === "custom") return "Custom endpoint";
      if (section === "subscriptions") return "OAuth";
      const count = Array.isArray(p.models) ? p.models.length : 0;
      if (count <= 0) return "";
      return count === 1 ? "1 model" : `${count} models`;
    };

    const appendPickerCard = (parent, p, section) => {
      const card = document.createElement("button");
      card.className = "provider-picker-card";
      card.type = "button";
      card.dataset.section = section;
      const logo = providerIcon(p.provider);
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = p.displayName || p.provider;
      text.append(strong);
      const subtitle = pickerSubtitle(section, p);
      if (subtitle) {
        const small = document.createElement("small");
        small.textContent = subtitle;
        text.append(small);
      }
      card.append(logo, text);
      card.addEventListener("click", () => {
        backdrop.remove();
        if (p.custom) {
          openCustomProviderEditor({
            call,
            setupDialog,
            onSaved: onCustomProviderSaved,
          });
          return;
        }
        if (section === "subscriptions") {
          openSubscriptionSetup(p);
          return;
        }
        let row = apiKeysContainer.querySelector(
          `[data-provider="${escapeSelectorValue(p.provider)}"]`,
        );
        if (!row) {
          row = buildApiKeyRow(p);
          const detail = apiKeysContainer.querySelector(".models-config-main");
          detail?.replaceChildren(row);
        }
        openApiKeyEditor(row, p);
      });
      parent.appendChild(card);
    };

    const appendPickerSection = (label, section, items) => {
      if (!items.length) return;
      const group = document.createElement("section");
      group.className = "provider-picker-section";
      const heading = document.createElement("h3");
      heading.className = "provider-picker-section-title";
      heading.dataset.section = section;
      heading.textContent = label;
      const wrap = document.createElement("div");
      wrap.className = "provider-picker-grid";
      for (const p of items) {
        appendPickerCard(wrap, p, section);
      }
      group.append(heading, wrap);
      body.appendChild(group);
    };

    const render = () => {
      body.replaceChildren();
      const q = search.value.toLowerCase();
      const matches = providers.filter((p) =>
        (p.displayName || p.provider).toLowerCase().includes(q),
      );
      const custom = {
        provider: "custom",
        displayName: "OpenAI / Anthropic compatible",
        custom: true,
      };
      const customItems =
        !q || "custom openai-compatible anthropic-compatible".includes(q)
          ? [custom]
          : matches.filter((p) => p.custom || p.provider === "custom");
      const oauthEnabled = hasOAuthGateway();
      const subscriptionItems = matches.filter(
        (p) =>
          !p.custom &&
          (p.authType === "oauth" ||
            p.source === "oauth" ||
            p.source === "subscription" ||
            (isCodexProvider(p) && oauthEnabled)),
      );
      const featuredItems = [
        ...customItems.map((p) => ({ p, section: "custom" })),
        ...subscriptionItems.map((p) => ({ p, section: "subscriptions" })),
      ];
      if (featuredItems.length) {
        const group = document.createElement("section");
        group.className = "provider-picker-section";
        group.setAttribute("aria-label", "Custom and subscriptions");
        const wrap = document.createElement("div");
        wrap.className = "provider-picker-featured";
        wrap.dataset.section = "featured";
        for (const { p, section } of featuredItems) {
          appendPickerCard(wrap, p, section);
        }
        group.appendChild(wrap);
        body.appendChild(group);
      }
      appendPickerSection(
        "API key",
        "apiKey",
        matches.filter(
          (p) =>
            !p.custom &&
            !(isCodexProvider(p) && oauthEnabled) &&
            p.authType !== "oauth" &&
            p.source !== "oauth" &&
            p.source !== "subscription",
        ),
      );
    };
    search.addEventListener("input", render);
    close.addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    dismissOnEscape(backdrop);
    render();
    search.focus();
  }

  return {
    openProviderPicker,
    setupDialog,
    openSubscriptionSetup,
  };
}
