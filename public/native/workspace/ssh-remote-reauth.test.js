import { beforeEach, describe, expect, it, vi } from "vitest";

import { isProjectDisconnected, markProjectConnected } from "./project-connection-status.js";
import {
  createSshAuthFailureHandler,
  isSshAuthFailureMessage,
  isSshProjectDisconnectedMessage,
  SSH_AUTH_REQUIRED_MARKER,
  SSH_PROJECT_DISCONNECTED_MARKER,
} from "./ssh-remote-reauth.js";

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("isSshAuthFailureMessage", () => {
  it("matches a message tagged with the marker", () => {
    expect(isSshAuthFailureMessage(`Permission denied. ${SSH_AUTH_REQUIRED_MARKER}`)).toBe(true);
  });

  it("ignores an ordinary failure with no marker", () => {
    expect(isSshAuthFailureMessage("Could not resolve hostname")).toBe(false);
  });

  it("ignores non-string input", () => {
    expect(isSshAuthFailureMessage(undefined)).toBe(false);
    expect(isSshAuthFailureMessage(null)).toBe(false);
  });
});

describe("isSshProjectDisconnectedMessage", () => {
  it("matches a message tagged with the marker", () => {
    expect(isSshProjectDisconnectedMessage(`timed out. ${SSH_PROJECT_DISCONNECTED_MARKER}`)).toBe(
      true,
    );
  });

  it("ignores an ordinary failure with no marker", () => {
    expect(isSshProjectDisconnectedMessage("disk is full")).toBe(false);
  });
});

describe("createSshAuthFailureHandler", () => {
  function binding(overrides = {}) {
    return { enabled: true, host: "10.0.0.5", remotePath: "/srv/app", ...overrides };
  }

  beforeEach(() => {
    markProjectConnected("/repo/one");
  });

  it("ignores a notify that is not an error", () => {
    const dialog = { open: vi.fn(), isOpen: () => false };
    const handle = createSshAuthFailureHandler({ call: vi.fn(), dialog });
    expect(handle({ notifyType: "info", message: SSH_AUTH_REQUIRED_MARKER })).toBe(false);
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it("ignores an error notify with no marker at all", () => {
    const dialog = { open: vi.fn(), isOpen: () => false };
    const handle = createSshAuthFailureHandler({ call: vi.fn(), dialog });
    expect(handle({ notifyType: "error", message: "disk is full" })).toBe(false);
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it("records the project as disconnected but does not open the dialog for a project-only marker", async () => {
    const call = vi.fn();
    const dialog = { open: vi.fn(), isOpen: () => false };
    const handle = createSshAuthFailureHandler({
      call,
      dialog,
      getProjectPath: () => "/repo/one",
    });
    const handled = handle({
      notifyType: "error",
      message: `could not connect. ${SSH_PROJECT_DISCONNECTED_MARKER}`,
    });
    expect(handled).toBe(true);
    await flushMicrotasks();
    expect(call).not.toHaveBeenCalled();
    expect(dialog.open).not.toHaveBeenCalled();
    expect(isProjectDisconnected("/repo/one")).toBe(true);
  });

  it("reopens the dialog on the project's current binding, prefilled, when auth is required", async () => {
    const call = vi.fn(async (op) => {
      expect(op).toBe("get_ssh_remote_config");
      return { ok: true, data: { config: binding({ hostRef: "gpu-box" }) } };
    });
    const dialog = { open: vi.fn(), isOpen: () => false };
    const handle = createSshAuthFailureHandler({
      call,
      dialog,
      getProjectPath: () => "/repo/one",
      reauthMessage: () => "reconnect please",
    });
    const handled = handle({
      notifyType: "error",
      message: `Permission denied. ${SSH_PROJECT_DISCONNECTED_MARKER} ${SSH_AUTH_REQUIRED_MARKER}`,
    });
    expect(handled).toBe(true);
    await flushMicrotasks();
    expect(dialog.open).toHaveBeenCalledWith({
      prefill: binding({ hostRef: "gpu-box" }),
      statusMessage: "reconnect please",
      projectPath: "/repo/one",
    });
    expect(isProjectDisconnected("/repo/one")).toBe(true);
  });

  it("does not reopen when the project is not (or no longer) ssh-remote enabled", async () => {
    const call = vi.fn(async () => ({ ok: true, data: { config: { enabled: false } } }));
    const dialog = { open: vi.fn(), isOpen: () => false };
    const handle = createSshAuthFailureHandler({ call, dialog });
    handle({ notifyType: "error", message: SSH_AUTH_REQUIRED_MARKER });
    await flushMicrotasks();
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it("does not reopen when the dialog is already open", () => {
    const call = vi.fn();
    const dialog = { open: vi.fn(), isOpen: () => true };
    const handle = createSshAuthFailureHandler({ call, dialog });
    const handled = handle({ notifyType: "error", message: SSH_AUTH_REQUIRED_MARKER });
    expect(handled).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it("swallows a config-channel failure without throwing", async () => {
    const call = vi.fn(async () => {
      throw new Error("no runtime");
    });
    const dialog = { open: vi.fn(), isOpen: () => false };
    const handle = createSshAuthFailureHandler({ call, dialog });
    handle({ notifyType: "error", message: SSH_AUTH_REQUIRED_MARKER });
    await flushMicrotasks();
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it("does not reopen a second time inside the cooldown window", async () => {
    const call = vi.fn(async () => ({ ok: true, data: { config: binding() } }));
    const dialog = { open: vi.fn(), isOpen: () => false };
    const handle = createSshAuthFailureHandler({ call, dialog, cooldownMs: 10_000 });
    handle({ notifyType: "error", message: SSH_AUTH_REQUIRED_MARKER });
    handle({ notifyType: "error", message: SSH_AUTH_REQUIRED_MARKER });
    await flushMicrotasks();
    expect(call).toHaveBeenCalledTimes(1);
  });
});
