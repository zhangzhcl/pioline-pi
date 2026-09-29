const BLOCKING_METHODS = new Set(["select", "confirm", "input", "editor"]);

export class ExtensionUiHost {
  #foregroundSessionId = null;
  #hooks;
  #queues = new Map();
  #inFlight = new Map(); // sessionId → { abort(), target, request }
  #runtime;
  #showDialog;
  #showInlinePrompt;

  constructor({
    runtime,
    showDialog = async () => ({ cancelled: true }),
    showInlinePrompt = () => null,
    hooks = {},
  }) {
    this.#runtime = runtime;
    this.#showDialog = showDialog;
    this.#showInlinePrompt = showInlinePrompt;
    this.#hooks = hooks;
  }

  pendingCount(sessionId) {
    return this.#queues.get(sessionId)?.length ?? 0;
  }

  /**
   * True when there is a blocking dialog either queued (background session)
   * or actively shown (foreground session) for the given session id. Used to
   * keep the Stop/Abort control visible even if a status frame lags behind
   * an open extension question.
   *
   * @param {string} sessionId
   */
  hasPending(sessionId) {
    return this.pendingCount(sessionId) > 0 || this.#inFlight.has(sessionId);
  }

  /**
   * Force-resolve the currently shown foreground dialog as cancelled — used
   * when the user hits Stop/Abort so a blocked tool call actually receives a
   * response instead of hanging forever. Unlike setForegroundSession()'s
   * abort (which re-queues the dialog for later), this finalizes it.
   */
  cancelForeground() {
    const sessionId = this.#foregroundSessionId;
    const inFlight = this.#inFlight.get(sessionId);
    if (inFlight) inFlight.abort({ cancel: true });

    const queue = this.#queues.get(sessionId) ?? [];
    this.#queues.delete(sessionId);
    for (const pending of queue) {
      this.#runtime
        .request(
          { type: "extension_ui_response", id: pending.request.id, cancelled: true },
          pending.target,
        )
        .catch(() => {});
    }
  }

  /**
   * Move the currently displayed foreground prompt back into the foreground
   * queue without answering it. Call this before a full chat history re-render:
   * renderHistory() clears the messages container, so an inline prompt that is
   * still in-flight would otherwise lose its clickable DOM while the tool call
   * stays blocked forever.
   *
   * @returns {boolean} true when an in-flight prompt was asked to re-queue.
   */
  requeueForegroundPrompt() {
    const sessionId = this.#foregroundSessionId;
    const inFlight = this.#inFlight.get(sessionId);
    if (!inFlight) return false;
    this.#requeueInFlight(sessionId, inFlight);
    return true;
  }

  /**
   * Switch the foreground session and abort any in-flight dialog for the
   * previous session (re-queuing it).
   *
   * @param {string} sessionId
   * @param {{ flush?: boolean }} [options]
   *   flush (default true) — drain the new session’s queue immediately.
   *   Pass { flush: false } from adoptTarget() so that renderHistory() can
   *   clear the messages container before the inline card is inserted; then
   *   call flushForegroundQueue() after the final render pass.
   */
  async setForegroundSession(sessionId, { flush = true } = {}) {
    const oldId = this.#foregroundSessionId;
    this.#foregroundSessionId = sessionId;
    // Abort any in-flight dialog for the previous session so it gets re-queued
    // and shown again when the user returns to that session.
    if (oldId && oldId !== sessionId) {
      const inFlight = this.#inFlight.get(oldId);
      if (inFlight) this.#requeueInFlight(oldId, inFlight);
    }
    if (flush) await this.flushForegroundQueue();
  }

