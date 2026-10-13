// 模型设置页：models.json 自定义供应商配置表单、模型列表、新建/编辑模型表单与健康概览区块。

import { t } from "../../i18n.js";
import { describeProviderSummary } from "./models-health-and-key-editor.js";
import { getProviderModels } from "./models-provider-picker.js";

export function createModelsField(label, control, hint) {
  const field = document.createElement("label");
  field.className = "models-config-field";
  const caption = document.createElement("span");
  caption.textContent = label;
  field.append(caption, control);
  if (hint) {
    const help = document.createElement("small");
    help.textContent = hint;
    field.appendChild(help);
  }
  return field;
}

export function createModelsInput(value, placeholder = "") {
  const input = document.createElement("input");
  input.className = "ui-input";
  input.value = value ?? "";
  input.placeholder = placeholder;
  input.spellcheck = false;
  return input;
}

export function renderProviderConfigForm({
  main,
  config,
  providerName,
  update,
  inlineModelsTextarea,
  showInlineModelsError,
  setSelectedItem,
}) {
  const provider = config.providers[providerName];
  const header = document.createElement("div");
  header.className = "models-config-detail-header";
  const eyebrow = document.createElement("span");
  eyebrow.className = "models-config-eyebrow";
  eyebrow.textContent = "Provider";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ui-button ui-button--danger ui-button--sm";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => {
    if (!confirm(`Delete provider “${providerName}”?`)) return;
    update(() => {
      delete config.providers[providerName];
      setSelectedItem(null);
    });
  });
  header.append(eyebrow, remove);

  const form = document.createElement("div");
  form.className = "models-config-form";
  const name = createModelsInput(providerName, "provider-name");
  name.addEventListener("change", () => {
    const nextName = name.value.trim();
    if (!nextName || nextName === providerName) {
      name.value = providerName;
      return;
    }
    if (config.providers[nextName]) {
      showInlineModelsError(`Provider “${nextName}” already exists.`);
      name.value = providerName;
      return;
    }
    update(() => {
      config.providers[nextName] = provider;
      delete config.providers[providerName];
      setSelectedItem({ type: "provider", provider: nextName });
    });
  });
  const baseUrl = createModelsInput(provider.baseUrl, "https://api.example.com/v1");
  baseUrl.addEventListener("input", () => {
    provider.baseUrl = baseUrl.value || undefined;
    inlineModelsTextarea.value = JSON.stringify(config, null, 2);
  });
  const apiKey = createModelsInput(provider.apiKey, "ENV_VAR_NAME, !shell-command, or literal key");
  apiKey.type = "password";
  apiKey.autocomplete = "off";
  apiKey.addEventListener("input", () => {
    provider.apiKey = apiKey.value || undefined;
    inlineModelsTextarea.value = JSON.stringify(config, null, 2);
  });
  const api = document.createElement("select");
  api.className = "ui-select";
  for (const optionValue of [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ]) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionValue;
    option.selected = (provider.api || "openai-completions") === optionValue;
    api.appendChild(option);
  }
  api.addEventListener("change", () => {
    provider.api = api.value;
    inlineModelsTextarea.value = JSON.stringify(config, null, 2);
  });
  form.append(
    createModelsField("Provider name", name),
    createModelsField("Base URL", baseUrl),
    createModelsField(
      "API Key",
      apiKey,
      "Prefix with ! to run a shell command, or use an environment variable name.",
    ),
    createModelsField("API", api),
  );
  main.append(header, form);
}

