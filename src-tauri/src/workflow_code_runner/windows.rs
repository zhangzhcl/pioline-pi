// ABOUTME: Windows AppContainer worker launcher and argument quoting for
// ABOUTME: workflow_code_runner.

pub(super) fn worker_command_line(executable: &std::path::Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    let mut command_line = quote_windows_argument(executable.as_os_str().encode_wide());
    command_line.extend(" --workflow-code-runner --workflow-code-runner-confined".encode_utf16());
    command_line.push(0);
    command_line
}

pub(super) fn quote_windows_argument(argument: impl IntoIterator<Item = u16>) -> Vec<u16> {
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

pub(super) fn launch_appcontainer_worker() -> Result<i32, String> {
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

#[cfg(test)]
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
