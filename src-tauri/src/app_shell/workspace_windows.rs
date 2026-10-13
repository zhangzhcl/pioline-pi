// 工作区窗口导航、新会话启动、远程工作区锚点打开与任务完成系统通知命令。

use std::fs;
use std::path::{Path, PathBuf};
use tauri::image::Image;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

use crate::app_shell::startup::{
    agent_inbox_path, ensure_agent_inbox_placeholder_session, ensure_agent_inbox_tasks_file,
};
use crate::host_server::HostServer;
use crate::pi_launch::PiLaunchResolver;
use crate::remote_workspace;
use crate::runtime_coordinator::RuntimeTarget;
use crate::{FocusedWorkspaceState, NativePiManagerState, WindowWorkspaceState, WorkspaceLauncher};

#[tauri::command]
pub(crate) async fn open_folder_as_workspace(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked
        .as_path()
        .ok_or_else(|| "Selected folder is not a local path".to_string())?
        .to_path_buf();
    open_workspace_at_path(&app, Some(&window), &path, None)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub(crate) async fn open_remote_workspace(
    app: AppHandle,
    window: WebviewWindow,
    connection: remote_workspace::RemoteWorkspaceRequest,
    password: Option<String>,
) -> Result<String, String> {
    let root = remote_workspace::remotes_root()?;
    let anchor = remote_workspace::prepare_remote_anchor(&connection, &root)?;
    if let Some(password) = password.as_deref() {
        remote_workspace::stash_password(&anchor, password.trim());
    }
    open_workspace_at_path(&app, Some(&window), &anchor, None)?;
    Ok(anchor.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) async fn open_new_session_in_workspace(
    app: AppHandle,
    window: WebviewWindow,
    project_path: String,
) -> Result<(), String> {
    let cwd = if project_path.trim().is_empty() {
        dirs::home_dir().ok_or_else(|| "User home directory is unavailable".to_string())?
    } else {
        let path = PathBuf::from(&project_path);
        if !path.is_dir() {
            return Err(format!("Project folder no longer exists: {project_path}"));
        }
        path
    };
    open_fresh_session_at_path(&app, Some(&window), &cwd)
}

#[tauri::command]
pub(crate) async fn open_session_in_project(
    app: AppHandle,
    window: WebviewWindow,
    project_path: String,
    session_id: String,
) -> Result<(), String> {
    let cwd = PathBuf::from(&project_path);
    if !cwd.is_dir() {
        return Err(format!("Project folder no longer exists: {project_path}"));
    }
    let session = session_id.trim();
    let resume = if session.is_empty() {
        None
    } else {
        Some(session.to_string())
    };
    open_workspace_at_path(&app, Some(&window), &cwd, resume.as_deref())
}

#[tauri::command]
pub(crate) async fn show_task_completion_notification(
    app: AppHandle,
    title: String,
    body: String,
    workspace_id: String,
    session_id: String,
) -> Result<(), String> {
    let host = app
        .try_state::<HostServer>()
        .ok_or_else(|| "Host server is not ready".to_string())?;
    let cwd = host.workspace_root_path(&workspace_id)?;

    #[cfg(target_os = "macos")]
    let _ = notify_rust::set_application(&app.config().identifier);

    let notification = notify_rust::Notification::new()
        .summary(&title)
        .body(&body)
        .show()
        .map_err(|error| format!("Cannot show task notification: {error}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        notification.wait_for_action(move |action| {
            if action == "__closed" {
                return;
            }
            if let Err(error) = open_workspace_at_path(&app, None, &cwd, Some(&session_id)) {
                log::error!("[picot-native] failed to open notification session: {error}");
            }
        });
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn ensure_agent_inbox_session(app: AppHandle) -> Result<(), String> {
    let cwd = agent_inbox_path()?;
    fs::create_dir_all(&cwd)
        .map_err(|error| format!("Cannot create Agent Inbox folder: {error}"))?;
    ensure_agent_inbox_tasks_file(&cwd)?;
    ensure_agent_inbox_placeholder_session(&cwd)?;

    let launcher = app
        .try_state::<WorkspaceLauncher>()
        .ok_or_else(|| "Workspace launcher is not ready".to_string())?;
    let host = app
        .try_state::<HostServer>()
        .ok_or_else(|| "Host server is not ready".to_string())?;
    let runtimes = app
        .try_state::<NativePiManagerState>()
        .ok_or_else(|| "Native runtime manager is not ready".to_string())?;
    let workspace_id = launcher
        .metadata
        .lock()
        .map_err(|_| "Pipline metadata store is unavailable".to_string())?
        .workspace_id_for_path(&cwd)?;

    host.register_workspace(&workspace_id, &cwd)?;
    if runtimes.statuses().is_ok_and(|statuses| {
        statuses
            .iter()
            .any(|status| status.target.workspace_id == workspace_id)
    }) {
        return Ok(());
    }
    let _ = spawn_fresh_runtime(&runtimes, &launcher.launch, &cwd, workspace_id)?;
    Ok(())
}

pub(crate) fn spawn_fresh_runtime(
    runtimes: &NativePiManagerState,
    launch: &PiLaunchResolver,
    cwd: &Path,
    workspace_id: String,
) -> Result<RuntimeTarget, String> {
    let session_id = format!("temporary-{}", uuid::Uuid::new_v4().simple());
    let instance_id = format!("instance-{}", uuid::Uuid::new_v4().simple());
    let target = RuntimeTarget::new(workspace_id, session_id, instance_id);
    let cwd_str = cwd.to_string_lossy().into_owned();
    let launch_spec = launch.native_launch_spec(&cwd_str, None)?;
    runtimes.spawn(target.clone(), &launch_spec)?;
    Ok(target)
}

pub(crate) fn open_fresh_session_at_path(
    app: &AppHandle,
    source_window: Option<&WebviewWindow>,
    cwd: &Path,
) -> Result<(), String> {
    let launcher = app
        .try_state::<WorkspaceLauncher>()
        .ok_or_else(|| "Workspace launcher is not ready".to_string())?;
    let host = app
        .try_state::<HostServer>()
        .ok_or_else(|| "Host server is not ready".to_string())?;
    let runtimes = app
        .try_state::<NativePiManagerState>()
        .ok_or_else(|| "Native runtime manager is not ready".to_string())?;
    let workspace_id = launcher
        .metadata
        .lock()
        .map_err(|_| "Pipline metadata store is unavailable".to_string())?
        .workspace_id_for_path(cwd)?;

    host.register_workspace(&workspace_id, cwd)?;
    let target = spawn_fresh_runtime(&runtimes, &launcher.launch, cwd, workspace_id.clone())?;
    if let Some(window) =
        source_window.filter(|window| window.label().starts_with("native-workspace-"))
    {
        return navigate_workspace_window(app, window, host.origin(), &target, true);
    }
    let label = format!("native-workspace-{workspace_id}");
    if let Some(existing) = app.get_webview_window(&label) {
        return navigate_workspace_window(app, &existing, host.origin(), &target, true);
    }
    if let Err(error) = open_native_workspace_window(app, host.origin(), &target) {
        let _ = runtimes.stop(&target);
        return Err(error);
    }
    Ok(())
}

pub(crate) fn open_workspace_at_path(
    app: &AppHandle,
    source_window: Option<&WebviewWindow>,
    cwd: &Path,
    resume_session_id: Option<&str>,
) -> Result<(), String> {
    let launcher = app
        .try_state::<WorkspaceLauncher>()
        .ok_or_else(|| "Workspace launcher is not ready".to_string())?;
    let host = app
        .try_state::<HostServer>()
        .ok_or_else(|| "Host server is not ready".to_string())?;
    let runtimes = app
        .try_state::<NativePiManagerState>()
        .ok_or_else(|| "Native runtime manager is not ready".to_string())?;

    let workspace_id = launcher
        .metadata
        .lock()
        .map_err(|_| "Pipline metadata store is unavailable".to_string())?
        .workspace_id_for_path(cwd)?;

    host.register_workspace(&workspace_id, cwd)?;

    let target = match resume_session_id {
        Some(id) => RuntimeTarget::new(
            workspace_id.clone(),
            id.to_string(),
            format!("instance-{}", uuid::Uuid::new_v4().simple()),
        ),
        None => spawn_fresh_runtime(&runtimes, &launcher.launch, cwd, workspace_id.clone())?,
    };

    if let Some(window) =
        source_window.filter(|window| window.label().starts_with("native-workspace-"))
    {
        return navigate_workspace_window(
            app,
            window,
            host.origin(),
            &target,
            resume_session_id.is_none(),
        );
    }

    let label = format!("native-workspace-{workspace_id}");
    if let Some(existing) = app.get_webview_window(&label) {
        return navigate_workspace_window(
            app,
            &existing,
            host.origin(),
            &target,
            resume_session_id.is_none(),
        );
    }

    if let Err(error) = open_native_workspace_window(app, host.origin(), &target) {
        if resume_session_id.is_none() {
            let _ = runtimes.stop(&target);
        }
        return Err(error);
    }
    Ok(())
}

pub(crate) fn native_workspace_url(
    host_origin: &str,
    target: &RuntimeTarget,
) -> Result<tauri::Url, String> {
    format!(
        "{}/app/workspaces/{}/sessions/{}",
        host_origin, target.workspace_id, target.session_id
    )
    .parse()
    .map_err(|error| format!("Invalid native Host URL: {error}"))
}

pub(crate) fn set_window_workspace(app: &AppHandle, label: &str, workspace_id: &str) {
    if let Some(state) = app.try_state::<WindowWorkspaceState>() {
        if let Ok(mut windows) = state.0.lock() {
            windows.insert(label.to_string(), workspace_id.to_string());
        }
    }
    if let Some(state) = app.try_state::<FocusedWorkspaceState>() {
        if let Ok(mut focused_workspace) = state.0.lock() {
            *focused_workspace = Some(workspace_id.to_string());
        }
    }
}

pub(crate) fn navigate_workspace_window(
    app: &AppHandle,
    window: &WebviewWindow,
    host_origin: &str,
    target: &RuntimeTarget,
    stop_target_on_error: bool,
) -> Result<(), String> {
    let url = native_workspace_url(host_origin, target)?;
    if let Err(error) = window.navigate(url) {
        if stop_target_on_error {
            if let Some(runtimes) = app.try_state::<NativePiManagerState>() {
                let _ = runtimes.stop(target);
            }
        }
        return Err(error.to_string());
    }
    set_window_workspace(app, window.label(), &target.workspace_id);
    if let Ok(minimized) = window.is_minimized() {
        if minimized {
            let _ = window.unminimize();
        }
    }
    if let Ok(visible) = window.is_visible() {
        if !visible {
            let _ = window.show();
        }
    }
    let _ = window.set_focus();
    activate_app(app);
    Ok(())
}

pub(crate) fn activate_app(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(move || {
            activate_macos_app();
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

#[cfg(target_os = "macos")]
fn activate_macos_app() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    if let Some(mtm) = MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        app.activate();
    }
}

pub(crate) fn open_native_workspace_window(
    app: &AppHandle,
    host_origin: &str,
    target: &RuntimeTarget,
) -> Result<(), String> {
    let label = format!("native-workspace-{}", target.workspace_id);
    let url = native_workspace_url(host_origin, target)?;
    let icon = Image::from_bytes(include_bytes!("../../icons/32x32.png"))
        .map_err(|error| format!("Failed to load window icon: {error}"))?;
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("Pipline")
        .inner_size(1300.0, 860.0)
        .min_inner_size(800.0, 600.0)
        .icon(icon)
        .map_err(|error| error.to_string())?;

    let builder = builder.decorations(true);
    let window = builder.build().map_err(|error| error.to_string())?;
    set_window_workspace(app, window.label(), &target.workspace_id);
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn open_fresh_session_for_focused_workspace(app: &AppHandle) -> Result<(), String> {
    let focused_window = app
        .webview_windows()
        .into_values()
        .find(|window| {
            window.label().starts_with("native-workspace-") && window.is_focused().unwrap_or(false)
        })
        .or_else(|| {
            let workspace_id = app
                .try_state::<FocusedWorkspaceState>()
                .and_then(|state| state.0.lock().ok().and_then(|guard| guard.clone()))?;
            app.get_webview_window(&format!("native-workspace-{workspace_id}"))
        })
        .ok_or_else(|| "No focused Pipline workspace window".to_string())?;

    let label = focused_window.label().to_string();
    let workspace_id = app
        .try_state::<WindowWorkspaceState>()
        .and_then(|state| {
            state
                .0
                .lock()
                .ok()
                .and_then(|windows| windows.get(&label).cloned())
        })
        .or_else(|| label.strip_prefix("native-workspace-").map(str::to_string))
        .ok_or_else(|| "Unable to resolve workspace for focused window".to_string())?;

    let host = app
        .try_state::<HostServer>()
        .ok_or_else(|| "Host server is not ready".to_string())?;
    let cwd = host.workspace_root_path(&workspace_id)?;
    open_fresh_session_at_path(app, Some(&focused_window), &cwd)
}
