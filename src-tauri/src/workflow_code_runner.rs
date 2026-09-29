// ABOUTME: Minimal JSON-over-stdio QuickJS runner for workflow user code.
// Platform-specific launchers constrain this process before accepting requests.
#![allow(dead_code)]

use rquickjs::{context::intrinsic, Context, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: u8 = 1;
const MAX_REQUEST_BYTES: usize = 1_200_000;
const MAX_SOURCE_BYTES: usize = 50_000;
const MAX_RESPONSE_BYTES: usize = 1_000_000;
const MAX_LOGS: usize = 100;
const MAX_LOG_CHARS: usize = 16_000;
const MAX_LOG_LINE_CHARS: usize = 1_000;
const MEMORY_LIMIT_BYTES: usize = 32 * 1024 * 1024;
const STACK_LIMIT_BYTES: usize = 512 * 1024;
const EXECUTION_LIMIT: Duration = Duration::from_secs(2);

pub fn platform_isolated_execution_available() -> bool {
    #[cfg(windows)]
    {
        true
    }
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let Ok(executable) = std::env::current_exe() else {
            return false;
        };
        let Some(contents) = executable.parent().and_then(std::path::Path::parent) else {
            return false;
        };
        let service = contents.join("XPCServices/app.pipline.desktop.workflow-runner.xpc/Contents");
        let Some(service_bundle) = service.parent() else {
            return false;
        };
        let service_executable = service.join("MacOS/PiplineWorkflowRunner");
        let worker_executable = service.join("MacOS/workflow-code-worker");
        if !service.join("Info.plist").is_file()
            || !service_executable.is_file()
            || !worker_executable.is_file()
        {
            return false;
        }
        let Ok(service_path) = CString::new(service_bundle.as_os_str().as_bytes()) else {
            return false;
        };
        let Ok(worker_path) = CString::new(worker_executable.as_os_str().as_bytes()) else {
            return false;
        };
        unsafe {
            pipline_workflow_code_is_sandboxed_at_path(service_path.as_ptr(), 1) != 0
                && pipline_workflow_code_is_sandboxed_at_path(worker_path.as_ptr(), 0) != 0
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        false
    }
}

// Windows starts this worker with an explicit zero-capability AppContainer
// token. The outer process only relays its inherited stdin/stdout/stderr.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct Request {
    protocol_version: u8,
    compiler_version: String,
    compiled_source: String,
    entry_fn: String,
    inputs: Value,
    params: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SuccessResponse {
    protocol_version: u8,
    ok: bool,
    output: Value,
    logs: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    protocol_version: u8,
    ok: bool,
    error: String,
}

pub fn run_stdio() -> i32 {
    run_stdio_with_platform_gate(platform_isolated_execution_available())
}

/// Entry point for the separately signed macOS worker shipped inside the XPC
/// service. Its executable signature carries the App Sandbox entitlement.
pub fn run_stdio_confined_worker() -> i32 {
    #[cfg(target_os = "macos")]
    {
        let sandboxed = unsafe { pipline_workflow_worker_has_sandbox_entitlement() != 0 };
        return run_stdio_with_platform_gate(sandboxed);
    }
    #[cfg(not(target_os = "macos"))]
    {
        write_response(&error_response(
            "The dedicated confined worker is only available on macOS".into(),
        ))
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn pipline_workflow_worker_has_sandbox_entitlement() -> u8;
    fn pipline_workflow_code_is_sandboxed_at_path(
        path: *const std::ffi::c_char,
        is_bundle: u8,
    ) -> u8;
}

fn run_stdio_with_platform_gate(platform_available: bool) -> i32 {
    if !platform_available {
        return write_response(&error_response(
            "Workflow code execution is disabled because this platform has no verified OS sandbox"
                .into(),
        ));
    }

    #[cfg(windows)]
    if std::env::args_os().nth(2).as_deref()
        != Some(std::ffi::OsStr::new("--workflow-code-runner-confined"))
    {
        return match launch_appcontainer_worker() {
            Ok(status) => status,
            Err(error) => write_response(&error_response(format!(
                "Cannot start AppContainer workflow worker: {error}"
            ))),
        };
    }

    let response = match read_request().and_then(execute) {
        Ok(response) => serde_json::to_vec(&response)
            .unwrap_or_else(|error| error_response(format!("Cannot encode result: {error}"))),
        Err(error) => error_response(error),
    };

    if response.len() > MAX_RESPONSE_BYTES {
        let fallback = error_response("Workflow code response exceeds the 1 MB limit".into());
        return write_response(&fallback);
    }
    write_response(&response)
}

#[cfg(windows)]
fn worker_command_line(executable: &std::path::Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    let mut command_line = quote_windows_argument(executable.as_os_str().encode_wide());
    command_line.extend(" --workflow-code-runner --workflow-code-runner-confined".encode_utf16());
    command_line.push(0);
    command_line
}

#[cfg(windows)]
fn quote_windows_argument(argument: impl IntoIterator<Item = u16>) -> Vec<u16> {
    let mut quoted = vec![b'"' as u16];
    let mut backslashes = 0usize;
    for unit in argument {
        if unit == b'\\' as u16 {
            backslashes += 1;
            continue;
        }
        if unit == b'"' as u16 {
            quoted.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
            quoted.push(unit);
            backslashes = 0;
            continue;
        }
        quoted.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
        backslashes = 0;
        quoted.push(unit);
    }
    quoted.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    quoted.push(b'"' as u16);
    quoted
}

#[cfg(windows)]
fn launch_appcontainer_worker() -> Result<i32, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{FreeSid, SECURITY_CAPABILITIES};
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, OpenEventW, ResumeThread, UpdateProcThreadAttribute,
        CREATE_NO_WINDOW, CREATE_SUSPENDED, EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        STARTF_USESTDHANDLES, STARTUPINFOEXW, SYNCHRONIZATION_SYNCHRONIZE,
    };

    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;
    const INFINITE: u32 = u32::MAX;
    const ERROR_ALREADY_EXISTS_HR: i32 = 0x8007_00b7u32 as i32;
    const WAIT_FAILED: u32 = u32::MAX;

    let args: Vec<_> = std::env::args_os().collect();
    if args.get(2).and_then(|arg| arg.to_str()) != Some("--workflow-code-runner-ready-event") {
        return Err("workflow helper startup handshake argument is missing".into());
    }
    let event_name: Vec<u16> = args
        .get(3)
        .ok_or_else(|| "workflow helper startup event name is missing".to_string())?
        .encode_wide()
        .chain(Some(0))
        .collect();
    let ready_event = unsafe { OpenEventW(SYNCHRONIZATION_SYNCHRONIZE, 0, event_name.as_ptr()) };
    if ready_event.is_null() {
        return Err(format!(
            "Cannot open workflow helper startup event: {}",
            std::io::Error::last_os_error()
        ));
    }
    let ready =
        unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(ready_event, 2_500) };
    unsafe { CloseHandle(ready_event) };
    if ready == WAIT_TIMEOUT {
        return Err("workflow helper parent did not complete the startup handshake".into());
    }
    if ready != WAIT_OBJECT_0 || ready == WAIT_FAILED {
        return Err("workflow helper startup handshake failed".into());
    }
    let profile_name: Vec<u16> = "Pipline.WorkflowCode.Worker"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let display_name = profile_name.clone();
    let description: Vec<u16> = "Pipline isolated workflow code worker"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut sid = std::ptr::null_mut();
    let create_hr = unsafe {
        CreateAppContainerProfile(
            profile_name.as_ptr(),
            display_name.as_ptr(),
            description.as_ptr(),
            std::ptr::null(),
            0,
            &mut sid,
        )
    };
    if create_hr < 0 {
        let derive_hr =
            unsafe { DeriveAppContainerSidFromAppContainerName(profile_name.as_ptr(), &mut sid) };
        if create_hr != ERROR_ALREADY_EXISTS_HR || derive_hr < 0 {
            if !sid.is_null() {
                unsafe { FreeSid(sid) };
            }
            return Err(format!(
                "AppContainer profile setup failed ({create_hr:#x}, {derive_hr:#x})"
            ));
        }
    }
    if sid.is_null() {
        return Err("AppContainer profile returned an empty SID".into());
    }

    let worker_dir = match prepare_appcontainer_worker(sid) {
        Ok(dir) => dir,
        Err(error) => {
            unsafe { FreeSid(sid) };
            return Err(error);
        }
    };
    let result = (|| {
        let mut capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: sid,
            Capabilities: std::ptr::null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        let mut attribute_bytes = 0usize;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 2, 0, &mut attribute_bytes);
        }
        if attribute_bytes == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut storage = vec![0u8; attribute_bytes];
        let attributes = storage.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(attributes, 2, 0, &mut attribute_bytes) } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        struct AttributeGuard(*mut std::ffi::c_void);
        impl Drop for AttributeGuard {
            fn drop(&mut self) {
                unsafe { DeleteProcThreadAttributeList(self.0) };
            }
        }
        let _attribute_guard = AttributeGuard(attributes);
        if unsafe {
            UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                (&mut capabilities as *mut SECURITY_CAPABILITIES).cast(),
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }

        let executable = worker_dir.join("pipline-workflow-worker.exe");
        let exe_wide: Vec<u16> = executable
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let mut cmdline = worker_command_line(&executable);
        let cwd_wide: Vec<u16> = worker_dir
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        startup.StartupInfo.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        startup.StartupInfo.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
        if [
            startup.StartupInfo.hStdInput,
            startup.StartupInfo.hStdOutput,
            startup.StartupInfo.hStdError,
        ]
        .iter()
        .any(|h| h.is_null() || *h == INVALID_HANDLE_VALUE)
        {
            return Err("workflow helper standard handles are unavailable".into());
        }
        let inherited_handles = [
            startup.StartupInfo.hStdInput,
            startup.StartupInfo.hStdOutput,
            startup.StartupInfo.hStdError,
        ];
        if unsafe {
            UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherited_handles.as_ptr().cast(),
                std::mem::size_of_val(&inherited_handles),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(format!(
                "Cannot restrict AppContainer inherited handles: {}",
                std::io::Error::last_os_error()
            ));
        }
        startup.lpAttributeList = attributes;
        let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let created = unsafe {
            CreateProcessW(
                exe_wide.as_ptr(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
                std::ptr::null(),
                cwd_wide.as_ptr(),
                (&startup as *const STARTUPINFOEXW).cast(),
                &mut info,
            )
        };
        if created == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let process: HANDLE = info.hProcess;
        let thread: HANDLE = info.hThread;
        if unsafe { ResumeThread(thread) } == u32::MAX {
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(process, 1);
                CloseHandle(thread);
                CloseHandle(process);
            }
            return Err(std::io::Error::last_os_error().to_string());
        }
        unsafe {
            CloseHandle(thread);
        }
        let wait = unsafe {
            windows_sys::Win32::System::Threading::WaitForSingleObject(process, INFINITE)
        };
        if wait != WAIT_OBJECT_0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(process, 1);
                CloseHandle(process);
            }
            return Err(error.to_string());
        }
        let mut exit_code = 1u32;
        if unsafe { GetExitCodeProcess(process, &mut exit_code) } == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(process);
            }
            return Err(error.to_string());
        }
        unsafe {
            CloseHandle(process);
        }
        Ok(exit_code as i32)
    })();
    let _ = std::fs::remove_dir_all(&worker_dir);
    unsafe {
        FreeSid(sid);
    }
    result
}

