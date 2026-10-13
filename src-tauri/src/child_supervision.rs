//! Keep spawned `pi` runtimes from outliving the Picot process that owns them.
//!
//! Three things have to be true at once, because each of them fails on its own:
//!
//! 1. `pi` already exits when its stdin reaches EOF, so a child normally dies
//!    with its parent. But a wedged child never reads stdin and so never sees
//!    that EOF — one such runtime was found spinning at 100% CPU nine days
//!    after its Picot was gone, still holding a chat channel's lock.
//! 2. Killing the direct child leaves the child's *own* descendants running.
//!    Hence the process group (Unix) and job object (Windows) here.
//! 3. Neither helps when Picot itself is SIGKILLed or crashes: no teardown code
//!    runs at all. That is what [`sweep_orphans`] is for — the registry written
//!    at spawn time is the only record that survives a parent that never got to
//!    clean up after itself.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use crate::windows_child::windows_job;

#[cfg(test)]
mod tests;

const REGISTRY_DIR: &str = "picot-runtimes";

/// Make the child its own process-group leader so its descendants can be
/// terminated as a tree. Without this, `killpg` is a no-op because the child
/// is not a group leader. No-op off Unix; Windows uses a job object instead.
pub fn make_group_leader(command: &mut Command) {
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    #[cfg(not(unix))]
    {
        let _ = command;
    }
}

/// A spawned child plus everything it spawned in turn.
pub struct ChildTree {
    pid: u32,
    #[cfg(windows)]
    job: Option<windows_job::JobHandle>,
}

