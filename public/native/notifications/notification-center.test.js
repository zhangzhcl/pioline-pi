import { describe, expect, test, vi } from "vitest";
import { createNotificationCenter } from "./notification-center.js";

describe("notification center", () => {
  test("renders dismissible error notifications", () => {
    const center = createNotificationCenter({ duration: 0 });

    const notification = center.notify({
      type: "error",
      title: "Uninstall failed",
      message: "Pipline could not remove this extension package.",
      detail: "Permission denied in ~/.pi/agent/npm.",
    });

    expect(document.querySelector(".native-notification-stack")).not.toBeNull();
    expect(notification.element.getAttribute("role")).toBe("alert");
    expect(notification.element.textContent).toContain("Uninstall failed");
    expect(notification.element.textContent).toContain("Permission denied");

    notification.element.querySelector("button")?.click();

    expect(document.querySelector(".native-notification-stack")).toBeNull();
  });

  test("auto dismisses notifications after the configured duration", () => {
    vi.useFakeTimers();
    const center = createNotificationCenter({ duration: 100 });

    center.notify("Saved");
    expect(document.querySelector(".native-notification")).not.toBeNull();

    vi.advanceTimersByTime(100);

    expect(document.querySelector(".native-notification")).toBeNull();
    vi.useRealTimers();
  });
});
