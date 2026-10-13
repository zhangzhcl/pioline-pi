// ABOUTME: PTY spawning, output reader thread, generation replacement, and
// ABOUTME: platform-specific process-tree cleanup (Win32 Job Object / Unix process group).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::json;

use crate::terminal_output::{TerminalLimits, TerminalOutputStore};
use crate::terminal_profiles::{
    fallback_windows_shell_after_spawn_failure, resolve_macos_default, resolve_windows_profile,
    windows_shell_env, ProfileError, ResolvedShell, ShellProfileId,
};
use crate::terminal_registry::{CloseLease, TerminalKey};
use crate::window_owner::OwnerId;
#[cfg(windows)]
use crate::windows_child::windows_job;

use super::{
    default_preferred_shell, LiveTerminal, TerminalManager, INITIAL_COLS, INITIAL_ROWS,
    READ_BUF_BYTES,
};

pub(super) struct Spawned {
    pub(super) master: Box<dyn MasterPty + Send>,
    pub(super) writer: Box<dyn Write + Send>,
    pub(super) child: Box<dyn portable_pty::Child + Send + Sync>,
    pub(super) reader: Box<dyn Read + Send>,
    #[cfg(windows)]
    pub(super) job: Option<windows_job::JobHandle>,
}

impl TerminalManager {
    pub(super) fn resolve_shell(&self, profile_id: &str) -> Result<ResolvedShell, String> {
        let id = ShellProfileId::from_id_str(profile_id)
            .ok_or_else(|| format!("unknown shell profile: {profile_id}"))?;
        let resolved = if cfg!(target_os = "windows") {
            resolve_windows_profile(id, self.inner.probe.as_ref())
        } else {
            resolve_macos_default(&default_preferred_shell(), self.inner.probe.as_ref())
        };
        resolved.map_err(|ProfileError::ProfileUnavailable { guidance, .. }| guidance)
    }

    pub(super) fn spawn_pty_for_profile(
        &self,
        profile_id: &str,
        shell: &ResolvedShell,
        workspace_root: &Path,
    ) -> Result<Spawned, String> {
        match self.spawn_pty(shell, workspace_root) {
            Ok(spawned) => Ok(spawned),
            Err(reason) => {
                let Some(fallback) = fallback_windows_shell_after_spawn_failure(
                    profile_id,
                    shell,
                    self.inner.probe.as_ref(),
                ) else {
                    return Err(reason);
                };
                self.spawn_pty(&fallback, workspace_root)
                    .map_err(|_| reason)
            }
        }
    }