#[cfg(windows)]
fn prepare_appcontainer_worker(
    sid: windows_sys::Win32::Security::PSID,
) -> Result<std::path::PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::Isolation::GetAppContainerFolderPath;

    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoTaskMemFree(memory: *const std::ffi::c_void);
    }
    let mut sid_string = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut sid_string) } == 0 {
        return Err(format!(
            "Cannot format AppContainer SID: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut folder_string = std::ptr::null_mut();
    let hr = unsafe { GetAppContainerFolderPath(sid_string, &mut folder_string) };
    unsafe { LocalFree(sid_string.cast()) };
    if hr < 0 || folder_string.is_null() {
        if !folder_string.is_null() {
            unsafe { CoTaskMemFree(folder_string.cast()) };
        }
        return Err(format!("Cannot locate AppContainer private data: {hr:#x}"));
    }
    let mut length = 0usize;
    unsafe {
        while *folder_string.add(length) != 0 {
            length += 1;
        }
    }
    let folder = std::path::PathBuf::from(std::ffi::OsString::from_wide(unsafe {
        std::slice::from_raw_parts(folder_string, length)
    }));
    unsafe { CoTaskMemFree(folder_string.cast()) };

    let invocation_dir = folder.join(format!("workflow-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&invocation_dir)
        .map_err(|error| format!("Cannot create private AppContainer worker folder: {error}"))?;
    let destination = invocation_dir.join("pipline-workflow-worker.exe");
    let stage_result = (|| {
        let source = std::env::current_exe().map_err(|error| error.to_string())?;
        std::fs::copy(source, &destination).map_err(|error| error.to_string())?;
        Ok::<(), String>(())
    })();
    if let Err(error) = stage_result {
        let _ = std::fs::remove_dir_all(&invocation_dir);
        return Err(format!(
            "Cannot stage worker in AppContainer private data: {error}"
        ));
    }
    Ok(invocation_dir)
}

fn read_request() -> Result<Request, String> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read workflow code request: {error}"))?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("Workflow code request exceeds the 1.2 MB limit".into());
    }
    let request: Request =
        serde_json::from_slice(&bytes).map_err(|error| format!("Invalid request JSON: {error}"))?;
    if request.protocol_version != PROTOCOL_VERSION {
        return Err("Unsupported workflow code protocol version".into());
    }
    if request.compiler_version != "esbuild-wasm@0.28.0" {
        return Err("Unsupported workflow TypeScript compiler version".into());
    }
    if request.compiled_source.is_empty() || request.compiled_source.len() > MAX_SOURCE_BYTES {
        return Err("Workflow compiled artifact is empty or exceeds the 50 KB limit".into());
    }
    if !valid_identifier(&request.entry_fn) {
        return Err("Workflow code entryFn is not a valid identifier".into());
    }
    Ok(request)
}

fn execute(request: Request) -> Result<Vec<u8>, String> {
    let compiled_source = request.compiled_source;
    if compiled_source.contains('\0') {
        return Err("Workflow compiled artifact contains a NUL byte".into());
    }
    let request_json = serde_json::to_string(&serde_json::json!({
        "inputs": request.inputs,
        "params": request.params,
    }))
    .map_err(|error| format!("Cannot encode executor input: {error}"))?;
    let request_literal = serde_json::to_string(&request_json)
        .map_err(|error| format!("Cannot encode executor request: {error}"))?;

    let script = format!(
        r#"
        (async () => {{
          const __request = JSON.parse({request_literal});
          const __logs = [];
          let __logChars = 0;
          const __ctx = Object.freeze({{
            log: (...args) => {{
              if (__logs.length >= {max_logs} || __logChars >= {max_log_chars}) return;
              const line = args.map((value) => {{
                if (typeof value === "string") return value;
                try {{
                  const serialized = JSON.stringify(value);
                  return serialized === undefined ? String(value) : serialized;
                }} catch {{
                  return "[unserializable]";
                }}
              }}).join(" ").slice(0, {max_line_chars});
              const remaining = {max_log_chars} - __logChars;
              const bounded = line.slice(0, remaining);
              __logs.push(bounded);
              __logChars += bounded.length;
            }}
          }});
          {compiled_source}
          const __exports = globalThis.__piplineWorkflowExports;
          const __entry = __exports && __exports.__pipline_entry;
          if (typeof __entry !== "function") throw new Error("Configured entryFn was not declared");
          const __output = await __entry(__request.inputs, __request.params, __ctx);
          return JSON.stringify({{ output: __output === undefined ? null : __output, logs: __logs }});
        }})()
        "#,
        max_logs = MAX_LOGS,
        max_log_chars = MAX_LOG_CHARS,
        max_line_chars = MAX_LOG_LINE_CHARS,
        compiled_source = compiled_source,
    );

    let deadline = Instant::now() + EXECUTION_LIMIT;
    let runtime = Runtime::new().map_err(|error| format!("QuickJS init failed: {error}"))?;
    runtime.set_memory_limit(MEMORY_LIMIT_BYTES);
    runtime.set_max_stack_size(STACK_LIMIT_BYTES);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::builder()
        .with::<intrinsic::Eval>()
        .with::<intrinsic::Json>()
        .with::<intrinsic::Promise>()
        .with::<intrinsic::RegExpCompiler>()
        .with::<intrinsic::RegExp>()
        .with::<intrinsic::MapSet>()
        .build(&runtime)
        .map_err(|error| format!("QuickJS context creation failed: {error}"))?;
    let result = context.with(|ctx| {
        let promise = ctx.eval_promise(script)?;
        promise.finish::<String>()
    });
    let timed_out = Instant::now() >= deadline;
    drop(context);
    drop(runtime);

    let result = result.map_err(|error| {
        let message = error.to_string();
        if timed_out {
            "Workflow code exceeded the 2 second instruction-time limit".to_string()
        } else {
            format!("Workflow code failed: {message}")
        }
    })?;
    if result.len() > MAX_RESPONSE_BYTES {
        return Err("Workflow code output exceeds the 1 MB limit".into());
    }
    let parsed: Value = serde_json::from_str(&result)
        .map_err(|error| format!("Workflow code returned invalid JSON: {error}"))?;
    let output = parsed.get("output").cloned().unwrap_or(Value::Null);
    let logs = parsed
        .get("logs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .take(MAX_LOGS)
                .map(|line| line.chars().take(MAX_LOG_LINE_CHARS).collect())
                .collect()
        })
        .unwrap_or_default();
    let response = SuccessResponse {
        protocol_version: PROTOCOL_VERSION,
        ok: true,
        output,
        logs,
    };
    serde_json::to_vec(&response).map_err(|error| format!("Cannot encode result: {error}"))
}

fn valid_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(c) if c == '_' || c == '$' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c == '$' || c.is_ascii_alphanumeric())
}

