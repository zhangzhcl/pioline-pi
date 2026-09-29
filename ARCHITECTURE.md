# Pipline architecture

This document is the implementation map for contributors. `CONTEXT.md` records
product-wide decisions; the ADRs below define detailed contracts. When code and
this summary disagree, inspect the owning implementation and update this file
and the relevant ADR as part of the same change.

## Product and platform boundary

- Pipline is a Tauri v2 desktop application based on MIT-licensed Picot. Keep
  Picot attribution and `LICENSE`; product identity and packages are Pipline.
- First-release targets are Windows 10 x64 and macOS 11.0+ on Apple Silicon and
  Intel. Build separate macOS architecture packages unless a universal build
  is proven for every embedded native dependency.
- Ship Pi with each installer. The application must not depend on globally
  installed Pi, Node, Bun, or a shell-provided runtime. Pi launch resolution
  always uses the app-bundled runtime and ignores `PI_BIN`; PATH is available
  only to Pi child tools and never selects the Pi executable itself.
- Reuse Pi-owned data in `~/.pi/agent` (or the explicit
  `PI_CODING_AGENT_DIR` override). Keep Pipline workflows and UI preferences in
  Pipline's application data store.
- Apple Developer ID, notarization, and Mac App Store delivery are separate
  release decisions and are not development prerequisites.

## Runtime and transport

```text
Tauri WebView(s)
  ├─ chat UI: public/native/app.js
  └─ workflow UI: lazy standalone route and canvas bundle
             │ HTTP/WebSocket over 127.0.0.1
             ▼
Rust HostServer (`/v2/ws`, bootstrap/data APIs, static assets)
             │ Pi RPC frames over child stdin/stdout
             ▼
Bundled Pi `--mode rpc` process
```

- Rust owns process lifecycle, workspace routing, local HTTP/WebSocket serving,
  persistence, and runtime supervision. The frontend does not implement Pi
  agent logic.
- Windows uses the locked, compiled Pi runtime. macOS uses the official Pi npm
  CLI bundle with its checksum-pinned Node 22 runtime because the compiled Pi
  macOS executable does not meet the macOS 11 deployment floor. Both launch
  the same Pi RPC interface; see [ADR 0001](docs/adr/0001-platform-and-pi-runtime.md).
- The Host listens on its configured LAN-accessible interface for the remote
  client feature, while bundled WebViews use the loopback origin. Keep remote
  device authorization and route policy in `host_server.rs`, `host_router.rs`,
  and `remote_auth.rs`; do not assume that binding the Host to loopback is the
  security boundary.
- Pi credentials, settings, sessions, and extensions remain Pi-owned. Resolve
  their root once through `pi_agent_dir.rs` and pass the same value to Host
  discovery and the embedded Pi process. Resolve the default workspace home
  independently.
- On Windows, preserve Pi's native `bash` tool when the effective project or
  global `shellPath`, discovered Git Bash, or a usable PATH `bash.exe` exists.
  If none exists, pass a per-process flag that lets the bundled bridge activate
  Pi's native `powershell` tool in place of `bash`, preserving the rest of the
  active tool set. This does not edit `~/.pi/agent/settings.json`; macOS and
  Windows systems with Bash keep Pi's normal tool configuration. Pi's `!`
  terminal editor command remains governed by Pi and is outside this fallback.
- The pinned upstream Pi runtime does not provide built-in MCP support. MCP
  integrations must come from an installed Pi extension/package under the
  reused Pi configuration. Pipline's bundled `picot-bridge` forwards supported
  custom extension UI into the WebView; extension features that require
  terminal-only UI are reported as incompatible instead of being presented as
  working desktop controls. M0/M1 acceptance must identify the configured MCP
  extension and test its actual tool path; a successful Pi RPC smoke alone is
  not evidence of MCP support.

## State ownership and workflow flow

- `MetadataStore` in Rust/SQLite is authoritative for Pipline workflows,
  versioned NodeMeta templates, Run snapshots, ordered Run events, and global
  `ui.*` display preferences. WebViews keep view state only and update workflow
  definitions through revision/CAS operations.
- Chat and standalone workflow windows use the same Host and workspace data.
  Narrow Tauri commands coordinate window lifecycle and bounded messages; they
  do not become a second persistence or runtime transport. See
  [ADR 0003](docs/adr/0003-global-display-preferences.md) and
  [ADR 0004](docs/adr/0004-standalone-workflow-window.md).
- Ordinary chat does not load React Flow, add workflow prompts, or start the
  DAG scheduler. Explicit user workflow mode lazily loads the editor and
  enables the Pi workflow extension for the foreground session.
- Pi remains the agent. Workflow tools read the Host's current graph/catalog
  and submit constrained proposals; the chat UI owns user approval. The Host
  rechecks revisions before writes. The editor owns manual graph interaction;
  the Rust Host remains the durable source of truth.
- A Pi Agent workflow executor checks cancellation after asynchronous model and
  session-snapshot preparation and immediately before sending its prompt. Once
  prompting starts, cancellation sends Pi's native abort request and the Run
  records the node and workflow cancellation through the normal event stream.
