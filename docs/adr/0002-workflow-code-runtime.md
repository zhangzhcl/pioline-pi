# ADR 0002: Workflow user-code runtime and platform confinement

- Status: Accepted for implementation, gated on native platform confinement
- Date: 2026-09-26

## Context

AI-generated NodeMeta may contain TypeScript source. Running it inside the Pi RPC process, Tauri webview, or Rust host would expose user files, credentials, network, shell, and IPC to code that is not trusted. The runtime must also ship in the application and support Windows 10 plus macOS 11.0+ Intel and Apple Silicon.

The obvious Node sidecar does not meet the platform contract: current Node 24 official macOS binaries target macOS 13.5+, while the pinned Node 22.23.3 runtime is the last official line compatible with the macOS 11 floor. Node 22 is in Maintenance LTS and is scheduled to reach end of life on 2027-04-30; 2026-09-23 was the date of a Node 22 patch release, not its EOL. This runtime remains an interim platform-compatibility choice that must be upgraded or replaced before its support window ends. Using Node's Permission Model alone is not an adversarial sandbox; Node documents that malicious code can bypass it.

## Decision

1. Do not use the Pi executable as a general Bun/Node runtime, the user's system Node, Node 24 official binaries, or EOL Node 22 to execute custom nodes.
2. Prototype an embedded QuickJS engine through the MIT-licensed `rquickjs` Rust bindings in a separate `workflow-code-runner` helper process. Bundle the helper with each platform's installation artifact only after both platform launchers apply the required OS confinement; no runtime download or preinstalled Node is required.
3. Pass one bounded JSON request over stdin and one bounded JSON response over stdout. The request contains the frozen node source, inputs, and parameters. The helper exposes only JSON data and a size-limited `ctx.log`; it does not install QuickJS `std`/`os` modules or host bindings for files, network, shell, environment, Pi credentials, or Tauri IPC.
4. Set per-invocation memory, stack, and instruction-time limits in QuickJS and a parent-enforced wall-clock timeout. Reject oversized source, input, logs, and output. A timeout or malformed output is a normal node failure and must be persisted in the Run event stream.
5. Apply operating-system process confinement before enabling user-code nodes: Windows uses a dedicated AppContainer profile with no network capability plus a Job Object resource/kill policy; macOS uses an independently sandboxed XPC service and a separate QuickJS worker, because the Pipline host must stay able to reuse `~/.pi/agent` and open projects. Apple describes XPC as the preferred privilege-separation mechanism; a child process inherits the parent's sandbox capability set and cannot reduce an unsandboxed host's permissions. The Windows prototype uses a trusted stdio relay that creates the QuickJS worker suspended with a zero-capability AppContainer security attribute; the worker inherits only the three protocol stdio handles. A one-shot named-event handshake makes the relay wait until the parent has assigned it to the Job Object, so the inner worker inherits the resource/kill policy too; the handshake has a bounded timeout. The relay stages the executable image under that profile's private app-data directory and uses the same directory as the worker's current directory, avoiding ACL changes to MSI/NSIS install trees, host temp, and user directories. The macOS source path builds an XPC service plus a separately signed Rust worker. **The current packaging path is not yet capable of preserving their distinct sandbox entitlements:** Tauri's macOS bundler recursively signs `.xpc` bundles and their extensionless executables with the single `bundle.macOS.entitlements` setting. That file belongs to the unsandboxed Pipline host (which needs project and `~/.pi/agent` access), so it cannot also be the XPC/worker sandbox profile. Host's signature/entitlement checks fail closed after packaging, preventing the code-runner capability from being advertised, but this is not a working sandbox implementation. Host calls the service over NSXPC with bounded JSON and a request-scoped cancel operation. The macOS path remains development-only until packaging uses per-target signing and native verification covers Swift/Objective-C compilation, service discovery, signatures/entitlements, cancellation, and macOS 11 behavior.
6. AI-generated implementation code is outside the M0–M6 first-release execution scope. The QuickJS prototype stays behind the Cargo feature `workflow-code-runner-prototype`, the XPC service/helper are absent from default app bundles, and a compile-time guard rejects any release profile built with that feature. The explicit development builder may produce an unbundled macOS prototype artifact; it must not be treated as sandboxed until per-target signing is implemented. The opt-in Windows development build has a Host RPC executor path: it accepts only an authenticated local desktop client, loads the durable Run from SQLite, requires the Run and target node to be running, and obtains code and parameters only from the frozen NodeMeta snapshot. The frontend waits for the `node_started` event write to finish before invoking this executor, and aborts execution if persistence failed. AbortSignal sends a second request scoped to the originating desktop window and the execution request ID; a bounded short-lived tombstone handles cancellation arriving before helper registration, while active cancellation kills the helper process group/Job. Normal builds report no code-execution capability, so scheduler preflight rejects a user-code graph before persisting a Run. Win10 installed-app verification and macOS XPC confinement are required before a future M8 release can enable generated-code execution.