export function renderProviderHealthSection({ main, provider, buildModelList, checkModelHealth }) {
  const healthSection = document.createElement("div");
  healthSection.className = "provider-manager-health";

  const header = document.createElement("div");
  header.className = "api-key-row-header provider-manager-health-header";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "api-provider-toggle";
  toggle.setAttribute(
    "aria-label",
    t("settings.apiKeys.toggleModels", { provider: provider.displayName || provider.provider }),
  );
  toggle.setAttribute("aria-expanded", "true");
  toggle.textContent = "▼";

  const info = document.createElement("div");
  info.className = "api-key-row-info api-provider-title-toggle";
  info.tabIndex = 0;
  info.setAttribute("role", "button");
  info.setAttribute(
    "aria-label",
    t("settings.apiKeys.toggleModels", { provider: provider.displayName || provider.provider }),
  );

  const title = document.createElement("div");
  title.className = "api-key-row-name";
  title.textContent = provider.displayName || provider.provider;
  info.appendChild(title);

  const summary = document.createElement("div");
  summary.className = "api-key-row-summary";
  summary.textContent = describeProviderSummary(getProviderModels(provider));

  const actions = document.createElement("div");
  actions.className = "api-key-row-actions";
  const checkHealthBtn = document.createElement("button");
  checkHealthBtn.type = "button";
  checkHealthBtn.className = "api-model-check-visible";
  checkHealthBtn.textContent = t("settings.apiKeys.checkHealth");
  checkHealthBtn.disabled = !getProviderModels(provider).some(
    (model) => model.visible === true && model.available,
  );
  checkHealthBtn.addEventListener("click", () => checkModelHealth(provider.provider));
  actions.appendChild(checkHealthBtn);

  header.append(toggle, info, summary, actions);
  const modelList = buildModelList(provider);
  modelList?.classList.add("provider-manager-model-list");
  const toggleModelList = () => {
    if (!modelList) return;
    modelList.classList.toggle("collapsed");
    toggle.setAttribute("aria-expanded", String(!modelList.classList.contains("collapsed")));
  };
  header.addEventListener("click", (event) => {
    if (event.target.closest?.(".api-key-row-actions")) return;
    toggleModelList();
  });
  info.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleModelList();
    }
  });

  healthSection.append(header);
  if (modelList) healthSection.appendChild(modelList);
  main.appendChild(healthSection);
}

export function renderModelsListSection({
  main,
  config,
  providerName,
  update,
  setNewModelDraft,
  setSelectedItem,
  renderLayout,
}) {
  const provider = config.providers[providerName];
  const models = provider.models || [];
  const section = document.createElement("div");
  section.className = "models-config-models-section";
  const header = document.createElement("div");
  header.className = "models-config-models-header";
  const title = document.createElement("h3");
  title.textContent = "Models";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "models-model-add ui-button ui-button--ghost ui-button--sm";
  addBtn.textContent = "+ Add model";
  addBtn.addEventListener("click", () => {
    setNewModelDraft({ id: "", provider: providerName });
    setSelectedItem({ type: "model-new", provider: providerName });
    renderLayout();
  });
  header.append(title, addBtn);
  section.appendChild(header);
  if (models.length === 0) {
    const empty = document.createElement("p");
    empty.className = "models-config-models-empty";
    empty.textContent = "No models configured yet.";
    section.appendChild(empty);
  } else {
    const list = document.createElement("ul");
    list.className = "models-config-models-list";
    for (const [index, model] of models.entries()) {
      const row = document.createElement("li");
      row.className = "models-config-models-row";
      const label = document.createElement("span");
      label.textContent = model.id || "(unnamed model)";
      const actions = document.createElement("div");
      actions.className = "models-config-models-row-actions";
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "ui-button ui-button--sm";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => {
        setSelectedItem({ type: "model", provider: providerName, index });
        renderLayout();
      });
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "ui-button ui-button--danger ui-button--sm";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => {
        if (!confirm(`Delete model “${model.id || "(unnamed model)"}”?`)) return;
        update(() => {
          provider.models.splice(index, 1);
        });
      });
      actions.append(editBtn, deleteBtn);
      row.append(label, actions);
      list.appendChild(row);
    }
    section.appendChild(list);
  }
  main.appendChild(section);
}