    pub(super) fn spawn_pty(
        &self,
        shell: &ResolvedShell,
        workspace_root: &Path,
    ) -> Result<Spawned, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: INITIAL_ROWS,
                cols: INITIAL_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("pty open failed: {e}"))?;
        let mut cmd = CommandBuilder::new(&shell.program);
        for arg in &shell.args {
            cmd.arg(arg);
        }
        cmd.cwd(workspace_root);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (key, value) in windows_shell_env(&shell.program) {
            cmd.env(key, value);
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("pty spawn failed: {e}"))?;
        // ConPTY on Windows needs the slave handle closed after spawn so the
        // child attaches to a real console. Harmless on Unix.
        drop(pair.slave);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("pty reader clone failed: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("pty writer clone failed: {e}"))?;
        #[cfg(windows)]
        let job = windows_job::create_and_assign(child.process_id().unwrap_or(0));
        Ok(Spawned {
            master: pair.master,
            writer,
            child,
            reader,
            #[cfg(windows)]
            job,
        })
    }

    /// Store the live PTY handle (master/writer/child) and start a reader
    /// thread that owns the reader half.
    pub(super) fn attach_spawned(
        &self,
        owner: OwnerId,
        workspace_root: PathBuf,
        terminal_id: String,
        generation: u64,
        profile_id: String,
        spawned: Spawned,
    ) {
        let Spawned {
            master,
            writer,
            child,
            reader,
            #[cfg(windows)]
            job,
        } = spawned;
        self.inner.live.lock().expect("live lock").insert(
            terminal_id.clone(),
            LiveTerminal {
                owner: owner.clone(),
                workspace_root: workspace_root.clone(),
                generation,
                profile_id,
                master,
                writer,
                child: Some(child),
                #[cfg(windows)]
                job,
            },
        );
        self.inner
            .outputs
            .lock()
            .expect("outputs lock")
            .entry(terminal_id.clone())
            .or_insert_with(|| TerminalOutputStore::new(TerminalLimits::default()));
        let manager = self.clone();
        std::thread::spawn(move || {
            run_reader(
                &manager,
                owner,
                workspace_root,
                terminal_id,
                generation,
                reader,
            );
        });
    }

    /// Drop a spawned PTY without registry bookkeeping. Used when commit_running
    /// fails after a successful spawn.
    pub(super) fn detach_spawned(&self, spawned: Spawned) {
        #[cfg(windows)]
        let job = spawned.job;
        #[cfg(not(windows))]
        let job: Option<isize> = None;
        kill_process_tree(&*spawned.master, spawned.child, job);
    }

    /// Remove only the generation being replaced, and reset its output store
    /// while both maps are locked in their global lock order.
    pub(super) fn replace_generation(&self, terminal_id: &str, generation: u64) {
        let removed = {
            let mut live = self.inner.live.lock().expect("live lock");
            let mut outputs = self.inner.outputs.lock().expect("outputs lock");
            let matches_generation = live
                .get(terminal_id)
                .is_some_and(|terminal| terminal.generation == generation);
            if matches_generation {
                outputs.insert(
                    terminal_id.to_string(),
                    TerminalOutputStore::new(TerminalLimits::default()),
                );
                live.remove(terminal_id)
            } else {
                None
            }
        };
        if let Some(terminal) = removed {
            kill_live_terminal(terminal);
        }
    }

    pub(super) fn terminate_and_finish(&self, key: &TerminalKey, lease: &CloseLease) {
        let removed = {
            let mut live = self.inner.live.lock().expect("live lock");
            let mut outputs = self.inner.outputs.lock().expect("outputs lock");
            let matches_generation = live
                .get(&lease.terminal_id)
                .is_some_and(|terminal| terminal.generation == lease.generation);
            if matches_generation {
                outputs.remove(&lease.terminal_id);
                live.remove(&lease.terminal_id)
            } else {
                None
            }
        };
        if let Some(terminal) = removed {
            kill_live_terminal(terminal);
        }
        let _ = self
            .inner
            .registry
            .finish_close(key, &lease.terminal_id, lease.generation);
    }

    /// Atomically verify that output belongs to the current PTY generation and
    /// append it to that generation's journal. Restart/close use the same
    /// live-then-output lock order, preventing an old reader from appending
    /// between validation and journal replacement.
    pub(super) fn append_output_if_current(
        &self,
        terminal_id: &str,
        generation: u64,
        chunk: &[u8],
    ) -> Option<u64> {
        let live = self.inner.live.lock().expect("live lock");
        if live
            .get(terminal_id)
            .is_none_or(|terminal| terminal.generation != generation)
        {
            return None;
        }
        let mut outputs = self.inner.outputs.lock().expect("outputs lock");
        let sequence = if let Some(output) = outputs.get_mut(terminal_id) {
            output.append(chunk)
        } else {
            outputs
                .entry(terminal_id.to_string())
                .or_insert_with(|| TerminalOutputStore::new(TerminalLimits::default()))
                .append(chunk)
        };
        drop(outputs);
        drop(live);
        Some(sequence)
    }

    pub(super) fn emit_output(
        &self,
        owner: &OwnerId,
        terminal_id: &str,
        generation: u64,
        sequence: u64,
        bytes: &[u8],
    ) {
        self.emit(
            owner,
            json!({
                "type": "terminal_event",
                "payload": {
                    "type": "terminal_output",
                    "terminalId": terminal_id,
                    "generation": generation,
                    "firstSequence": sequence,
                    "lastSequence": sequence,
                    "dataBase64": BASE64.encode(bytes),
                }
            }),
        );
    }
}

