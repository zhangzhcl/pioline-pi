// ABOUTME: Parent-side bounded protocol for the disposable workflow-code helper.
// This module is feature-gated and its Windows development path is wired into
// workflow Runs. Release builds remain blocked until both platform confinement
// paths are implemented and natively verified.
#![allow(dead_code)]

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

const PROTOCOL_VERSION: u8 = 1;
const MAX_REQUEST_BYTES: usize = 1_200_000;
const MAX_RESPONSE_BYTES: usize = 1_000_000;
const MAX_DIAGNOSTIC_BYTES: usize = 4_000;
const MAX_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_LOGS: usize = 100;
const MAX_LOG_LINE_CHARS: usize = 1_000;
const MAX_LOG_CHARS: usize = 16_000;
const MAX_ERROR_CHARS: usize = 2_000;
const PARENT_WALL_CLOCK_LIMIT: Duration = Duration::from_secs(3);
const MAX_SOURCE_BYTES: usize = 50_000;

fn valid_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(c) if c == '_' || c == '$' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c == '$' || c.is_ascii_alphanumeric())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct NodeImplementationDraft {
    language: String,
    source: String,
    entry_fn: String,
    compiler_version: String,
    compiled_source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperRequest<'a> {
    protocol_version: u8,
    compiler_version: &'static str,
    compiled_source: &'a str,
    entry_fn: &'a str,
    inputs: &'a Value,
    params: &'a Value,
}