export function renderNewModelForm({
  main,
  config,
  providerName,
  update,
  getNewModelDraft,
  setNewModelDraft,
  setSelectedItem,
  renderLayout,
}) {
  let draft = getNewModelDraft();
  if (!draft) {
    draft = { id: "", provider: providerName };
    setNewModelDraft(draft);
  }
  const header = document.createElement("div");
  header.className = "models-config-detail-header";
  const eyebrow = document.createElement("span");
  eyebrow.className = "models-config-eyebrow";
  eyebrow.textContent = "New model";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ui-button ui-button--sm";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    setNewModelDraft(null);
    setSelectedItem({ type: "provider", provider: providerName });
    renderLayout();
  });
  header.append(eyebrow, cancel);

  const form = document.createElement("div");
  form.className = "models-config-form";
  const bindings = [
    ["Model ID", "id", "model-name"],
    ["Display name", "name", "Optional"],
    ["Context window", "contextWindow", "Optional"],
    ["Max tokens", "maxTokens", "Optional"],
  ];
  for (const [label, key, placeholder] of bindings) {
    const input = createModelsInput(draft[key], placeholder);
    if (key === "contextWindow" || key === "maxTokens") input.type = "number";
    input.addEventListener("input", () => {
      const value = input.value.trim();
      draft[key] = value
        ? key === "contextWindow" || key === "maxTokens"
          ? Number(value)
          : value
        : undefined;
    });
    form.appendChild(createModelsField(label, input));
  }
  const reasoning = document.createElement("input");
  reasoning.type = "checkbox";
  reasoning.checked = draft.reasoning === true;
  reasoning.addEventListener("change", () => {
    draft.reasoning = reasoning.checked || undefined;
  });
  form.appendChild(createModelsField("Reasoning model", reasoning));

  const error = document.createElement("p");
  error.className = "models-config-form-error";
  error.hidden = true;

  const save = document.createElement("button");
  save.type = "button";
  save.className = "ui-button ui-button--primary";
  save.textContent = "Add model";
  save.addEventListener("click", () => {
    const id = (draft.id || "").trim();
    if (!id) {
      error.textContent = "Model ID is required.";
      error.hidden = false;
      return;
    }
    update(() => {
      const provider = config.providers[providerName];
      provider.models ||= [];
      const modelDraft = { ...draft };
      delete modelDraft.provider;
      provider.models.push({ ...modelDraft, id });
      setNewModelDraft(null);
      setSelectedItem({
        type: "model",
        provider: providerName,
        index: provider.models.length - 1,
      });
    });
  });
  form.appendChild(error);
  form.appendChild(save);
  main.append(header, form);
}

export function renderModelConfigForm({
  main,
  config,
  providerName,
  index,
  update,
  inlineModelsTextarea,
  setSelectedItem,
}) {
  const model = config.providers[providerName].models[index];
  const header = document.createElement("div");
  header.className = "models-config-detail-header";
  const eyebrow = document.createElement("span");
  eyebrow.className = "models-config-eyebrow";
  eyebrow.textContent = "Model";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ui-button ui-button--danger ui-button--sm";
  remove.textContent = "Delete";
  remove.addEventListener("click", () =>
    update(() => {
      config.providers[providerName].models.splice(index, 1);
      setSelectedItem({ type: "provider", provider: providerName });
    }),
  );
  header.append(eyebrow, remove);

  const form = document.createElement("div");
  form.className = "models-config-form";
  const bindings = [
    ["Model ID", "id", "model-name"],
    ["Display name", "name", "Optional"],
    ["Context window", "contextWindow", "Optional"],
    ["Max tokens", "maxTokens", "Optional"],
  ];
  for (const [label, key, placeholder] of bindings) {
    const input = createModelsInput(model[key], placeholder);
    if (key === "contextWindow" || key === "maxTokens") input.type = "number";
    input.addEventListener("input", () => {
      const value = input.value.trim();
      model[key] = value
        ? key === "contextWindow" || key === "maxTokens"
          ? Number(value)
          : value
        : undefined;
      inlineModelsTextarea.value = JSON.stringify(config, null, 2);
      if (key === "id") {
        const item = document.querySelector(".models-model-item.selected");
        if (item) item.textContent = value || "New model";
      }
    });
    form.appendChild(createModelsField(label, input));
  }
  const reasoning = document.createElement("input");
  reasoning.type = "checkbox";
  reasoning.checked = model.reasoning === true;
  reasoning.addEventListener("change", () => {
    model.reasoning = reasoning.checked || undefined;
    inlineModelsTextarea.value = JSON.stringify(config, null, 2);
  });
  form.appendChild(createModelsField("Reasoning model", reasoning));
  main.append(header, form);
}