/// Reader loop: append PTY output to the journal (assigning the next sequence),
/// then emit a `terminal_output` event to the owning client. Stale generations
/// (from a restarted tab's old reader) are dropped silently. On EOF, record the
/// exit and emit `terminal_exited`.
fn run_reader(
    manager: &TerminalManager,
    owner: OwnerId,
    workspace_root: PathBuf,
    terminal_id: String,
    generation: u64,
    mut reader: Box<dyn Read + Send>,
) {
    let mut buf = [0u8; READ_BUF_BYTES];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let chunk = &buf[..n];
                let Some(sequence) =
                    manager.append_output_if_current(&terminal_id, generation, chunk)
                else {
                    continue;
                };
                manager.emit_output(&owner, &terminal_id, generation, sequence, chunk);
            }
        }
    }

    // Take the child out of the live map without holding the lock while
    // waiting on it: close/restart must be able to acquire the same lock to
    // kill the process tree. The child is owned exclusively by this reader.
    let child = manager
        .inner
        .live
        .lock()
        .expect("live lock")
        .get_mut(&terminal_id)
        .and_then(|lt| {
            if lt.generation != generation {
                return None;
            }
            lt.child.take()
        });
    let exit_code = child.and_then(|mut c| {
        c.wait()
            .ok()
            .map(|status| if status.success() { 0 } else { -1 })
    });
    // The child has exited; release the live handle only when it still belongs
    // to this reader generation. A replacement generation remains untouched.
    {
        let mut live = manager.inner.live.lock().expect("live lock");
        if live
            .get(&terminal_id)
            .is_some_and(|terminal| terminal.generation == generation)
        {
            live.remove(&terminal_id);
        }
    }
    let key = TerminalKey {
        owner,
        workspace_root,
    };
    // A restart or explicit close may have replaced/removed this generation
    // while the reader was waiting. Only the still-owned running generation may
    // publish an exit event; stale exits must never remove the replacement tab.
    if manager
        .inner
        .registry
        .mark_exited(&key, &terminal_id, generation, exit_code)
        .is_err()
    {
        return;
    }
    manager.emit(
        &key.owner,
        json!({
            "type": "terminal_event",
            "payload": {
                "type": "terminal_exited",
                "terminalId": terminal_id,
                "generation": generation,
                "exitCode": exit_code,
            }
        }),
    );
}

#[cfg(unix)]
fn kill_process_tree(
    master: &dyn MasterPty,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    _job: Option<isize>,
) {
    // The PTY slave runs the shell in its own process group/session, so killing
    // the group terminates descendants (e.g. a spawned dev server) too.
    if let Some(pgid) = master.process_group_leader() {
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
fn kill_process_tree(
    _master: &dyn MasterPty,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    job: Option<windows_job::JobHandle>,
) {
    // Terminate the Job Object first so descendants (dev servers, watchers)
    // die with the shell, then fall back to killing the direct child.
    if let Some(handle) = job {
        windows_job::terminate(handle);
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(any(unix, windows)))]
fn kill_process_tree(
    _master: &dyn MasterPty,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    _job: Option<isize>,
) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Terminate a live terminal's process tree, using the platform's Job Object
/// (Windows) or process-group (Unix) mechanism. Consumes the handle.
pub(super) fn kill_live_terminal(lt: LiveTerminal) {
    #[cfg(windows)]
    let job = lt.job;
    #[cfg(not(windows))]
    let job: Option<isize> = None;
    if let Some(child) = lt.child {
        kill_process_tree(&*lt.master, child, job);
    }
}
