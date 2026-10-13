// 模型设置页：模型健康度展示、批量健康探测与内联 API Key 编辑器。

import { t } from "../../i18n.js";
import { escapeSelectorValue } from "./models-provider-picker.js";

const HEALTH_CHECK_TIMEOUT_MS = 120_000;

export function describeModelHealth(health) {
  if (!health || health.status === "unknown") return t("settings.apiKeys.healthUnknown");
  if (health.status === "healthy") {
    return health.latencyMs
      ? t("settings.apiKeys.healthyLatency", { latency: health.latencyMs })
      : t("settings.apiKeys.healthy");
  }
  return health.error
    ? t("settings.apiKeys.failedWithMessage", { message: health.error })
    : t("settings.apiKeys.failed");
}

export function describeModelStatus(model) {
  const parts = [];
  if (!model.available) parts.push(t("settings.apiKeys.noKeyAvailable"));
  parts.push(describeModelHealth(model.health || { status: "unknown" }));
  return parts.join(" · ");
}

export function describeProviderSummary(models) {
  const enabled = models.filter((model) => model.visible === true).length;
  const healthy = models.filter((model) => model.health?.status === "healthy").length;
  const issues = models.filter((model) => model.health?.status === "unhealthy").length;
  return t("settings.apiKeys.summary", { enabled, healthy, issues });
}

// 根据延迟将健康状态拆分为三档视觉样式，区分快速响应、慢响应与故障模型。
export function healthDotClass(health) {
  if (!health?.status || health.status === "unknown" || health.status === "checking") {
    return health?.status || "unknown";
  }
  if (health.status !== "healthy") return "unhealthy";
  if (typeof health.latencyMs !== "number") return "healthy";
  if (health.latencyMs < 1500) return "healthy";
  if (health.latencyMs < 3000) return "healthy-slow";
  return "healthy-veryslow";
}

export function setModelRowChecking(row) {
  if (!row) return;
  const dot = row.querySelector(".api-model-health-dot");
  const status = row.querySelector(".api-model-health-status");
  if (dot) {
    dot.className = "api-model-health-dot checking";
    dot.title = t("settings.apiKeys.checkingHealth");
  }
  if (status) status.textContent = t("settings.apiKeys.checkingHealthEllipsis");
}

export function setModelRowHealthError(row, message) {
  if (!row) return;
  const dot = row.querySelector(".api-model-health-dot");
  const status = row.querySelector(".api-model-health-status");
  const text = t("settings.apiKeys.failedWithMessage", {
    message: message || t("settings.apiKeys.healthCheckFailed"),
  });
  if (dot) {
    dot.className = "api-model-health-dot unknown";
    dot.title = text;
  }
  if (status) status.textContent = text;
}

export function createModelsHealthAndKeyController({
  call,
  apiKeysContainer,
  getProviderModelRows,
  onModelConfigurationChanged,
  loadApiKeysPanel,
}) {
  function applyHealthResult(result) {
    const row = apiKeysContainer?.querySelector(
      `.api-model-row[data-provider="${escapeSelectorValue(result.provider)}"][data-model-id="${escapeSelectorValue(result.modelId)}"]`,
    );
    if (!row) return;
    const dot = row.querySelector(".api-model-health-dot");
    const status = row.querySelector(".api-model-health-status");
    const health = { status: result.status, latencyMs: result.latencyMs, error: result.error };
    if (dot) {
      dot.className = `api-model-health-dot ${healthDotClass(health)}`;
      dot.title = describeModelHealth(health);
    }
    if (status) status.textContent = describeModelHealth(health);
  }

  async function checkModelHealth(provider) {
    for (const modelRow of getProviderModelRows(provider)) {
      const toggle = modelRow.querySelector(".api-model-visibility-toggle");
      if (toggle?.checked && modelRow.dataset.available !== "false") setModelRowChecking(modelRow);
    }
    const resp = await call(
      "check_model_health",
      { provider },
      { timeoutMs: HEALTH_CHECK_TIMEOUT_MS },
    ).catch((error) => ({ ok: false, error: error?.message }));
    if (resp?.ok && Array.isArray(resp.data?.results)) {
      for (const result of resp.data.results) applyHealthResult(result);
    } else {
      const message = resp?.error || t("settings.apiKeys.healthCheckFailed");
      for (const modelRow of getProviderModelRows(provider)) {
        const toggle = modelRow.querySelector(".api-model-visibility-toggle");
        if (toggle?.checked && modelRow.dataset.available !== "false") {
          setModelRowHealthError(modelRow, message);
        }
      }
    }
  }

  function openApiKeyEditor(row, p) {
    const editor = document.createElement("div");
    editor.className = "api-key-editor";

    const title = document.createElement("div");
    title.className = "api-key-row-name";
    title.textContent = t("settings.apiKeys.editorTitle", {
      provider: p.displayName || p.provider,
    });
    editor.appendChild(title);

    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t("settings.apiKeys.pastePlaceholder");
    editor.appendChild(input);

    const err = document.createElement("div");
    err.className = "api-key-editor-error";
    err.style.display = "none";
    editor.appendChild(err);

    const actions = document.createElement("div");
    actions.className = "api-key-editor-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ui-button ui-button--secondary config-editor-cancel";
    cancelBtn.textContent = t("actions.cancel");
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "ui-button ui-button--primary";
    saveBtn.textContent = t("actions.save");
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    editor.appendChild(actions);

    row.replaceWith(editor);
    requestAnimationFrame(() => input.focus());

    const cancel = () => {
      editor.replaceWith(row);
    };
    cancelBtn.addEventListener("click", cancel);

    const save = async () => {
      const key = input.value.trim();
      if (!key) {
        err.textContent = t("settings.apiKeys.keyCannotBeEmpty");
        err.style.display = "";
        return;
      }
      saveBtn.disabled = true;
      try {
        const resp = await call("set_api_key", { provider: p.provider, apiKey: key }).catch(
          (error) => ({
            ok: false,
            error: error?.message,
          }),
        );
        if (resp?.ok) {
          await onModelConfigurationChanged?.();
          await loadApiKeysPanel();
        } else {
          err.textContent = resp?.error || t("settings.apiKeys.saveFailed");
          err.style.display = "";
          saveBtn.disabled = false;
        }
      } catch (error) {
        err.textContent = error?.message || t("settings.apiKeys.saveFailed");
        err.style.display = "";
        saveBtn.disabled = false;
      }
    };
    saveBtn.addEventListener("click", () => {
      save();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
  }

  async function removeApiKey(p) {
    const ok = confirm(
      t("settings.apiKeys.removeConfirm", { provider: p.displayName || p.provider }),
    );
    if (!ok) return;
    const resp = await call("remove_api_key", { provider: p.provider }).catch(() => null);
    if (resp?.ok) {
      await onModelConfigurationChanged?.();
      loadApiKeysPanel();
    }
  }

  return {
    checkModelHealth,
    openApiKeyEditor,
    removeApiKey,
  };
}
