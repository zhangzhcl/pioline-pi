// ABOUTME: Minimal JSON-over-stdio QuickJS runner for workflow user code.
// Platform-specific launchers constrain this process before accepting requests.

use rquickjs::{context::intrinsic, Context, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

#[cfg(windows)]
mod windows;

#[cfg(windows)]
use self::windows::launch_appcontainer_worker;

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
#[cfg(target_os = "macos")]
pub fn run_stdio_confined_worker() -> i32 {
    let sandboxed = unsafe { pipline_workflow_worker_has_sandbox_entitlement() != 0 };
    run_stdio_with_platform_gate(sandboxed)
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
