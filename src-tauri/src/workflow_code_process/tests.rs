// ABOUTME: Windows Job Object confinement tests for workflow_code_process.

use super::guard::{ProcessGuard, ReadyEvent};
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
        .arg(
            "workflow_code_process::tests::dropping_the_workflow_job_terminates_its_worker_process",
        )
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

fn wait_for_parent_job_assignment(event_env: &str, started_event_env: &str, alive_event_env: &str) {
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
