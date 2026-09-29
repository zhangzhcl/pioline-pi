# ADR 0001: Pipline platform and Pi runtime

- Status: Accepted
- Date: 2026-09-26

## Context

Pipline must keep Pi as the coding agent while shipping a self-contained desktop app on Windows 10 and macOS 11.0+. Pi configuration, auth, sessions, and extensions should remain compatible with a user's existing Pi setup. Building a new shell and RPC host before proving Pi integration would duplicate mature desktop infrastructure.

## Decisions

1. Start from the MIT-licensed Picot Tauri desktop app and preserve its LICENSE and upstream attribution.
2. Keep Pi as a separate managed `pi --mode rpc` process. Use the official Pi release runtime bundled with the application; do not require a system Pi or Node installation.
3. Reuse `~/.pi/agent` for Pi-owned data. Store Pipline workflow state separately in Pipline's app data directory.
4. Target Windows 10 x64 and macOS 11.0+ on Apple Silicon and Intel. Build and package each OS natively; macOS arm64 and x64 may be separate packages.
5. Defer Apple Developer ID setup and notarization. This does not block development or internal packaging.
6. Keep React Flow and workflow-only code out of ordinary chat initialization; add them as a lazy workflow module in a later milestone.
7. Do not use `pi-harness-runtime` as a general DAG event SDK and do not import source from the AGPL Pi-Harness desktop repository.
8. Treat macOS 11's WKWebView as the supported frontend baseline: bundle ES Module Shims for import maps, transpile all browser source modules and vendor bundles for Safari 14, remove top-level await from app entry modules, and load API/CSS compatibility shims before app code. Do not depend on APIs first shipped after Safari 14 without a local polyfill or a non-API fallback.

## Consequences

- Existing Pi sessions and credentials can be opened without migration, but Pipline must never overwrite or silently mutate Pi settings.
- Runtime download/cache assets are platform-specific. Build jobs need a matching Pi binary for the target OS and architecture.
- Windows continues to bundle the official Pi 0.85.1 compiled runtime. The official macOS Pi binary is built with a macOS 13 minimum and cannot satisfy the macOS 11 product floor, so macOS bundles the official Pi npm distribution and its RPC-capable Node entrypoint with the official Node.js 22 LTS runtime. The bundled Node 22.23.3 x64 and arm64 executables declare macOS 11.0 as their minimum; both archives are SHA-256 pinned. The app still starts the same `pi --mode rpc` CLI through a local launcher, with no system Node dependency.
- macOS bundles declare 11.0 as their minimum OS; the release pipeline must continue to build under that deployment target.
- macOS 11.0's initial WKWebView does not guarantee Safari 16.4 import maps, Safari 15.4 `structuredClone`/`Object.hasOwn`/`:has()`, Safari 14.1 private fields, or Safari 15 top-level await. The app must ship its module, syntax, API, and CSS compatibility layer locally; it must not download polyfills at first launch.
- Local macOS packages are internal artifacts until a signed/notarized distribution decision is made.
- Picot implementation details and internal protocol identifiers remain until replaced deliberately; user-visible product strings and package identity are Pipline.

## Source

- Picot upstream: https://github.com/shixin-guo/picot
- Pi project: https://github.com/earendil-works/pi
- Pi-Harness AGPL repository (excluded): https://github.com/wangmiaozero/pi-harness
