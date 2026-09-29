# ADR 0004: Standalone workflow editor window

- Status: accepted, implementation in progress
- Date: 2026-09-27

## Context

The workflow graph is a primary editing surface and does not fit the 320px
workspace side panel. Users also need to keep the Pi conversation visible while
they edit or observe the same graph and run.

## Decision

- Open the editor in a dedicated Tauri WebView window, addressed by workspace
  and workflow IDs. Reopening focuses the existing WebView instead of
  navigating/recreating it when the workflow route is unchanged.
- Switching the reused workspace window to another workflow is requested
  through its current WebView. It rejects the switch while a Run is queued,
  running, or still settling, preserving the frontend-owned scheduler.
- Keep workflow definitions, run state, and ordered events authoritative in
  the existing Rust Host/SQLite service. Both WebViews use the `/v2/ws` host
  protocol and revision/CAS updates; neither window owns a private graph copy.
- The chat WebView remains the owner of Pi workflow-tool enablement and Agent
  proposal approval. Opening the editor hides its narrow panel while preserving
  that session-scoped mode; closing the editor restores the panel.
- The editor receives the current Pi runtime target from the chat window. Pi
  Agent runs notify the matching chat window to lock its composer for the run.
- Closing the editor window hides it without destroying its WebView, so a
  frontend-owned scheduler and its Pi Agent Run continue to settle. Reopening
  focuses the retained window. The chat window restores its workflow view when
  the editor is hidden.
- “Use workflow in chat” sends a bounded JSON summary through a native
  Tauri-window message to the matching workspace conversation.
- If the client loses confirmation while creating a Run, or event persistence
  fails during execution, it reloads the authoritative Host record and attempts
  to append a terminal `run_interrupted` event while the record is still queued
  or running. The Host accepts that transition and broadcasts it to other
  windows. If the Host cannot be reached, the UI reports an uncertain outcome;
  the existing startup recovery marks any durable in-flight record interrupted.
- The run history exposes an explicit refresh action so a workflow WebView can
  reload Host-authoritative records after reconnecting. Run controls also
  re-render their labels and refresh the selected record when the shared locale
  changes.
- The editor route is loaded through the existing static Host and shares the
  global language preference. Locale preferences are polled from the shared
  cookie because workspace windows may have different loopback ports.
- Native window coordination uses six explicit app-local Tauri command
  permissions declared in `src-tauri/permissions/default.toml`; both bundled
  chat and workflow WebViews need the matching open, hide, title, target,
  run-lock, and context operations. The commands validate workspace/window
  identifiers and route messages only to the matching bundled window origin.

## Consequences

- The canvas and React Flow bundle remain lazy: ordinary chat does not load the
  workflow editor entry or canvas runtime.
- A window close does not delete or fork workflow state. Host events allow the
  remaining window to recover the latest revision/run snapshot.
- The session target follows the selected chat session while the editor is
  open. A stale target can otherwise run a Pi Agent node in a session the user
  is no longer viewing.
- UI-level and two-WebView runtime acceptance remains required before M2 is
  complete.
