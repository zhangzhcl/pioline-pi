// ABOUTME: OS-specific process group and Job Object lifetime guards for the
// ABOUTME: disposable workflow-code helper subprocess.

#[cfg(windows)]
pub(super) struct ReadyEvent {
    pub(super) handle: windows_sys::Win32::Foundation::HANDLE,
    pub(super) name: std::ffi::OsString,
}

#[cfg(windows)]
// SAFETY: the event handle is an opaque kernel object that may be waited on,
// signaled, and closed from any thread; ownership is transferred only once.
unsafe impl Send for ReadyEvent {}

#[cfg(windows)]
impl ReadyEvent {
    pub(super) fn create() -> Result<Self, String> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::System::Threading::CreateEventW;
        let name = std::ffi::OsString::from(format!(
            "Local\\Pipline.WorkflowCode.Ready.{}",
            uuid::Uuid::new_v4().simple()
        ));
        let wide: Vec<u16> = name.encode_wide().chain(Some(0)).collect();
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, wide.as_ptr()) };
        if handle.is_null() {
            return Err(format!(
                "Cannot create workflow helper startup event: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self { handle, name })
    }

    fn into_raw(self) -> windows_sys::Win32::Foundation::HANDLE {
        let handle = self.handle;
        std::mem::forget(self);
        handle
    }
}

#[cfg(windows)]
impl Drop for ReadyEvent {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(windows)]
pub(super) struct ProcessGuard {
    job: windows_sys::Win32::Foundation::HANDLE,
    ready_event: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
// SAFETY: moving the opaque Job Object handle between threads does not change
// its kernel-managed process membership or lifetime semantics.
unsafe impl Send for ProcessGuard {}

#[cfg(windows)]
impl ProcessGuard {
    pub(super) fn terminate_group(&mut self) {}

    pub(super) fn attach(pid: u32, ready_event: ReadyEvent) -> std::io::Result<Self> {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_TIME,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, SetEvent, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        // SAFETY: all handles are checked before use, structures are zeroed
        // according to Win32 requirements, and ownership is closed on errors.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                | JOB_OBJECT_LIMIT_PROCESS_MEMORY
                | JOB_OBJECT_LIMIT_JOB_TIME;
            // The trusted launcher shim and its AppContainer worker share this
            // Job Object, so allow exactly those two processes.
            limits.BasicLimitInformation.ActiveProcessLimit = 2;
            limits.BasicLimitInformation.PerJobUserTimeLimit = 5 * 10_000_000;
            limits.ProcessMemoryLimit = 256 * 1024 * 1024;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            let process: HANDLE = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            if AssignProcessToJobObject(job, process) == 0 {
                let error = std::io::Error::last_os_error();
                CloseHandle(process);
                CloseHandle(job);
                return Err(error);
            }
            CloseHandle(process);
            if SetEvent(ready_event.handle) == 0 {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            let ready_event = ready_event.into_raw();
            Ok(Self { job, ready_event })
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessGuard {
    fn drop(&mut self) {
        // Closing a KILL_ON_JOB_CLOSE job guarantees descendants cannot outlive
        // their owning Pipline process or this invocation.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
            windows_sys::Win32::Foundation::CloseHandle(self.ready_event);
        };
    }
}

#[cfg(unix)]
pub(super) struct ProcessGuard(Option<i32>);

#[cfg(unix)]
impl ProcessGuard {
    pub(super) fn attach(pid: u32) -> std::io::Result<Self> {
        let pid = i32::try_from(pid)
            .map_err(|_| std::io::Error::other("workflow helper PID is out of range"))?;
        Ok(Self(Some(pid)))
    }

    pub(super) fn terminate_group(&mut self) {
        if let Some(pid) = self.0.take() {
            unsafe { libc::kill(-pid, libc::SIGKILL) };
        }
    }

    pub(super) fn disarm(&mut self) {
        self.0 = None;
    }
}

#[cfg(unix)]
impl Drop for ProcessGuard {
    fn drop(&mut self) {
        // While the leader is still live (including future cancellation), kill
        // the group. Once wait() reaps it, the caller disarms this guard so a
        // recycled process-group ID can never be signalled later.
        self.terminate_group();
    }
}

#[cfg(unix)]
pub(super) fn set_process_resource_limits() -> std::io::Result<()> {
    fn set_limit(resource: libc::c_int, value: libc::rlim_t) -> std::io::Result<()> {
        let limit = libc::rlimit {
            rlim_cur: value,
            rlim_max: value,
        };
        // SAFETY: `limit` points to a valid initialized rlimit structure.
        if unsafe { libc::setrlimit(resource, &limit) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    set_limit(libc::RLIMIT_CPU, 4)?;
    set_limit(libc::RLIMIT_NOFILE, 32)?;
    set_limit(libc::RLIMIT_CORE, 0)?;
    set_limit(libc::RLIMIT_FSIZE, 0)
}

#[cfg(not(any(unix, windows)))]
pub(super) struct ProcessGuard;

#[cfg(not(any(unix, windows)))]
impl ProcessGuard {
    pub(super) fn terminate_group(&mut self) {}

    pub(super) fn attach(_pid: u32) -> std::io::Result<Self> {
        Ok(Self)
    }
}