#[derive(Debug)]
pub struct WorkflowCodeResult {
    pub output: Value,
    pub logs: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct HelperResponse {
    protocol_version: u8,
    ok: bool,
    #[serde(default)]
    output: Option<Value>,
    #[serde(default)]
    logs: Vec<String>,
    #[serde(default)]
    error: Option<String>,
}

/// Execute only the versioned, compiled artifact carried by a frozen Run
/// NodeMeta snapshot. The original TypeScript is checked for consistency and
/// auditability but is never sent as executable source to the helper.
pub async fn execute_workflow_code(
    frozen_node_meta: &Value,
    inputs: &Value,
    params: &Value,
    mut cancellation: tokio::sync::oneshot::Receiver<()>,
) -> Result<WorkflowCodeResult, String> {
    if frozen_node_meta
        .get("schemaVersion")
        .and_then(Value::as_u64)
        != Some(1)
        || frozen_node_meta.get("type").and_then(Value::as_str) != Some("custom")
        || frozen_node_meta
            .pointer("/execution/kind")
            .and_then(Value::as_str)
            != Some("user-code")
    {
        return Err("Workflow code executor requires a frozen custom user-code NodeMeta".into());
    }
    if !inputs.is_object() || !params.is_object() {
        return Err("Workflow code inputs and params must be JSON objects".into());
    }
    let draft: NodeImplementationDraft = serde_json::from_value(
        frozen_node_meta
            .get("implementationDraft")
            .cloned()
            .ok_or_else(|| "Frozen NodeMeta has no implementationDraft".to_string())?,
    )
    .map_err(|error| format!("Frozen NodeMeta implementationDraft is invalid: {error}"))?;
    if draft.language != "typescript"
        || draft.compiler_version != "esbuild-wasm@0.28.0"
        || draft.source.is_empty()
        || draft.source.len() > MAX_SOURCE_BYTES
        || !valid_identifier(&draft.entry_fn)
        || draft.compiled_source.is_empty()
        || draft.compiled_source.len() > MAX_SOURCE_BYTES
        || draft.compiled_source.contains('\0')
    {
        return Err("Frozen NodeMeta compiled implementation is unsupported or oversized".into());
    }
    let request = HelperRequest {
        protocol_version: PROTOCOL_VERSION,
        compiler_version: "esbuild-wasm@0.28.0",
        compiled_source: &draft.compiled_source,
        entry_fn: &draft.entry_fn,
        inputs,
        params,
    };
    let request_bytes =
        serde_json::to_vec(&request).map_err(|error| format!("Cannot encode request: {error}"))?;
    if request_bytes.len() > MAX_REQUEST_BYTES {
        return Err("Workflow code request exceeds the 1.2 MB limit".into());
    }

    #[cfg(target_os = "macos")]
    {
        let response_bytes = execute_macos_xpc(request_bytes, &mut cancellation).await?;
        parse_helper_response(&response_bytes)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let executable = std::env::current_exe()
            .map_err(|error| format!("Cannot locate workflow code helper: {error}"))?;
        let (mut child, mut _process_guard) = spawn_helper(executable).await?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Workflow code helper stdin is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Workflow code helper stdout is unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Workflow code helper stderr is unavailable".to_string())?;

        let input_task = tokio::spawn(async move {
            let mut stdin = stdin;
            stdin
                .write_all(&request_bytes)
                .await
                .map_err(|error| format!("Cannot send workflow code request: {error}"))?;
            stdin
                .shutdown()
                .await
                .map_err(|error| format!("Cannot close workflow code request: {error}"))
        });
        let output_task = tokio::spawn(read_bounded(stdout, MAX_RESPONSE_BYTES));
        let diagnostic_task = tokio::spawn(read_bounded(stderr, MAX_DIAGNOSTIC_BYTES));

        let status = tokio::select! {
            result = tokio::time::timeout(PARENT_WALL_CLOCK_LIMIT, child.wait()) => match result {
                Ok(Ok(status)) => status,
                Ok(Err(error)) => {
                    abort_helper_tasks(
                        &mut child,
                        &mut _process_guard,
                        &input_task,
                        &output_task,
                        &diagnostic_task,
                    )
                    .await;
                    return Err(format!("Cannot wait for workflow code helper: {error}"));
                }
                Err(_) => {
                    abort_helper_tasks(
                        &mut child,
                        &mut _process_guard,
                        &input_task,
                        &output_task,
                        &diagnostic_task,
                    )
                    .await;
                    return Err("Workflow code helper exceeded the 3 second wall-clock limit".into());
                }
            },
            _ = &mut cancellation => {
                abort_helper_tasks(
                    &mut child,
                    &mut _process_guard,
                    &input_task,
                    &output_task,
                    &diagnostic_task,
                )
                .await;
                return Err("Workflow code execution was cancelled".into());
            }
        };
        #[cfg(unix)]
        _process_guard.disarm();

        let input_result = await_task(input_task, "workflow code request writer").await?;
        input_result?;
        let (response_bytes, response_overflow) =
            await_task(output_task, "workflow code response reader")
                .await?
                .map_err(|error| format!("Cannot read workflow code helper response: {error}"))?;
        let (diagnostic_bytes, _) = await_task(diagnostic_task, "workflow code diagnostic reader")
            .await?
            .map_err(|error| format!("Cannot read workflow code helper diagnostics: {error}"))?;
        if response_overflow {
            return Err("Workflow code helper response exceeds the 1 MB limit".into());
        }
        if !status.success() {
            let diagnostic = String::from_utf8_lossy(&diagnostic_bytes);
            return Err(if diagnostic.trim().is_empty() {
                format!("Workflow code helper exited with status {status}")
            } else {
                format!(
                    "Workflow code helper exited with status {status}: {}",
                    diagnostic.trim()
                )
            });
        }

        parse_helper_response(&response_bytes)
    }
}

fn parse_helper_response(response_bytes: &[u8]) -> Result<WorkflowCodeResult, String> {
    let response: HelperResponse = serde_json::from_slice(response_bytes)
        .map_err(|error| format!("Workflow code helper returned invalid JSON: {error}"))?;
    if response.protocol_version != PROTOCOL_VERSION {
        return Err("Workflow code helper returned an unsupported protocol version".into());
    }
    if !response.ok {
        if response.output.is_some() || !response.logs.is_empty() {
            return Err("Workflow code helper returned an invalid error response".into());
        }
        return Err(response
            .error
            .map(|error| error.chars().take(MAX_ERROR_CHARS).collect())
            .unwrap_or_else(|| "Workflow code helper failed without an error message".into()));
    }
    if response.error.is_some() || response.logs.len() > MAX_LOGS {
        return Err("Workflow code helper returned an invalid success response".into());
    }
    let mut total_log_chars = 0;
    for line in &response.logs {
        let line_chars = line.chars().count();
        if line_chars > MAX_LOG_LINE_CHARS {
            return Err("Workflow code helper returned an oversized log line".into());
        }
        total_log_chars += line_chars;
        if total_log_chars > MAX_LOG_CHARS {
            return Err("Workflow code helper returned oversized logs".into());
        }
    }
    let output = response
        .output
        .ok_or_else(|| "Workflow code helper omitted its output".to_string())?;
    let output_bytes = serde_json::to_vec(&output)
        .map_err(|error| format!("Cannot encode workflow code output: {error}"))?;
    if output_bytes.len() > MAX_OUTPUT_BYTES {
        return Err("Workflow code helper output exceeds the 512 KB limit".into());
    }
    Ok(WorkflowCodeResult {
        output,
        logs: response.logs,
    })
}

#[cfg(target_os = "macos")]
async fn execute_macos_xpc(
    request_bytes: Vec<u8>,
    cancellation: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<Vec<u8>, String> {
    use std::ffi::{CStr, CString};

    let request_id = uuid::Uuid::new_v4().to_string();
    let task_id = request_id.clone();
    let mut execution = tokio::task::spawn_blocking(move || {
        let task_id = CString::new(task_id).expect("UUID contains no NUL bytes");
        let mut response = vec![0u8; MAX_RESPONSE_BYTES + 1];
        let mut response_len = 0usize;
        let mut error = vec![0i8; MAX_DIAGNOSTIC_BYTES + 1];
        let status = unsafe {
            pipline_workflow_xpc_execute(
                task_id.as_ptr(),
                request_bytes.as_ptr(),
                request_bytes.len(),
                response.as_mut_ptr(),
                response.len(),
                &mut response_len,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status != 0 {
            let message = unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy();
            return Err(if message.is_empty() {
                format!("XPC workflow runner failed with status {status}")
            } else {
                message.into_owned()
            });
        }
        if response_len > MAX_RESPONSE_BYTES || response_len > response.len() {
            return Err("XPC workflow runner returned an oversized response".into());
        }
        response.truncate(response_len);
        Ok(response)
    });

    tokio::select! {
        result = &mut execution => result
            .map_err(|error| format!("XPC workflow task failed: {error}"))?,
        _ = &mut *cancellation => {
            cancel_macos_xpc_request(request_id.clone()).await;
            let _ = tokio::time::timeout(Duration::from_millis(500), &mut execution).await;
            Err("Workflow code execution was cancelled".into())
        }
        _ = tokio::time::sleep(PARENT_WALL_CLOCK_LIMIT) => {
            cancel_macos_xpc_request(request_id).await;
            let _ = tokio::time::timeout(Duration::from_millis(500), &mut execution).await;
            Err("Workflow code helper exceeded the 3 second wall-clock limit".into())
        }
    }
}

#[cfg(target_os = "macos")]
async fn cancel_macos_xpc_request(request_id: String) {
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::task::spawn_blocking(move || {
            use std::ffi::CString;
            let Ok(request_id) = CString::new(request_id) else {
                return;
            };
            unsafe { pipline_workflow_xpc_cancel(request_id.as_ptr()) }
        }),
    )
    .await;
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn pipline_workflow_xpc_execute(
        request_id: *const std::ffi::c_char,
        request: *const u8,
        request_len: usize,
        response: *mut u8,
        response_capacity: usize,
        response_len: *mut usize,
        error: *mut std::ffi::c_char,
        error_capacity: usize,
    ) -> i32;
    fn pipline_workflow_xpc_cancel(request_id: *const std::ffi::c_char) -> i32;
}

async fn spawn_helper(executable: PathBuf) -> Result<(Child, ProcessGuard), String> {
    let mut command = Command::new(executable);
    command
        .arg("--workflow-code-runner")
        .current_dir(std::env::temp_dir())
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    let ready_event = {
        let event = ReadyEvent::create()?;
        command
            .arg("--workflow-code-runner-ready-event")
            .arg(&event.name);
        event
    };
    #[cfg(unix)]
    unsafe {
        command.as_std_mut().pre_exec(|| {
            set_process_resource_limits()?;
            Ok(())
        });
        command.as_std_mut().process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start workflow code helper: {error}"))?;
    let Some(pid) = child.id() else {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err("Workflow code helper has no process id".into());
    };
    #[cfg(windows)]
    let guard_result = ProcessGuard::attach(pid, ready_event);
    #[cfg(unix)]
    let guard_result = ProcessGuard::attach(pid);
    match guard_result {
        Ok(guard) => Ok((child, guard)),
        Err(error) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err(format!(
                "Cannot confine workflow code helper lifetime: {error}"
            ))
        }
    }
}

async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut collected = Vec::with_capacity(limit.min(8_192));
    let mut buffer = [0; 8_192];
    let mut overflow = false;
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(collected.len());
        let keep = remaining.min(count);
        collected.extend_from_slice(&buffer[..keep]);
        overflow |= keep < count;
    }
    Ok((collected, overflow))
}

async fn await_task<T>(task: JoinHandle<T>, label: &str) -> Result<T, String> {
    task.await
        .map_err(|error| format!("{label} failed: {error}"))
}

async fn abort_helper_tasks(
    child: &mut Child,
    process_guard: &mut ProcessGuard,
    input_task: &JoinHandle<Result<(), String>>,
    output_task: &JoinHandle<std::io::Result<(Vec<u8>, bool)>>,
    diagnostic_task: &JoinHandle<std::io::Result<(Vec<u8>, bool)>>,
) {
    process_guard.terminate_group();
    let _ = child.kill().await;
    let _ = child.wait().await;
    input_task.abort();
    output_task.abort();
    diagnostic_task.abort();
}

#[cfg(windows)]
struct ReadyEvent {
    handle: windows_sys::Win32::Foundation::HANDLE,
    name: std::ffi::OsString,
}

#[cfg(windows)]
// SAFETY: the event handle is an opaque kernel object that may be waited on,
// signaled, and closed from any thread; ownership is transferred only once.
unsafe impl Send for ReadyEvent {}

#[cfg(windows)]
impl ReadyEvent {
    fn create() -> Result<Self, String> {
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
struct ProcessGuard {
    job: windows_sys::Win32::Foundation::HANDLE,
    ready_event: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
// SAFETY: moving the opaque Job Object handle between threads does not change
// its kernel-managed process membership or lifetime semantics.
unsafe impl Send for ProcessGuard {}

#[cfg(windows)]
impl ProcessGuard {
    fn terminate_group(&mut self) {}

    fn attach(pid: u32, ready_event: ReadyEvent) -> std::io::Result<Self> {
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

#[cfg(all(test, windows))]
mod tests {
    use super::{ProcessGuard, ReadyEvent};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[test]
    fn dropping_the_workflow_job_terminates_its_worker_process() {
        const CHILD_MARKER: &str = "PIPLINE_TEST_WORKFLOW_JOB_CHILD";
        const EVENT_ENV: &str = "PIPLINE_TEST_WORKFLOW_JOB_EVENT";
        const STARTED_EVENT_ENV: &str = "PIPLINE_TEST_WORKFLOW_JOB_STARTED_EVENT";
        const ALIVE_EVENT_ENV: &str = "PIPLINE_TEST_WORKFLOW_JOB_ALIVE_EVENT";

        if std::env::var_os(CHILD_MARKER).is_some() {
            wait_for_parent_job_assignment(EVENT_ENV, STARTED_EVENT_ENV, ALIVE_EVENT_ENV);
            return;
        }

        let event = ReadyEvent::create().expect("create test readiness event");
        let started_event = ReadyEvent::create().expect("create test started event");
        let alive_event = ReadyEvent::create().expect("create test alive event");
        let mut child = Command::new(std::env::current_exe().expect("test executable path"))
            .arg("--exact")
            .arg("workflow_code_process::tests::dropping_the_workflow_job_terminates_its_worker_process")
            .arg("--nocapture")
            .env(CHILD_MARKER, "1")
            .env(EVENT_ENV, &event.name)
            .env(STARTED_EVENT_ENV, &started_event.name)
            .env(ALIVE_EVENT_ENV, &alive_event.name)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn isolated child test process");
        let worker_pid = child.id();
        let process_guard = match ProcessGuard::attach(worker_pid, event) {
            Ok(guard) => guard,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("assign child to a kill-on-close Job Object: {error}");
            }
        };

        let ready_status = unsafe {
            windows_sys::Win32::System::Threading::WaitForSingleObject(started_event.handle, 3_000)
        };
        assert_eq!(
            ready_status,
            windows_sys::Win32::Foundation::WAIT_OBJECT_0,
            "worker did not confirm startup inside the assigned Job Object"
        );

        drop(process_guard);
        let alive_status = unsafe {
            windows_sys::Win32::System::Threading::WaitForSingleObject(alive_event.handle, 500)
        };
        assert_eq!(
            alive_status,
            windows_sys::Win32::Foundation::WAIT_TIMEOUT,
            "worker continued running after its Job Object was closed"
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if child.try_wait().expect("poll child process").is_some() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Job Object did not terminate child");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_for_parent_job_assignment(
        event_env: &str,
        started_event_env: &str,
        alive_event_env: &str,
    ) {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{OpenEventW, WaitForSingleObject, INFINITE};

        let name = std::env::var_os(event_env).expect("parent event name");
        let wide: Vec<u16> = name.encode_wide().chain(Some(0)).collect();
        // SAFETY: the event name is NUL-terminated and the returned handle is
        // checked before waiting and closed exactly once.
        unsafe {
            let handle = OpenEventW(0x0010_0000, 0, wide.as_ptr()); // SYNCHRONIZE access
            assert!(!handle.is_null(), "open parent readiness event");
            assert_eq!(WaitForSingleObject(handle, INFINITE), WAIT_OBJECT_0);
            CloseHandle(handle);
        }
        let started_name = std::env::var_os(started_event_env).expect("parent started event name");
        let started_wide: Vec<u16> = started_name.encode_wide().chain(Some(0)).collect();
        let alive_name = std::env::var_os(alive_event_env).expect("parent alive event name");
        let alive_wide: Vec<u16> = alive_name.encode_wide().chain(Some(0)).collect();
        // SAFETY: the event name is NUL-terminated and its handle is checked
        // before signaling and closed exactly once.
        unsafe {
            let alive_handle = OpenEventW(0x0002, 0, alive_wide.as_ptr()); // EVENT_MODIFY_STATE
            assert!(!alive_handle.is_null(), "open parent alive event");
            let handle = OpenEventW(0x0002, 0, started_wide.as_ptr()); // EVENT_MODIFY_STATE
            assert!(!handle.is_null(), "open parent started event");
            assert_ne!(windows_sys::Win32::System::Threading::SetEvent(handle), 0);
            CloseHandle(handle);
            std::thread::sleep(Duration::from_millis(200));
            assert_ne!(
                windows_sys::Win32::System::Threading::SetEvent(alive_handle),
                0
            );
            CloseHandle(alive_handle);
        }
        loop {
            std::thread::sleep(Duration::from_secs(60));
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
struct ProcessGuard(Option<i32>);

#[cfg(unix)]
impl ProcessGuard {
    fn attach(pid: u32) -> std::io::Result<Self> {
        let pid = i32::try_from(pid)
            .map_err(|_| std::io::Error::other("workflow helper PID is out of range"))?;
        Ok(Self(Some(pid)))
    }

    fn terminate_group(&mut self) {
        if let Some(pid) = self.0.take() {
            unsafe { libc::kill(-pid, libc::SIGKILL) };
        }
    }

    fn disarm(&mut self) {
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
fn set_process_resource_limits() -> std::io::Result<()> {
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
struct ProcessGuard;

#[cfg(not(any(unix, windows)))]
impl ProcessGuard {
    fn terminate_group(&mut self) {}

    fn attach(_pid: u32) -> std::io::Result<Self> {
        Ok(Self)
    }
}