impl ChildTree {
    /// Take ownership of the tree rooted at `pid`. On Windows this also puts
    /// the process in a kill-on-close job object, which is the one mechanism
    /// that still cleans up when Picot is terminated without warning.
    pub fn attach(pid: u32) -> Self {
        #[cfg(windows)]
        {
            Self {
                pid,
                job: windows_job::create_and_assign(pid),
            }
        }
        #[cfg(not(windows))]
        {
            Self { pid }
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Ask the tree to exit, then insist. The grace period lets `pi` flush its
    /// session file; a wedged runtime ignores SIGTERM and is killed outright.
    pub fn terminate(&mut self) {
        #[cfg(unix)]
        {
            let group = -(self.pid as i32);
            unsafe {
                libc::kill(group, libc::SIGTERM);
            }
            for _ in 0..20 {
                if !pid_is_alive(self.pid) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            unsafe {
                libc::kill(group, libc::SIGKILL);
                libc::kill(self.pid as i32, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            if let Some(job) = self.job.take() {
                windows_job::terminate(job);
            }
        }
    }
}

#[cfg(unix)]
pub fn pid_is_alive(pid: u32) -> bool {
    // ESRCH means gone; EPERM means alive but not ours to signal.
    unsafe {
        libc::kill(pid as i32, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

#[cfg(not(unix))]
pub fn pid_is_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        windows_process::is_alive(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

#[cfg(not(windows))]
fn process_start_time_unix(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(windows)]
fn process_start_time_windows(pid: u32) -> Option<String> {
    windows_process::start_time(pid)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeEntry {
    pub pid: u32,
    /// Process start time, as the OS reports it. A pid alone is not safe to
    /// kill after a reboot or a pid wrap: this pins the identity.
    pub started_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RuntimeRegistry {
    supervisor_pid: u32,
    entries: Vec<RuntimeEntry>,
}

fn registry_dir() -> Option<PathBuf> {
    pi_root_from_agent_dir(&crate::pi_agent_dir::agent_dir()?)
        .map(|pi_root| pi_root.join(REGISTRY_DIR))
}

fn pi_root_from_agent_dir(agent_dir: &Path) -> Option<&Path> {
    agent_dir.parent()
}

fn registry_path_for(supervisor_pid: u32) -> Option<PathBuf> {
    registry_dir().map(|dir| dir.join(format!("{supervisor_pid}.json")))
}

/// Start time of `pid` as the OS reports it, used to tell a live runtime from
/// an unrelated process that inherited its pid.
pub fn process_start_time(pid: u32) -> Option<String> {
    #[cfg(windows)]
    {
        process_start_time_windows(pid)
    }
    #[cfg(not(windows))]
    {
        process_start_time_unix(pid)
    }
}

fn read_registry(path: &Path) -> Option<RuntimeRegistry> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_registry(path: &Path, registry: &RuntimeRegistry) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(encoded) = serde_json::to_string(registry) {
        let _ = std::fs::write(path, encoded);
    }
}

/// Record a runtime we just spawned, so a future Picot can clean it up if this
/// one dies without running any teardown.
pub fn record_runtime(pid: u32) {
    let Some(path) = registry_path_for(std::process::id()) else {
        return;
    };
    let mut registry = read_registry(&path).unwrap_or_else(|| RuntimeRegistry {
        supervisor_pid: std::process::id(),
        entries: Vec::new(),
    });
    registry.supervisor_pid = std::process::id();
    registry.entries.retain(|entry| entry.pid != pid);
    registry.entries.push(RuntimeEntry {
        pid,
        started_at: process_start_time(pid).unwrap_or_default(),
    });
    write_registry(&path, &registry);
}

/// Drop a runtime we stopped ourselves. Removing the file once it is empty
/// keeps a clean shutdown from leaving sweep work for the next launch.
pub fn forget_runtime(pid: u32) {
    let Some(path) = registry_path_for(std::process::id()) else {
        return;
    };
    let Some(mut registry) = read_registry(&path) else {
        return;
    };
    registry.entries.retain(|entry| entry.pid != pid);
    if registry.entries.is_empty() {
        let _ = std::fs::remove_file(&path);
    } else {
        write_registry(&path, &registry);
    }
}

pub fn clear_registry() {
    if let Some(path) = registry_path_for(std::process::id()) {
        let _ = std::fs::remove_file(path);
    }
}

/// Kill runtimes left behind by Picot processes that are no longer running.
/// Returns how many were killed. Called once at startup.
pub fn sweep_orphans() -> usize {
    sweep_orphans_in(registry_dir(), std::process::id(), &pid_is_alive, &|pid| {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
            libc::kill(pid as i32, libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            windows_process::terminate(pid);
        }
    })
}

/// Split out for tests: `alive` and `kill` are the only OS-touching parts.
fn sweep_orphans_in(
    dir: Option<PathBuf>,
    self_pid: u32,
    alive: &dyn Fn(u32) -> bool,
    kill: &dyn Fn(u32),
) -> usize {
    let Some(dir) = dir else {
        return 0;
    };
    let Ok(listing) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let mut killed = 0;
    for item in listing.flatten() {
        let path = item.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(registry) = read_registry(&path) else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        // Another Picot is still running and owns these runtimes.
        if registry.supervisor_pid == self_pid || alive(registry.supervisor_pid) {
            continue;
        }
        for entry in &registry.entries {
            if !alive(entry.pid) {
                continue;
            }
            // Identity check: a pid on its own can belong to anything after a
            // reboot or a pid wrap, and killing the wrong process is worse
            // than leaving an orphan behind.
            let current = process_start_time(entry.pid).unwrap_or_default();
            if !entry.started_at.is_empty() && current != entry.started_at {
                continue;
            }
            kill(entry.pid);
            killed += 1;
        }
        let _ = std::fs::remove_file(&path);
    }
    killed
}

#[cfg(windows)]
mod windows_process {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, TerminateProcess,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    pub fn is_alive(pid: u32) -> bool {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut exit_code = 0;
            let is_running = GetExitCodeProcess(process, std::ptr::from_mut(&mut exit_code)) != 0
                && exit_code == STILL_ACTIVE as u32;
            CloseHandle(process);
            is_running
        }
    }

    pub fn start_time(pid: u32) -> Option<String> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let mut creation = std::mem::zeroed::<FILETIME>();
            let mut exit = std::mem::zeroed::<FILETIME>();
            let mut kernel = std::mem::zeroed::<FILETIME>();
            let mut user = std::mem::zeroed::<FILETIME>();
            let succeeded = GetProcessTimes(
                process,
                std::ptr::from_mut(&mut creation),
                std::ptr::from_mut(&mut exit),
                std::ptr::from_mut(&mut kernel),
                std::ptr::from_mut(&mut user),
            ) != 0;
            CloseHandle(process);
            succeeded.then(|| {
                let ticks =
                    (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
                ticks.to_string()
            })
        }
    }

    pub fn terminate(pid: u32) {
        unsafe {
            let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !process.is_null() {
                TerminateProcess(process, 1);
                CloseHandle(process);
            }
        }
    }
}
