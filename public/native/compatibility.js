// ABOUTME: Small WebKit compatibility shims for the macOS 11 minimum target.
// Load before application scripts so older WKWebView builds can use the same
// app code as current Chromium and Safari releases.

(() => {
  if (typeof Object.hasOwn !== "function") {
    Object.defineProperty(Object, "hasOwn", {
      configurable: true,
      writable: true,
      value(object, key) {
        if (object === null || object === undefined)
          throw new TypeError("Object.hasOwn called on null or undefined");
        return Object.getOwnPropertyDescriptor(Object(object), key) !== undefined;
      },
    });
  }

  if (typeof Array.prototype.at !== "function") {
    Object.defineProperty(Array.prototype, "at", {
      configurable: true,
      writable: true,
      value(index) {
        const integer = Math.trunc(Number(index) || 0);
        const normalized = integer < 0 ? this.length + integer : integer;
        return normalized < 0 || normalized >= this.length ? undefined : this[normalized];
      },
    });
  }

  if (typeof globalThis.structuredClone !== "function") {
    globalThis.structuredClone = function structuredClone(value) {
      const visited = new Map();

      function copy(input) {
        if (input === null || (typeof input !== "object" && typeof input !== "function")) {
          if (typeof input === "symbol" || typeof input === "function")
            throw new TypeError("Value cannot be cloned");
          return input;
        }
        if (visited.has(input)) return visited.get(input);

        if (input instanceof Date) return new Date(input.getTime());
        if (input instanceof RegExp) {
          const result = new RegExp(input.source, input.flags);
          result.lastIndex = input.lastIndex;
          return result;
        }
        if (input instanceof ArrayBuffer) return input.slice(0);
        if (ArrayBuffer.isView(input)) {
          const buffer = copy(input.buffer);
          return input instanceof DataView
            ? new DataView(buffer, input.byteOffset, input.byteLength)
            : new input.constructor(buffer, input.byteOffset, input.length);
        }
        if (input instanceof Map) {
          const result = new Map();
          visited.set(input, result);
          for (const [key, entry] of input) result.set(copy(key), copy(entry));
          return result;
        }
        if (input instanceof Set) {
          const result = new Set();
          visited.set(input, result);
          for (const entry of input) result.add(copy(entry));
          return result;
        }
        if (Array.isArray(input)) {
          const result = [];
          visited.set(input, result);
          for (let index = 0; index < input.length; index += 1) {
            if (index in input) result[index] = copy(input[index]);
            else result.length += 1;
          }
          return result;
        }

        const prototype = Object.getPrototypeOf(input);
        if (prototype !== Object.prototype && prototype !== null)
          throw new TypeError("Value cannot be cloned");
        const result = prototype === null ? Object.create(null) : {};
        visited.set(input, result);
        for (const key of Object.keys(input)) {
          Object.defineProperty(result, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: copy(input[key]),
          });
        }
        return result;
      }

      return copy(value);
    };
  }

  function markCompactSettingsRows(root) {
    const rows = [];
    if (root instanceof Element && root.matches(".settings-row")) rows.push(root);
    if (root.querySelectorAll) rows.push(...root.querySelectorAll(".settings-row"));
    for (const row of rows) {
      const hasControl = row.querySelector(
        ":scope > .settings-toggle, :scope > .settings-value-btn",
      );
      row.classList.toggle("settings-row--compact-controls", Boolean(hasControl));
    }
  }

  const observeSettingsRows = () => {
    markCompactSettingsRows(document);
    if (typeof MutationObserver !== "function" || !document.body) return;
    new MutationObserver((records) => {
      for (const record of records) {
        const parentRow = record.target.closest?.(".settings-row");
        if (parentRow) markCompactSettingsRows(parentRow);
        for (const node of record.addedNodes) {
          if (node instanceof Element) markCompactSettingsRows(node);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", observeSettingsRows, { once: true });
  else observeSettingsRows();
})();
