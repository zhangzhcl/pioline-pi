// ABOUTME: Learns which extension slash commands need the real terminal.
// ABOUTME: Ported from pi-gui's per-workspace extension command compatibility.

// pi-gui classifies each extension command as "supported" or "terminal-only"
// the first time running it hits a host-UI capability the GUI cannot provide,
// then remembers that per workspace and badges the command in its slash menu.
//
// Picot learns the same thing from a different signal. pi-gui drives pi through
// the SDK and can throw from its own host UI; Picot talks to `pi --mode rpc`,
// where those capabilities are silent no-ops, so the report comes from the
// bridge extension instead (extensions/host-ui-capabilities.ts) and the command
// still runs to completion. That is the one deliberate difference from pi-gui:
// Picot badges and explains, it does not block the command.
//
// Attribution is a time window rather than a request id: an extension command
// executes immediately over RPC and its `prompt` response does not mark the end
// of the handler, so a report that lands shortly after a command was submitted
// is attributed to it.

const STORAGE_PREFIX = "picot-extension-command-compat";
/** How long after a submit a capability report still counts as that command's. */
const ATTRIBUTION_WINDOW_MS = 30_000;

/** Envelope key emitted by extensions/host-ui-capabilities.ts. */
export const HOST_UI_CAPABILITY_KEY = "__picotHostUi";

export function createCompatibilityKey(extensionPath, commandName) {
  return `${extensionPath}::${commandName}`;
}

export function commandPath(command) {
  return command?.sourceInfo?.path ?? command?.path ?? "";
}

/** Human-readable name for a `ctx.ui` capability, matching pi-gui's wording. */
export function capabilityLabel(capability) {
  switch (capability) {
    case "custom":
      return "custom UI";
    case "onTerminalInput":
      return "terminal input";
    case "setEditorComponent":
      return "custom editor UI";
    case "setFooter":
      return "footer UI";
    case "setHeader":
      return "header UI";
    default:
      return String(capability ?? "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase();
  }
}

export function commandUnsupportedCapabilityMessage(commandName, capability) {
  return `/${commandName} uses terminal-only ${capabilityLabel(capability)}, which Pipline cannot show. Run pi in a terminal for the full command.`;
}

/** Parse a bridged host-UI report; returns the capability or null. */
export function parseHostUiCapabilityFrame(message) {
  if (typeof message !== "string" || !message.includes(HOST_UI_CAPABILITY_KEY)) return null;
  let payload;
  try {
    payload = JSON.parse(message);
  } catch {
    return null;
  }
  const capability = payload?.[HOST_UI_CAPABILITY_KEY]?.capability;
  return typeof capability === "string" && capability ? capability : null;
}

export class ExtensionCommandCompatibility {
  #records = new Map();
  #pending = null;
  #storage;
  #storageKey;
  #now;
  #onLearn;

  constructor({
    workspaceId,
    storage = globalThis.localStorage,
    now = () => Date.now(),
    onLearn = () => {},
  } = {}) {
    this.#storage = storage ?? null;
    this.#storageKey = `${STORAGE_PREFIX}:${workspaceId ?? "default"}`;
    this.#now = now;
    this.#onLearn = onLearn;
    this.#restore();
  }

  #restore() {
    let raw;
    try {
      raw = this.#storage?.getItem(this.#storageKey);
    } catch {
      return;
    }
    if (!raw) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    for (const record of Array.isArray(parsed) ? parsed : []) {
      if (!record?.commandName || !record?.extensionPath) continue;
      this.#records.set(createCompatibilityKey(record.extensionPath, record.commandName), record);
    }
  }

  #persist() {
    try {
      this.#storage?.setItem(this.#storageKey, JSON.stringify([...this.#records.values()]));
    } catch {
      // A full or unavailable store only costs us the memory of past runs.
    }
  }

  /**
   * Note that a slash command was just submitted, so a capability report
   * arriving in its wake can be attributed to it. Submitting anything else
   * (a plain prompt, an unknown command) closes the window.
   */
  beginCommand(command) {
    this.#pending = command?.name ? { command, at: this.#now() } : null;
  }

  get(command) {
    if (!command?.name) return undefined;
    return this.#records.get(createCompatibilityKey(commandPath(command), command.name));
  }

  /**
   * Attach what has been learned to each catalog command. Called on every menu
   * render so a record learned mid-session shows up without reloading the
   * command catalog.
   */
  decorate(commands) {
    return Array.from(commands ?? [], (command) => {
      const compatibility = this.get(command);
      return compatibility ? { ...command, compatibility } : command;
    });
  }

  /**
   * Consume a bridged host-UI capability report. Returns true when the message
   * was one, so the caller keeps it out of the transcript.
   */
  consumeNotify(request) {
    const capability = parseHostUiCapabilityFrame(request?.message);
    if (!capability) return false;
    const pending = this.#pending;
    if (!pending || this.#now() - pending.at > ATTRIBUTION_WINDOW_MS) return true;

    const command = pending.command;
    const key = createCompatibilityKey(commandPath(command), command.name);
    const existing = this.#records.get(key);
    if (existing?.capability === capability) return true;

    const record = {
      commandName: command.name,
      extensionPath: commandPath(command),
      status: "terminal-only",
      capability,
      message: commandUnsupportedCapabilityMessage(command.name, capability),
      updatedAt: new Date(this.#now()).toISOString(),
    };
    this.#records.set(key, record);
    this.#persist();
    this.#onLearn(record);
    return true;
  }

  /**
   * Drop records for commands pi no longer reports — an uninstalled package or
   * a renamed command should not keep a stale badge forever.
   */
  prune(commands) {
    const live = new Set(
      Array.from(commands ?? [], (command) =>
        createCompatibilityKey(commandPath(command), command.name),
      ),
    );
    let changed = false;
    for (const key of [...this.#records.keys()]) {
      if (live.has(key)) continue;
      this.#records.delete(key);
      changed = true;
    }
    if (changed) this.#persist();
  }
}
