use crate::terminal_profiles::ShellProbe;
use serde_json::Value;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub const WINDOWS_POWERSHELL_FALLBACK_ENV: &str = "PIPLINE_WINDOWS_POWERSHELL_FALLBACK";

pub fn windows_powershell_fallback(cwd: &Path, pi_agent_dir: Option<&Path>) -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }

    let home = dirs::home_dir();
    let global_settings_dir = pi_agent_dir.map(Path::to_path_buf);
    let project_settings_dir = cwd.join(".pi");
    let global_settings = global_settings_dir
        .as_ref()
        .and_then(|dir| read_settings(&dir.join("settings.json")));
    let project_settings = read_settings(&project_settings_dir.join("settings.json"));
    let shell_path_is_usable = configured_shell_path_is_usable(
        project_settings.as_ref(),
        global_settings.as_ref(),
        &project_settings_dir,
        global_settings_dir
            .as_deref()
            .unwrap_or_else(|| Path::new("")),
        home.as_deref().unwrap_or_else(|| Path::new("")),
    );
    let git_bash_discovered = crate::terminal_profiles::SystemShellProbe
        .discover_git_bash_root()
        .is_some();
    let path_bash_found = path_has_usable_bash(
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("SystemRoot").as_deref().map(Path::new),
    );

    should_fallback_to_powershell(
        true,
        shell_path_is_usable,
        git_bash_discovered,
        path_bash_found,
    )
}

pub fn should_fallback_to_powershell(
    is_windows: bool,
    configured_shell_path_is_usable: bool,
    git_bash_discovered: bool,
    path_bash_found: bool,
) -> bool {
    is_windows && !configured_shell_path_is_usable && !git_bash_discovered && !path_bash_found
}

fn read_settings(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn settings_shell_path(settings: &Value) -> Option<&str> {
    settings
        .get("shellPath")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
}

fn configured_shell_path(project: Option<&Value>, global: Option<&Value>) -> Option<String> {
    project
        .and_then(settings_shell_path)
        .or_else(|| global.and_then(settings_shell_path))
        .map(str::to_owned)
}

fn configured_shell_path_is_usable(
    project: Option<&Value>,
    global: Option<&Value>,
    project_settings_dir: &Path,
    global_settings_dir: &Path,
    home: &Path,
) -> bool {
    let Some(value) = configured_shell_path(project, global) else {
        return false;
    };
    let settings_dir = if project.and_then(settings_shell_path).is_some() {
        project_settings_dir
    } else {
        global_settings_dir
    };
    resolve_shell_path(&value, settings_dir, home).is_file()
}

fn resolve_shell_path(value: &str, settings_dir: &Path, home: &Path) -> PathBuf {
    if let Some(relative) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home.join(relative);
    }
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        settings_dir.join(path)
    }
}

fn path_has_usable_bash(path: Option<&OsStr>, system_root: Option<&Path>) -> bool {
    let Some(path) = path else {
        return false;
    };
    std::env::split_paths(path).any(|directory| {
        let candidate = directory.join("bash.exe");
        candidate.is_file() && !is_windows_system_bash_stub(&candidate, system_root)
    })
}

fn is_windows_system_bash_stub(path: &Path, system_root: Option<&Path>) -> bool {
    let Some(system_root) = system_root else {
        return false;
    };
    same_windows_path(path, &system_root.join("System32").join("bash.exe"))
}

fn same_windows_path(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        path.to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    normalize(left) == normalize(right)
}

#[cfg(test)]
mod tests {
    use super::{
        configured_shell_path, configured_shell_path_is_usable, path_has_usable_bash,
        resolve_shell_path, should_fallback_to_powershell,
    };
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn fallback_is_enabled_only_when_windows_has_no_usable_bash() {
        assert!(should_fallback_to_powershell(true, false, false, false));
        assert!(!should_fallback_to_powershell(false, false, false, false));
        assert!(!should_fallback_to_powershell(true, true, false, false));
        assert!(!should_fallback_to_powershell(true, false, true, false));
        assert!(!should_fallback_to_powershell(true, false, false, true));
    }

    #[test]
    fn project_shell_path_overrides_the_global_setting() {
        let project = json!({ "shellPath": "./tools/bash.exe" });
        let global = json!({ "shellPath": "C:/Program Files/Git/bin/bash.exe" });

        assert_eq!(
            configured_shell_path(Some(&project), Some(&global)).as_deref(),
            Some("./tools/bash.exe")
        );
    }

    #[test]
    fn empty_project_shell_path_falls_back_to_global_setting() {
        let project = json!({ "shellPath": "" });
        let global = json!({ "shellPath": "C:/Program Files/Git/bin/bash.exe" });

        assert_eq!(
            configured_shell_path(Some(&project), Some(&global)).as_deref(),
            Some("C:/Program Files/Git/bin/bash.exe")
        );
    }

    #[test]
    fn relative_and_home_shell_paths_resolve_against_their_expected_roots() {
        let settings_dir = Path::new("C:/Users/test/project/.pi");
        let home = Path::new("C:/Users/test");

        assert_eq!(
            resolve_shell_path("./tools/bash.exe", settings_dir, home),
            Path::new("C:/Users/test/project/.pi/tools/bash.exe")
        );
        assert_eq!(
            resolve_shell_path("~/bin/bash.exe", settings_dir, home),
            Path::new("C:/Users/test/bin/bash.exe")
        );
    }

    #[test]
    fn valid_project_shell_path_is_used_and_invalid_project_override_is_not_hidden_by_global() {
        let temp = tempfile::tempdir().unwrap();
        let project_settings_dir = temp.path().join("project").join(".pi");
        let global_settings_dir = temp.path().join("agent");
        std::fs::create_dir_all(&project_settings_dir).unwrap();
        std::fs::create_dir_all(&global_settings_dir).unwrap();
        let global_bash = global_settings_dir.join("bash.exe");
        std::fs::write(&global_bash, b"global bash").unwrap();
        let global = json!({ "shellPath": global_bash });
        let project = json!({ "shellPath": "./tools/bash.exe" });
        let project_bash = project_settings_dir.join("tools").join("bash.exe");
        std::fs::create_dir_all(project_bash.parent().unwrap()).unwrap();
        std::fs::write(&project_bash, b"project bash").unwrap();

        assert!(configured_shell_path_is_usable(
            Some(&project),
            Some(&global),
            &project_settings_dir,
            &global_settings_dir,
            temp.path()
        ));

        let invalid_project = json!({ "shellPath": "./missing/bash.exe" });
        assert!(!configured_shell_path_is_usable(
            Some(&invalid_project),
            Some(&global),
            &project_settings_dir,
            &global_settings_dir,
            temp.path()
        ));
    }

    #[test]
    fn path_bash_detection_ignores_only_the_windows_system32_wsl_stub() {
        let temp = tempfile::tempdir().unwrap();
        let system_root = temp.path().join("windows");
        let system32 = system_root.join("System32");
        let git_bin = temp.path().join("Git").join("bin");
        std::fs::create_dir_all(&system32).unwrap();
        std::fs::create_dir_all(&git_bin).unwrap();
        std::fs::write(system32.join("bash.exe"), b"wsl stub").unwrap();
        std::fs::write(git_bin.join("bash.exe"), b"git bash").unwrap();
        let path = std::env::join_paths([&system32]).unwrap();

        assert!(!path_has_usable_bash(
            Some(path.as_os_str()),
            Some(&system_root)
        ));
        let path = std::env::join_paths([&system32, &git_bin]).unwrap();
        assert!(path_has_usable_bash(
            Some(path.as_os_str()),
            Some(&system_root)
        ));
    }
}
