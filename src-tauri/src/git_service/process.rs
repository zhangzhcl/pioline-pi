// Git 子进程执行、工作区顶层边界校验与输出截断辅助函数。

use std::ffi::OsString;
use std::fs;
#[cfg(unix)]
use std::os::unix::ffi::OsStringExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::{
    GIT_NOT_FOUND, GIT_READ_DEADLINE, GIT_WRITE_DEADLINE, MAX_PUSH_OUTPUT_BYTES, MAX_STDERR_BYTES,
    MAX_STDOUT_BYTES,
};

pub(super) fn display_path(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

/// 解析 `root` 的规范化 Git 顶层目录并校验其与宿主推导的工作区根目录一致。
pub(super) fn assert_workspace_root(root: &Path) -> Result<(), String> {
    let output = git(root, &["rev-parse", "--show-toplevel"])?;
    let toplevel_str = String::from_utf8_lossy(&output).trim().to_string();
    if toplevel_str.is_empty() {
        return Err("not a git repository".into());
    }
    let host = fs::canonicalize(root).map_err(|e| format!("invalid workspace root: {e}"))?;
    let resolved =
        fs::canonicalize(&toplevel_str).map_err(|e| format!("invalid git toplevel: {e}"))?;
    if host != resolved {
        return Err(format!(
            "workspace root is nested inside another git repository ({} != {})",
            host.display(),
            resolved.display()
        ));
    }
    Ok(())
}

pub(super) fn path_arg(bytes: &[u8]) -> OsString {
    #[cfg(unix)]
    {
        OsString::from_vec(bytes.to_vec())
    }
    #[cfg(windows)]
    {
        OsString::from(String::from_utf8_lossy(bytes).into_owned())
    }
}

/// 截断 `git push` 的 stderr 输出以适配前端展示，保留包含拒绝原因与提示的尾部内容。
pub(super) fn bounded_push_output(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr).trim().to_string();
    if text.len() <= MAX_PUSH_OUTPUT_BYTES {
        return text;
    }
    let cut = text.len() - MAX_PUSH_OUTPUT_BYTES;
    let start = (cut..text.len())
        .find(|index| text.is_char_boundary(*index))
        .unwrap_or(text.len());
    format!("...{}", &text[start..])
}

pub fn is_git_unavailable(error: &str) -> bool {
    let message = error.trim();
    message == GIT_NOT_FOUND || message.eq_ignore_ascii_case("program not found")
}

pub(super) fn map_git_spawn_error(error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        GIT_NOT_FOUND.to_string()
    } else {
        error.to_string()
    }
}

pub(super) fn run_git(
    mut command: Command,
    deadline: Duration,
) -> Result<(Vec<u8>, Vec<u8>, bool), String> {
    let mut child = command.spawn().map_err(|err| map_git_spawn_error(&err))?;
    let stdout = child.stdout.take().ok_or("git stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("git stderr unavailable")?;
    let out_thread = thread::spawn(move || read_limited(stdout, MAX_STDOUT_BYTES));
    let err_thread = thread::spawn(move || read_limited(stderr, MAX_STDERR_BYTES));
    let deadline_at = Instant::now() + deadline;
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let (out, out_overflow) = out_thread
                .join()
                .map_err(|_| "git stdout reader failed".to_string())??;
            let (err, _err_overflow) = err_thread
                .join()
                .map_err(|_| "git stderr reader failed".to_string())??;
            if out_overflow {
                terminate_git(&mut child);
                return Err("Git output exceeded limit".into());
            }
            return Ok((out, err, status.success()));
        }
        if Instant::now() >= deadline_at {
            terminate_git(&mut child);
            let _ = out_thread.join();
            let _ = err_thread.join();
            return Err("Git command timed out".into());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn read_limited<R: std::io::Read>(mut reader: R, cap: usize) -> Result<(Vec<u8>, bool), String> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut overflow = false;
    loop {
        let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        if result.len() >= cap {
            overflow = true;
            continue;
        }
        let allowed = count.min(cap - result.len());
        result.extend_from_slice(&buffer[..allowed]);
        if result.len() >= cap {
            overflow = true;
        }
    }
    Ok((result, overflow))
}

fn terminate_git(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        let _ = libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub(super) fn git_command(root: &Path, args: impl IntoIterator<Item = OsString>) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Ok(canonical) = fs::canonicalize(root) {
        if let Some(path) = canonical.parent() {
            command.env("GIT_CEILING_DIRECTORIES", path);
        }
    }
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
    crate::windows_child::hide_console(&mut command);
    command
}

pub(super) fn git_os(root: &Path, args: &[OsString]) -> Result<Vec<u8>, String> {
    let (stdout, stderr, success) =
        run_git(git_command(root, args.iter().cloned()), GIT_WRITE_DEADLINE)?;
    if success || args.iter().any(|arg| arg == "diff") && args.iter().any(|arg| arg == "--no-index")
    {
        Ok(stdout)
    } else {
        Err(String::from_utf8_lossy(&stderr).to_string())
    }
}

pub(super) fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let owned = args.iter().map(OsString::from).collect::<Vec<_>>();
    let (stdout, stderr, success) = run_git(git_command(root, owned), GIT_READ_DEADLINE)?;
    if success || args.contains(&"diff") && args.contains(&"--no-index") {
        Ok(stdout)
    } else {
        Err(String::from_utf8_lossy(&stderr).to_string())
    }
}