  #requeueInFlight(sessionId, inFlight) {
    const queue = this.#queues.get(sessionId) ?? [];
    queue.unshift({
      target: structuredClone(inFlight.target),
      request: structuredClone(inFlight.request),
    });
    this.#queues.set(sessionId, queue);
    // Queue synchronously before dismissing the old DOM. The prompt's dismiss
    // path can settle asynchronously; waiting for it used to let a rapid
    // switch back flush an empty queue and strand the request afterward.
    inFlight.abort({ cancel: false, requeuedNow: true });
  }

  /**
   * Drain queued prompts for the current foreground session.
   * Call this AFTER the final renderHistory() so inline cards are not
   * immediately destroyed by a subsequent clear().
   */
  async flushForegroundQueue() {
    // Yield a microtask so any abort-triggered re-queues can land first.
    await Promise.resolve();
    const sessionId = this.#foregroundSessionId;
    if (!sessionId) return;
    const queue = this.#queues.get(sessionId) ?? [];
    this.#queues.delete(sessionId);
    for (const pending of queue) await this.#showAndRespond(pending.target, pending.request);
  }

  async handle(target, request) {
    if (request?.type !== "extension_ui_request" || !request.id || !request.method) return;
    if (BLOCKING_METHODS.has(request.method)) {
      if (target.sessionId !== this.#foregroundSessionId) {
        const queue = this.#queues.get(target.sessionId) ?? [];
        queue.push({ target: structuredClone(target), request: structuredClone(request) });
        this.#queues.set(target.sessionId, queue);
        return;
      }
      await this.#showAndRespond(target, request);
      return;
    }
    switch (request.method) {
      case "notify":
        this.#hooks.notify?.(request);
        break;
      case "setStatus":
        this.#hooks.status?.(request);
        break;
      case "setWidget":
        this.#hooks.widget?.(request);
        break;
      case "setTitle":
        this.#hooks.title?.(request);
        break;
      case "set_editor_text":
        this.#hooks.editorText?.(request);
        break;
      case "workflow":
        if (typeof this.#hooks.workflow === "function") {
          let result;
          try {
            result = await this.#hooks.workflow(request);
          } catch (error) {
            result = { cancelled: true, error: error?.message || String(error) };
          }
          await this.#runtime.request(
            { type: "extension_ui_response", id: request.id, ...result },
            target,
          );
        }
        break;
      default:
        await this.#runtime.request(
          {
            type: "extension_ui_response",
            id: request.id,
            cancelled: true,
            error: "unsupported",
          },
          target,
        );
    }
  }

  async cancelSession(target) {
    const queue = this.#queues.get(target.sessionId) ?? [];
    this.#queues.delete(target.sessionId);
    for (const pending of queue) {
      await this.#runtime.request(
        { type: "extension_ui_response", id: pending.request.id, cancelled: true },
        pending.target,
      );
    }
  }

  async #showAndRespond(target, request) {
    // Create a dismiss signal so an external abort can resolve the dialog.
    let triggerDismiss;
    const dismissSignal = new Promise((resolve) => {
      triggerDismiss = resolve;
    });
    // Track whether this dialog was aborted because the session switched
    // away (re-queue for later) or explicitly cancelled (finalize now — e.g.
    // the user hit Stop/Abort).
    let disposition = "respond";
    const inFlight = {
      target: structuredClone(target),
      request: structuredClone(request),
      abort: ({ cancel = false, requeuedNow = false } = {}) => {
        disposition = requeuedNow ? "requeuedNow" : cancel ? "respond" : "requeueAfter";
        triggerDismiss();
      },
    };
    this.#inFlight.set(target.sessionId, inFlight);
    let result;
    try {
      const inlineResult = this.#showInlinePrompt(structuredClone(request), { dismissSignal });
      result = inlineResult
        ? await inlineResult
        : await this.#showDialog(structuredClone(request), { dismissSignal });
    } catch {
      result = { cancelled: true };
    }
    if (this.#inFlight.get(target.sessionId) === inFlight) {
      this.#inFlight.delete(target.sessionId);
    }
    if (disposition === "requeuedNow") return;
    if (disposition === "requeueAfter") {
      // Re-queue the request; it will be shown when the session regains focus.
      const queue = this.#queues.get(target.sessionId) ?? [];
      queue.unshift({ target: structuredClone(target), request: structuredClone(request) });
      this.#queues.set(target.sessionId, queue);
      return;
    }
    const response = {
      type: "extension_ui_response",
      id: request.id,
      ...(result && typeof result === "object" ? result : { cancelled: true }),
    };
    await this.#runtime.request(response, target);
  }
}
