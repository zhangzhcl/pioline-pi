import { t } from "../../i18n.js";

function commandInvocation(command) {
  const name = command?.name ?? command?.command ?? "";
  if (!name) return "";
  return name.startsWith("/") ? name : `/${name}`;
}

export function titleCaseCommandName(name) {
  return String(name ?? "")
    .replace(/^\//, "")
    .replace(/^skill:/, "")
    .split(/[-_:\s/]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function activeSlashQuery(input) {
  const cursor = input.selectionStart ?? input.value.length;
  const beforeCursor = input.value.slice(0, cursor);
  const match = beforeCursor.match(/^\/([^\s/]*)$/);
  if (!match) return null;
  return { query: match[1].toLowerCase(), end: cursor };
}

function scopeLabel(scope) {
  if (scope === "project") return "Project";
  if (scope === "temporary") return "Temporary";
  if (scope === "picot") return "Pipline";
  return "Personal";
}

/**
 * Where a command comes from: the providing package when pi reports one
 * (`npm:pi-web-access` → `pi-web-access`), otherwise the scope it was loaded
 * from (Personal/Project/Temporary) or Pipline for built-ins.
 */
export function originLabel(command) {
  if (command?.type === "builtin") return "Pipline";
  const source = command?.sourceInfo?.source;
  if (typeof source === "string") {
    if (source.startsWith("npm:")) return source.slice(4);
    if (source === "inline") return "Inline";
  }
  return scopeLabel(command?.sourceInfo?.scope ?? command?.scope);
}

/**
 * Command groups rendered in the menu, in display order. Extension and prompt
 * commands come from pi's `get_commands` catalog the same way skills do, so
 * the menu lists everything a user can actually invoke over RPC — built-in TUI
 * commands are never reported by pi and internal data planes are filtered out
 * of the catalog (see slash-commands.js).
 */
const MENU_GROUPS = ["skill", "extension", "prompt"];

function commandGroup(command) {
  if (command.type === "skill" || command.source === "skill") return "skill";
  if (command.type === "extension" || command.source === "extension") return "extension";
  if (command.type === "prompt" || command.source === "prompt") return "prompt";
  if (command.type === "builtin") return "builtin";
  return "other";
}

function typeLabel(command) {
  const group = commandGroup(command);
  if (group === "skill") return "Skill";
  if (group === "extension") return "Extension";
  if (group === "prompt") return "Prompt";
  if (group === "builtin") return "Pipline";
  return "Command";
}

function groupLabel(group) {
  if (group === "extension") return t("migrated.index.text.extensions");
  if (group === "prompt") return t("migrated.index.text.prompts");
  return t("migrated.index.text.skills");
}

function cubeIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 2.8 8 4.6v9.2l-8 4.6-8-4.6V7.4l8-4.6Z" />
      <path d="m4.3 7.6 7.7 4.5 7.7-4.5M12 12.1v8.7M8 5.1l8 4.6" />
    </svg>`;
}

function puzzleIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.2 3.4a1.8 1.8 0 0 1 3.6 0V5h2.9c.6 0 1 .5 1 1v2.9h1.6a1.8 1.8 0 0 1 0 3.6h-1.6V17c0 .6-.4 1-1 1h-2.9v-1.6a1.8 1.8 0 0 0-3.6 0V18H7.3c-.6 0-1-.4-1-1v-2.9H4.7a1.8 1.8 0 0 1 0-3.6h1.6V7.6c0-.6.4-1 1-1h2.9V3.4Z" />
    </svg>`;
}

function pageIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4Z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </svg>`;
}

function commandIcon(command) {
  const group = commandGroup(command);
  if (group === "extension") return puzzleIcon();
  if (group === "prompt") return pageIcon();
  return cubeIcon();
}

/**
 * True when the command is known to need the real terminal — pi-gui calls this
 * "terminal-only". Pipline learns it the first time a command's TUI surface fails
 * to render in the WebView (see extensions/extension-command-compatibility.js).
 */
export function isTerminalOnly(command) {
  return command?.compatibility?.status === "terminal-only";
}

function isMenuCommand(command) {
  return MENU_GROUPS.includes(commandGroup(command));
}

/**
 * Order matches so a command whose name literally starts with the query wins
 * over one that only matched fuzzily (on its description, package, or scope),
 * and so the group holding such a match is listed first. Without this an
 * installed skill steals `/tod` from the `todos` extension command purely
 * because skills are rendered before extensions.
 */
export function orderSlashMatches(matches, query) {
  const isPrefix = (command) =>
    query && command.command.slice(1).toLowerCase().startsWith(query) ? 0 : 1;
  const groupsWithPrefix = new Set(
    matches.filter((command) => isPrefix(command) === 0).map((command) => command.group),
  );
  const groupRank = (command) =>
    MENU_GROUPS.indexOf(command.group) +
    (groupsWithPrefix.size > 0 && !groupsWithPrefix.has(command.group) ? MENU_GROUPS.length : 0);
  return matches
    .map((command, index) => ({ command, index }))
    .sort(
      (a, b) =>
        groupRank(a.command) - groupRank(b.command) ||
        isPrefix(a.command) - isPrefix(b.command) ||
        a.index - b.index,
    )
    .map((entry) => entry.command);
}

function normalizeCommands(commands) {
  return Array.from(commands ?? [])
    .filter(isMenuCommand)
    .map((command) => ({
      ...command,
      command: commandInvocation(command),
      group: commandGroup(command),
    }))
    .filter((command) => command.command && command.capabilityState !== "disabled")
    .sort((a, b) => MENU_GROUPS.indexOf(a.group) - MENU_GROUPS.indexOf(b.group));
}

export function setupComposerSlashMenu({ input, container, commandButton = null, getCommands }) {
  if (!input || !container) return { close() {}, update() {}, openAll() {} };

  let matches = [];
  let selectedIndex = 0;
  let open = false;
  let updateGeneration = 0;

  container.setAttribute("role", "listbox");
  container.setAttribute(
    "aria-label",
    t("migrated.native.composer.composerSlashMenu.ariaLabel.slashCommands"),
  );
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", container.id);
  input.setAttribute("aria-expanded", "false");

  function close() {
    updateGeneration += 1;
    open = false;
    matches = [];
    selectedIndex = 0;
    container.classList.add("hidden");
    container.innerHTML = "";
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-expanded", "false");
  }

  function ensureSlashQuery() {
    const slash = activeSlashQuery(input);
    if (slash) return slash;
    if (input.value.trim().length === 0) {
      input.value = "/";
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return { query: "", end: 1 };
    }
    return null;
  }

  function select(index) {
    const command = matches[index];
    const slash = activeSlashQuery(input);
    if (!command || !slash) return;
    const suffix = input.value.slice(slash.end);
    const invocation = command.command;
    input.value = `${invocation} ${suffix}`;
    input.setSelectionRange(invocation.length + 1, invocation.length + 1);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    close();
  }

  function updateSelection() {
    const options = container.querySelectorAll(".skill-slash-option");
    options.forEach((option, index) => {
      const selected = index === selectedIndex;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-selected", String(selected));
    });
    if (matches.length > 0) {
      input.setAttribute("aria-activedescendant", `skill-slash-option-${selectedIndex}`);
      options[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }

  function commandMatches(command, query) {
    if (!query) return true;
    return [
      command.name,
      command.command,
      command.description,
      titleCaseCommandName(command.name),
      typeLabel(command),
      originLabel(command),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  }

  function render() {
    const slash = activeSlashQuery(input);
    if (!slash) {
      close();
      return;
    }

    matches = orderSlashMatches(
      normalizeCommands(getCommands()).filter((command) => commandMatches(command, slash.query)),
      slash.query,
    );
    selectedIndex = Math.min(selectedIndex, Math.max(matches.length - 1, 0));

    container.innerHTML = "";

    if (matches.length === 0) {
      const heading = document.createElement("div");
      heading.className = "skill-slash-heading";
      heading.textContent = t("migrated.index.text.skills");
      container.appendChild(heading);
      const empty = document.createElement("div");
      empty.className = "skill-slash-empty";
      empty.textContent = t(
        "migrated.native.composer.composerSlashMenu.textcontent.noMatchingCommands",
      );
      container.appendChild(empty);
    } else {
      let renderedGroup = null;
      matches.forEach((command, index) => {
        if (command.group !== renderedGroup) {
          renderedGroup = command.group;
          const heading = document.createElement("div");
          heading.className = "skill-slash-heading";
          heading.setAttribute("role", "presentation");
          heading.textContent = groupLabel(renderedGroup);
          container.appendChild(heading);
        }
        const option = document.createElement("button");
        option.type = "button";
        option.id = `skill-slash-option-${index}`;
        option.className = "skill-slash-option";
        option.classList.toggle("selected", index === selectedIndex);
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === selectedIndex));
        option.innerHTML = `
          <span class="skill-slash-icon">${commandIcon(command)}</span>
          <span class="skill-slash-name"></span>
          <span class="skill-slash-description"></span>
          <span class="skill-slash-badge"></span>
          <span class="skill-slash-scope"></span>`;
        option.querySelector(".skill-slash-name").textContent = titleCaseCommandName(command.name);
        option.querySelector(".skill-slash-description").textContent =
          command.description || typeLabel(command);
        const badge = option.querySelector(".skill-slash-badge");
        if (isTerminalOnly(command)) {
          badge.textContent = t(
            "migrated.native.composer.composerSlashMenu.textcontent.terminalOnly",
          );
          badge.title = command.compatibility?.message || badge.textContent;
        }
        const origin = option.querySelector(".skill-slash-scope");
        origin.textContent = originLabel(command);
        origin.title = command.sourceInfo?.path || command.path || origin.textContent;
        option.addEventListener("mouseenter", () => {
          selectedIndex = index;
          updateSelection();
        });
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("click", () => select(index));
        container.appendChild(option);
      });
    }

    open = true;
    container.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    updateSelection();
  }

  async function update() {
    const generation = ++updateGeneration;
    if (!activeSlashQuery(input)) {
      close();
      return;
    }
    await Promise.resolve();
    if (generation === updateGeneration && activeSlashQuery(input)) render();
  }

  async function openAll() {
    if (!ensureSlashQuery()) return;
    await update();
    input.focus();
  }

  input.addEventListener("input", update);
  input.addEventListener("click", update);
  input.addEventListener(
    "keydown",
    (event) => {
      const isImeComposing = event.isComposing || event.keyCode === 229;
      if (isImeComposing) return;
      if (event.key === "Escape" && (open || activeSlashQuery(input))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (!open) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (matches.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        selectedIndex = (selectedIndex + delta + matches.length) % matches.length;
        updateSelection();
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && matches.length > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        select(selectedIndex);
      }
    },
    { capture: true },
  );
  input.addEventListener("blur", () => queueMicrotask(close));
  commandButton?.addEventListener("click", () => openAll());

  return { close, update, openAll };
}