## Source-language contract

QuickJS executes JavaScript, not TypeScript. NodeMeta proposal now loads the pinned MIT `esbuild-wasm@0.28.0` compiler and its bundled WASM only on demand, in a classic Web Worker targeting Safari 14/WebKit for macOS 11 compatibility. The compiler parses/transforms a single TypeScript input to an IIFE whose selected `entryFn` is type-checked as a named export without evaluating it; the runtime helper resolves the fixed `__pipline_entry` export. Imports are rejected by a resolver plugin, and compiler warnings/errors or a 10-second compilation timeout prevent persistence. The compiled source and compiler version are stored alongside the original TS draft; Rust storage validates the version and size. This is language conversion and UX validation only, not a security validator or execution boundary. The feature-gated development executor reads the compiled artifact from the frozen Run NodeMeta snapshot and the helper checks the pinned compiler version and export shape. Before release execution, both OS sandbox gates and their native acceptance evidence still apply.

## Security limits

- A JS engine is not, by itself, an OS security boundary. The helper-process OS sandbox is a release blocker for enabling generated code.
- The helper has no capability to access external resources; future file/network capabilities require a separate permission design and explicit user grant per node/run.
- Engine vulnerabilities remain possible. Pin and update QuickJS, retain MIT notices, cap resources, and keep the helper process disposable.
- Generated code can still produce incorrect or destructive data through its declared outputs; validate output against the node's port schema before making it available downstream.

## Consequences

- Custom NodeMeta generation and visual editing can ship before code execution, but code execution cannot be marked complete while either OS sandbox is missing.
- Windows and macOS will use the same JS engine and JSON protocol, with platform-specific launcher confinement.
- Mac source/build support can proceed without immediate Mac hardware validation, but macOS sandbox behavior must be verified on the minimum supported macOS release before user-code nodes are enabled for release.
- The current compiler experiment is for interface exploration only. Do not treat it as an app capability or accept its output as trusted until it is bundled, version-locked, integrated, and reviewed with the language contract.
- Tauri's current macOS bundler applies one configured entitlement plist to all nested executable targets it discovers, including custom XPC services. Do not claim the XPC entitlement separation is implemented by pre-signing the custom bundle: the bundler re-signs it. The Mac packaging pipeline must assign the host and XPC/worker entitlements independently and then sign the outer app in a valid nested-code order.

## References

- Node.js release schedule (Node 22 Maintenance LTS through 2027-04-30): https://github.com/nodejs/Release#release-schedule
- Node.js release status and LTS policy: https://nodejs.org/en/about/previous-releases
- Node.js 24 macOS 13.5 minimum: https://github.com/nodejs/nodejs.org/blob/main/apps/site/pages/en/blog/migrations/v22-to-v24.mdx
- Node.js Permission Model security limitation: https://nodejs.org/api/permissions.html
- QuickJS MIT license and engine resource controls: https://bellard.org/quickjs/quickjs.html, https://bellard.org/quickjs/quickjs.pdf
- `rquickjs` MIT license and runtime memory/stack/interrupt APIs: https://docs.rs/crate/rquickjs/latest, https://docs.rs/rquickjs/latest/rquickjs/struct.Runtime.html
- Windows AppContainer: https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
- Apple App Sandbox and helper-process inheritance: https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html