- Initial chat startup requests Pi's authoritative snapshot and the saved
  session's disk history concurrently. The Pi snapshot is not gated on parsing
  the full JSONL history. Disk history can render while the snapshot is pending;
  if it arrives after hydration, it may supplement only a longer history for
  the same session while the Pi sequence is unchanged and the Agent is idle.
  Host JSONL message and branch-tree reads run on Tokio's blocking pool so a
  large saved session does not occupy an async dispatch worker while it is
  parsed. Active transcript messages are moved into the returned branch rather
  than deep-cloned after parsing, reducing peak memory during hydration. A
  filesystem read error fails the disk fallback instead of silently returning
  a truncated transcript; the Pi snapshot path can then provide recovery.
- The scheduler runs only registered, trusted executors. The initial supported
  built-ins are Start, End, Pi Agent, Assign, Template, Extract, Merge, Filter,
  and Condition. AI-generated implementation source is an inert draft in normal
  builds. The opt-in development feature wires Host RPC to platform-constrained
  helpers: Windows uses AppContainer plus a Job Object; the macOS XPC/QuickJS
  prototype remains outside default app bundles until per-target signing is
  implemented. When explicitly built for development, the Host checks both
  code signatures for the App Sandbox entitlement before advertising the
  macOS capability, and the worker repeats the entitlement check at startup.
  Host authorization reads source and
  parameters only from the immutable Run snapshot and requires the Run and
  target node to be durably running. The executor waits until the `node_started`
  event is stored before making the RPC. AbortSignal sends a second,
  window-scoped Host RPC; both platform paths cancel by request ID. Normal
  packages omit the feature and XPC helper, and release builds reject it until
  Windows 10 and macOS 11+ installed-app confinement, packaging/signing, and
  cancellation acceptance all pass. The macOS prototype has not been built or
  run on a native Mac runner. Windows process launch
  paths and Pi session/extension arguments stay in native `OsString` form
  through process creation, preserving even UTF-16 code units that cannot
  round-trip through Unicode strings. The AppContainer command line also applies
  Windows backslash/quote escaping when launching its worker. See
  [ADR 0002](docs/adr/0002-workflow-code-runtime.md).
- Use [the workflow node reference](PIPLINE工作流基础节点参考.md) for per-node
  schemas and planned capability boundaries, and
  [the development plan](PIPLINE开发计划-Windows-macOS.md) for milestone
  acceptance status.

## Frontend ownership

- `public/` is vanilla JavaScript with no application framework. The chat
  composition root is `public/native/app.js`; keep feature behavior in focused
  modules under `public/native/`.
- `public/native/transport/` owns Host protocol adapters and gateways;
  `session/` owns chat/session state; `workflow/` owns workflow editor,
  validation, scheduler, and Run UI; `ui/` owns shared chat rendering.
- Workflow UI and React Flow are dynamically loaded. Preserve this boundary so
  opening ordinary chat does not download or initialize the canvas runtime.
- Development serves the workspace `public/` directory. The frontend build
  also stages production assets into `src-tauri/target/frontend-dist`; Tauri
  packages that staged tree at the same runtime `public/` resource path. The
  staging step excludes `*.test.*` and `*.spec.*` modules and replaces the
  destination on every build, while leaving source files available to Vitest.
- All user-visible text comes from the global locale resources. Persisted
  workflow IDs, port keys, operation names, and executor contracts remain
  language-independent.
- The macOS minimum WebView target is Safari 14 behavior. Bundle module,
  syntax, API, and CSS compatibility locally; do not rely on first-launch
  network polyfills or post-floor WebKit APIs.

## Build and release

- `scripts/pi-version.json` pins Pi and its dependency/notice data;
  `scripts/node-runtime-version.json` pins the macOS Node runtime and checksums.
  Platform resource fetchers stage only the matching OS/architecture runtime.
- Windows CI is configured to produce x64 MSI and NSIS installers. macOS CI is
  configured to produce separate arm64 and Intel DMG installers with
  `MACOSX_DEPLOYMENT_TARGET=11.0`; workflow configuration is not evidence that
  the hosted runners have completed successfully.
- Keep the Windows/macOS CI matrix aligned with Cargo targets, runtime assets,
  SBOMs, third-party license archives, and SHA-256 manifests. The Windows MSI
  UpgradeCode is explicitly fixed in `src-tauri/tauri.conf.json` and checked
  against built MSI metadata by `scripts/check-msi-upgrade-code.ps1`.
- Release matrix jobs upload Tauri bundles and sidecars to a GitHub draft.
  `publish-release` changes the draft to public only after every matrix job
  passes, including installer install/upgrade checks and native macOS DMG/Pi
  smoke. Beta channel publication depends on that final publish gate. A manual
  dispatch from a non-tag ref does not run release jobs; dispatching a `v*`
  tag uses the same gated release path.
- Updater artifacts require the Pipline-owned signing key and release
  configuration; release gates reject the inherited Picot public key and must
  verify that the private signing secret matches the Pipline-owned public key.
  Never reuse the inherited upstream signing identity for a Pipline release.
  Internal unsigned artifacts must not be described as public
  release packages.

## Architecture decision records

- [ADR 0001: platform and Pi runtime](docs/adr/0001-platform-and-pi-runtime.md)
- [ADR 0002: workflow code runtime and confinement](docs/adr/0002-workflow-code-runtime.md)
- [ADR 0003: global display preferences](docs/adr/0003-global-display-preferences.md)
- [ADR 0004: standalone workflow editor window](docs/adr/0004-standalone-workflow-window.md)