fn error_response(message: String) -> Vec<u8> {
    serde_json::to_vec(&ErrorResponse {
        protocol_version: PROTOCOL_VERSION,
        ok: false,
        error: message.chars().take(2_000).collect(),
    })
    .unwrap_or_else(|_| {
        b"{\"protocolVersion\":1,\"ok\":false,\"error\":\"runner failure\"}".to_vec()
    })
}

fn write_response(response: &[u8]) -> i32 {
    let mut stdout = std::io::stdout().lock();
    if stdout.write_all(response).is_err() || stdout.write_all(b"\n").is_err() {
        return 1;
    }
    if stdout.flush().is_err() {
        1
    } else {
        0
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::{quote_windows_argument, worker_command_line};
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    #[test]
    fn appcontainer_worker_command_line_preserves_unpaired_windows_utf16_path_units() {
        use std::os::windows::ffi::OsStringExt;

        let mut path = r"C:\Users\".encode_utf16().collect::<Vec<_>>();
        path.push(0xD800);
        path.extend(r"\Dev Work\Pipline\worker.exe".encode_utf16());
        let executable = std::ffi::OsString::from_wide(&path);
        let executable = Path::new(&executable);
        let command_line = worker_command_line(executable);
        let mut expected = vec![b'"' as u16];
        expected.extend(path);
        expected.extend("\" --workflow-code-runner --workflow-code-runner-confined".encode_utf16());
        expected.push(0);
        assert_eq!(command_line, expected);
    }

    #[test]
    fn windows_argument_quoting_escapes_quotes_and_trailing_backslashes() {
        let argument = OsStr::new(r#"C:\Users\陈\folder\"quoted"\"#);
        let quoted = quote_windows_argument(argument.encode_wide());
        assert_eq!(
            String::from_utf16(&quoted).unwrap(),
            r#""C:\Users\陈\folder\\\"quoted\"\\""#
        );
    }
}

#[cfg(test)]
mod platform_tests {
    #[test]
    fn helper_execution_requires_an_available_os_confinement_backend() {
        assert_eq!(
            super::platform_isolated_execution_available(),
            cfg!(windows)
        );
    }
}
