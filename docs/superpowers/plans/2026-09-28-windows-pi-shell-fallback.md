# Windows Pi Shell Fallback Implementation Plan

> **For agentic workers:** Execute inline in the current Pipline checkout. The checkout already contains shared, uncommitted work; do not reset it or commit unrelated changes.

**Goal:** Keep Pi's built-in `bash` tool active when a usable Bash shell is configured or installed, and otherwise expose Pi's built-in Windows `powershell` tool instead of leaving the model with a broken Bash tool.

**Architecture:** Rust launch resolution detects the effective Pi `shellPath`, Git Bash, and PATH Bash without changing `~/.pi/agent`. It passes a one-process fallback flag to the embedded Pi. The bundled bridge extension then replaces only active `bash` with registered `powershell`; it preserves other active and extension tools. macOS behavior and Windows installs with working Bash remain unchanged.

**Tech Stack:** Rust/Tauri Pi launch resolver, Pi 0.85.1 ExtensionAPI TypeScript, Vitest, Rust unit tests.

---

### Task 1: Specify the bridge behavior

**Files:**
- Create: `extensions/windows-shell-fallback.ts`
- Create: `extensions/windows-shell-fallback.test.ts`

- [x] Add tests for: no-op when the launch flag is absent; no-op when Bash is not active; no-op when the Pi build has no `powershell` tool; and replacing `bash` while preserving every other active tool and extension tool.
- [x] Run `bun run vitest run extensions/windows-shell-fallback.test.ts`; confirm the module/import failure is the expected red result.
- [x] Implement `activateNativePowerShellFallback(pi, enabled)`; it may call `pi.setActiveTools` only when `enabled`, active tools include `bash`, and `pi.getAllTools()` contains `powershell`.
- [x] Re-run the focused Vitest file and `bun run build:extensions`.

### Task 2: Resolve shell availability without editing user settings

**Files:**
- Modify: `src-tauri/src/pi_launch.rs`
- Modify: `src-tauri/src/terminal_profiles.rs` only if the existing Git Bash discovery needs a public read-only helper
- Test: `src-tauri/src/pi_launch.rs`

- [x] Add a pure policy function that enables fallback only on Windows when no effective configured shell path exists, no Git Bash is discoverable, and no non-WSL `bash.exe` exists on PATH.
- [x] Resolve `shellPath` using project `.pi/settings.json` over `~/.pi/agent/settings.json`, matching Pi's documented scope order; resolve `~` and relative paths against the owning settings directory. If the effective configured path exists, keep native Bash. If the configured path is invalid, continue to shell discovery.
- [x] Write Rust tests for project-over-global precedence, existing and invalid `shellPath`, Git Bash availability, PATH Bash excluding the Windows System32 WSL stub, and macOS never enabling fallback.
- [x] Run `cargo test --manifest-path src-tauri/Cargo.toml pi_launch::tests` and confirm all new decision tests pass.

### Task 3: Carry the decision into Pi and activate its native PowerShell tool

**Files:**
- Modify: `src-tauri/src/pi_launch.rs`
- Modify: `src-tauri/src/native_pi_manager.rs`
- Modify: `extensions/picot-bridge.ts`
- Modify: `extensions/windows-shell-fallback.ts`
- Test: Rust launch description tests and the Task 1 extension tests

- [x] Add a `windows_powershell_fallback` launch-spec value and emit `PIPLINE_WINDOWS_POWERSHELL_FALLBACK=1` only when the Task 2 policy enables it.
- [x] Register the extension helper from `picot-bridge.ts` with Pi's `session_start` event. Leave Pi's user settings, session files, extensions, MCP configuration, and active tool set untouched when the flag is absent.
- [x] Add launch-description tests that assert the flag is present only for fallback launches and absent for native Bash/macOS launches.
- [x] Run the focused Rust and extension tests, then build the extension bundle.

### Task 4: Record the Windows 10 acceptance boundary

**Files:**
- Modify: `PIPLINE开发计划-Windows-macOS.md`
- Verify: `git diff --check`

- [x] Record that the fallback preserves normal Git Bash behavior when available and that no user Pi settings are rewritten.
- [x] Keep the Windows 10 clean-machine terminal call as a required M0/M1 acceptance; code and unit tests alone do not prove PowerShell launches successfully from a clean installer.


**Result:** Extension tests 5/5, Rust shell-policy tests 6/6, launch-description tests 3/3, un run build:extensions, targeted Biome, and un run check:rust passed (339 Rust tests passed, 3 ignored). Windows 10 clean-installer terminal execution remains unverified and is still an M0/M1 acceptance item.
