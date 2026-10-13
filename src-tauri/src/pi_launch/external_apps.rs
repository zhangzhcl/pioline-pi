// ABOUTME: External editor, terminal, file-manager, and URL launching helpers.

use serde::Serialize;
#[cfg(target_os = "macos")]
use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppTarget {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub app_name: Option<String>,
    pub command: Option<String>,
}

#[cfg(target_os = "macos")]
fn macos_installed_app_names() -> HashSet<String> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    let mut names = HashSet::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || path.extension().and_then(|ext| ext.to_str()) != Some("app") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                names.insert(stem.to_ascii_lowercase());
            }
        }
    }
    names
}

/// List launch targets Picot can use to open a workspace in an external app.
pub fn list_installed_apps() -> Vec<AppTarget> {
    let candidates: [(&str, &str, &[&str], &str); 6] = [
        ("vscode", "VS Code", &["Visual Studio Code", "Code"], "code"),
        ("cursor", "Cursor", &["Cursor"], "cursor"),
        (
            "webstorm",
            "WebStorm",
            &["WebStorm", "WebStorm EAP"],
            "webstorm",
        ),
        ("zed", "Zed", &["Zed"], "zed"),
        ("terminal", "Terminal", &["Terminal", "iTerm", "Warp"], ""),
        ("ghostty", "Ghostty", &["Ghostty"], ""),
    ];

    #[cfg(target_os = "macos")]
    {
        let installed = macos_installed_app_names();
        let mut targets = Vec::new();
        for (id, label, bundle_names, _command) in candidates {
            if let Some(app_name) = bundle_names
                .iter()
                .find(|name| installed.contains(&name.to_ascii_lowercase()))
            {
                targets.push(AppTarget {
                    id: id.to_string(),
                    label: label.to_string(),
                    kind: "app".to_string(),
                    app_name: Some((*app_name).to_string()),
                    command: None,
                });
            }
        }
        targets.push(AppTarget {
            id: "finder".to_string(),
            label: "Finder".to_string(),
            kind: "finder".to_string(),
            app_name: None,
            command: None,
        });
        targets
    }

    #[cfg(not(target_os = "macos"))]
    {
        let mut targets: Vec<AppTarget> = candidates
            .iter()
            .filter(|(_, _, _, command)| !command.is_empty())
            .map(|(id, label, _, command)| AppTarget {
                id: id.to_string(),
                label: label.to_string(),
                kind: "command".to_string(),
                app_name: None,
                command: Some(command.to_string()),
            })
            .collect();
        targets.push(AppTarget {
            id: "finder".to_string(),
            label: "File Manager".to_string(),
            kind: "finder".to_string(),
            app_name: None,
            command: None,
        });
        targets
    }
}

/// Open a project directory in an external app (editor / terminal / file manager). Blocking.
pub fn open_in_app(
    path: &str,
    app_name: Option<&str>,
    command: Option<&str>,
) -> Result<(), String> {
    let trimmed_path = path.trim();
    if trimmed_path.is_empty() {
        return Err("Missing path".to_string());
    }

    if let Some(command) = command.map(str::trim).filter(|command| !command.is_empty()) {
        let mut launcher = Command::new(command);
        crate::windows_child::hide_console(&mut launcher);
        let status = launcher
            .arg(trimmed_path)
            .status()
            .map_err(|error| format!("Failed to launch `{command}`: {error}"))?;
        if !status.success() {
            return Err(format!("`{command}` exited with status {status}"));
        }
        return Ok(());
    }

    if let Some(app_name) = app_name
        .map(str::trim)
        .filter(|app_name| !app_name.is_empty())
    {
        #[cfg(target_os = "macos")]
        let status = Command::new("open")
            .arg("-a")
            .arg(app_name)
            .arg(trimmed_path)
            .status();
        #[cfg(not(target_os = "macos"))]
        let status = {
            let mut launcher = Command::new(app_name);
            crate::windows_child::hide_console(&mut launcher);
            launcher.arg(trimmed_path).status()
        };

        let status = status.map_err(|error| format!("Failed to open `{app_name}`: {error}"))?;
        if !status.success() {
            return Err(format!("`{app_name}` failed to open (status {status})"));
        }
        return Ok(());
    }

    open_path(trimmed_path)
}

fn open_path(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(path).status();
    #[cfg(target_os = "windows")]
    let status = {
        let mut command = Command::new("explorer");
        crate::windows_child::hide_console(&mut command);
        command.arg(path).status()
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(path).status();

    match status.map_err(|error| format!("Failed to reveal path: {error}"))? {
        code if code.success() => Ok(()),
        code => Err(format!("File manager exited with status {code}")),
    }
}

/// Open a URL in the user's default browser via the OS opener. Blocking.
pub fn open_external(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Missing URL".to_string());
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(trimmed).status();
    #[cfg(target_os = "windows")]
    let status = {
        let mut command = Command::new("cmd");
        crate::windows_child::hide_console(&mut command);
        command.args(["/C", "start", "", trimmed]).status()
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(trimmed).status();

    match status.map_err(|error| format!("Failed to open URL: {error}"))? {
        code if code.success() => Ok(()),
        code => Err(format!("Opener exited with status {code}")),
    }
}
