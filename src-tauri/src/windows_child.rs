//! Suppress console windows for spawned children on Windows.
//!
//! Picot's release build is a GUI-subsystem binary (no console of its own).
//! Windows gives every console child we spawn (git, node, npm, python, cmd)
//! a brand-new, visible console window unless the `CREATE_NO_WINDOW` flag is
//! passed to that one `CreateProcess` call — the flag is per-spawn and is not
//! inherited by grandchildren. Those windows live exactly as long as the
//! child runs, which is the "several terminal windows flashing randomly"
//! reported in issue #39.
//!
//! Route every spawn through [`hide_console`] / [`hide_console_tokio`] the way
//! spawns are routed through `appimage_env::scrub`, so the flag cannot be
//! forgotten at a new call site.

use std::process::Command as StdCommand;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Hide the child's console window on Windows; no-op on other platforms.
pub fn hide_console(command: &mut StdCommand) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// tokio counterpart of [`hide_console`].
pub fn hide_console_tokio(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        // tokio::process::Command exposes creation_flags natively on Windows.
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

#[cfg(windows)]
pub mod windows_job {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// Owned handle to a Win32 Job Object. Closes the underlying kernel handle
    /// automatically on drop.
    pub struct JobHandle(HANDLE);

    // SAFETY: the handle is an opaque kernel object; Windows serializes operations on it.
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    impl Drop for JobHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// Create a kill-on-close Job Object and assign `pid` to it so the entire
    /// child process tree terminates when the job is terminated or closed.
    pub fn create_and_assign(pid: u32) -> Option<JobHandle> {
        if pid == 0 {
            return None;
        }
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() || AssignProcessToJobObject(job, process) == 0 {
                if !process.is_null() {
                    CloseHandle(process);
                }
                CloseHandle(job);
                return None;
            }
            CloseHandle(process);
            Some(JobHandle(job))
        }
    }

    /// Terminate every process in the job and close the handle via Drop.
    pub fn terminate(job: JobHandle) {
        unsafe {
            TerminateJobObject(job.0, 1);
        }
        drop(job);
    }
}
