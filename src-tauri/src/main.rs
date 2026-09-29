#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(feature = "workflow-code-runner-prototype", not(debug_assertions)))]
compile_error!(
    "workflow-code-runner-prototype is a development-only experiment and cannot ship in release builds"
);

mod acp_launch;
mod acp_manager;
mod appimage_env;
mod child_supervision;
mod git_pi_runner;
mod git_service;
mod host_data;
mod host_git;
mod host_router;
mod host_server;
mod log_export;
mod markitdown_preview;
mod metadata_store;
mod model_health;
mod native_pi_manager;
mod package_updates;
mod pi_agent_dir;
mod pi_launch;
mod pi_rpc_bridge;
mod pi_shell_compat;
mod pi_tls;
mod remote_auth;
mod remote_workspace;
mod runtime_coordinator;
mod session_ui_profile_store;
mod settings_store;
mod skill_install;
mod skill_source_registry;
mod terminal_manager;
mod terminal_output;
mod terminal_profiles;
mod terminal_registry;
mod terminal_state_store;
mod window_owner;
mod windows_child;
#[cfg(feature = "workflow-code-runner-prototype")]
mod workflow_code_authorization;
#[cfg(feature = "workflow-code-runner-prototype")]
mod workflow_code_process;
#[cfg(feature = "workflow-code-runner-prototype")]
mod workflow_code_runner;

use host_server::HostServer;
use metadata_store::MetadataStore;
use native_pi_manager::NativePiManager;
use pi_launch::PiLaunchResolver;
use remote_auth::RemoteAuth;
use runtime_coordinator::RuntimeTarget;
use serde_json::Value;
use skill_source_registry::SkillSourceRegistry;
use std::cmp::Reverse;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::image::Image;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_dialog::MessageDialogKind;
use tauri_plugin_updater::UpdaterExt;

type NativePiManagerState = NativePiManager;
#[allow(dead_code)]
type SkillSourceRegistryState = Arc<SkillSourceRegistry>;

#[cfg(target_os = "macos")]
const MENU_NEW_SESSION_ID: &str = "picot-new-session";
// Set by build.rs only in the Pipline release workflow. Local builds do not
// guess an updater repository from a possibly Picot-only git remote.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BetaUpdateInfo {
    version: String,
    date: Option<String>,
    body: Option<String>,
}

fn beta_updater(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Updater>, String> {
    let Some(repository) = option_env!("PIPLINE_RELEASE_REPOSITORY") else {
        return Ok(None);
    };
    let endpoint = reqwest::Url::parse(&format!(
        "https://github.com/{repository}/releases/download/beta/latest.json"
    ))
    .map_err(|error| format!("Invalid beta updater endpoint: {error}"))?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| format!("Invalid beta updater configuration: {error}"))?
        .build()
        .map(Some)
        .map_err(|error| format!("Failed to initialize beta updater: {error}"))
}

#[tauri::command]
fn stable_updates_available() -> bool {
    option_env!("PIPLINE_RELEASE_REPOSITORY").is_some()
}

#[tauri::command]
async fn check_beta_update(app: AppHandle) -> Result<Option<BetaUpdateInfo>, String> {
    let updater = beta_updater(&app)?
        .ok_or_else(|| "Beta updates are unavailable in this non-release build".to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Beta update check failed: {error}"))?;
    Ok(update.map(|update| BetaUpdateInfo {
        version: update.version,
        date: update.date.map(|date| date.to_string()),
        body: update.body,
    }))
}

#[tauri::command]
async fn install_beta_update(app: AppHandle) -> Result<(), String> {
    let updater = beta_updater(&app)?
        .ok_or_else(|| "Beta updates are unavailable in this non-release build".to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Beta update check failed: {error}"))?
        .ok_or_else(|| "No beta update is available".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("Beta update installation failed: {error}"))
}

#[tauri::command]
async fn export_app_logs(app: AppHandle) -> Result<Option<usize>, String> {
    log_export::export_app_logs(app).await
}

/// Shared services needed to bring up an additional workspace window after
/// startup (when the user opens a folder as a new workspace).
struct WorkspaceLauncher {
    metadata: Arc<Mutex<MetadataStore>>,
    launch: PiLaunchResolver,
}

struct FocusedWorkspaceState(Mutex<Option<String>>);
struct WindowWorkspaceState(Mutex<HashMap<String, String>>);

fn valid_window_route_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[tauri::command]
async fn open_workflow_window(
    app: AppHandle,
    workspace_id: String,
    workflow_id: String,
    target: Option<RuntimeTarget>,
) -> Result<(), String> {
    if !valid_window_route_id(&workspace_id) || !valid_window_route_id(&workflow_id) {
        return Err("Workflow window route contains an invalid identifier".to_string());
    }
    let host = app
        .try_state::<HostServer>()
        .ok_or_else(|| "Host server is not ready".to_string())?;
    if let Some(target) = target.as_ref() {
        if target.workspace_id != workspace_id
            || !valid_window_route_id(&target.session_id)
            || !valid_window_route_id(&target.instance_id)
        {
            return Err("Workflow window target is invalid".to_string());
        }
    }
    let route_path = format!("/app/workspaces/{workspace_id}/workflows/{workflow_id}");
    let mut route = route_path.clone();
    let target_payload = target
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| error.to_string())?;
    if let Some(target) = target.as_ref() {
        route.push_str(&format!(
            "?sessionId={}&instanceId={}",
            target.session_id, target.instance_id
        ));
    }
    let url = format!("{}{}", host.origin(), route)
        .parse()
        .map_err(|error| format!("Invalid workflow window URL: {error}"))?;
    let label = format!("native-workflow-{workspace_id}");
    if let Some(window) = app.get_webview_window(&label) {
        let same_route = window
            .url()
            .map(|current| {
                current.origin().ascii_serialization() == host.origin()
                    && current.path() == route_path
            })
            .unwrap_or(false);
        if same_route {
            if let Some(target) = target_payload {
                window
                    .eval(format!(
                        "window.dispatchEvent(new CustomEvent('pipline:workflow-target-changed', {{detail:{target}}}));"
                    ))
                    .map_err(|error| format!("Cannot update workflow Pi session target: {error}"))?;
            }
        } else {
            window
                .eval(format!(
                    "window.dispatchEvent(new CustomEvent('pipline:workflow-navigation-requested', {{detail:{}}}));",
                    serde_json::to_string(&serde_json::json!({
                        "workflowId": workflow_id,
                        "target": target
                    }))
                    .map_err(|error| error.to_string())?
                ))
                .map_err(|error| format!("Cannot request workflow navigation: {error}"))?;
        }
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.show();
        let _ = window.set_focus();
        activate_app(&app);
        return Ok(());
    }
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|error| format!("Failed to load window icon: {error}"))?;
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .title("Pipline")
        .inner_size(1440.0, 960.0)
        .min_inner_size(960.0, 680.0)
        .icon(icon)
        .map_err(|error| error.to_string())?
        .decorations(true)
        .build()
        .map_err(|error| format!("Cannot create workflow window: {error}"))?;
    window
        .show()
        .map_err(|error| format!("Cannot show workflow window: {error}"))?;
    let _ = window.set_focus();
    activate_app(&app);
    Ok(())
}

#[tauri::command]
fn close_workflow_window(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let Some(workspace_id) = window.label().strip_prefix("native-workflow-") else {
        return Err("Only a workflow window may close itself".to_string());
    };
    window.hide().map_err(|error| error.to_string())?;
    notify_workflow_window_hidden(&app, workspace_id)
}

fn notify_workflow_window_hidden(app: &AppHandle, workspace_id: &str) -> Result<(), String> {
    let origin = app
        .try_state::<HostServer>()
        .ok_or_else(|| "Host server is not ready".to_string())?
        .origin()
        .to_string();
    for chat_window in app.webview_windows().into_values() {
        if !chat_window.label().starts_with("native-workspace-")
            || !chat_window
                .url()
                .map(|url| {
                    url.origin().ascii_serialization() == origin
                        && url.path().contains(&format!("/workspaces/{workspace_id}/"))
                })
                .unwrap_or(false)
        {
            continue;
        }
        chat_window
            .eval("window.dispatchEvent(new CustomEvent('pipline:workflow-window-hidden'));")
            .map_err(|error| format!("Cannot restore workflow view in conversation: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn set_workflow_window_title(window: WebviewWindow, title: String) -> Result<(), String> {
    if !window.label().starts_with("native-workflow-")
        || title.trim().is_empty()
        || title.len() > 256
    {
        return Err("Workflow window title is invalid".to_string());
    }
    window
        .set_title(title.trim())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn send_workflow_context(
    app: AppHandle,
    workspace_id: String,
    summary: Value,
) -> Result<(), String> {
    if !valid_window_route_id(&workspace_id) {
        return Err("Workflow context contains an invalid workspace identifier".to_string());
    }
    let serialized_summary = serde_json::to_string(&summary)
        .map_err(|error| format!("Invalid workflow context: {error}"))?;
    if serialized_summary.len() > 256 * 1024 {
        return Err("Workflow context exceeds 256 KiB".to_string());
    }
    let origin = app
        .try_state::<HostServer>()
        .ok_or_else(|| "Host server is not ready".to_string())?
        .origin()
        .to_string();
    let mut delivered = false;
    for window in app.webview_windows().into_values() {
        if !window.label().starts_with("native-workspace-")
            || !window
                .url()
                .map(|url| url.origin().ascii_serialization() == origin)
                .unwrap_or(false)
            || !window
                .url()
                .map(|url| url.path().contains(&format!("/workspaces/{workspace_id}/")))
                .unwrap_or(false)
        {
            continue;
        }
        window
            .eval(format!(
                "window.dispatchEvent(new CustomEvent('pipline:workflow-context', {{detail:{{summary:{}}}}}));",
                serialized_summary
            ))
            .map_err(|error| format!("Cannot send workflow context to chat: {error}"))?;
        delivered = true;
    }
    if delivered {
        Ok(())
    } else {
        Err("No conversation window is open for this workflow workspace".to_string())
    }
}

#[tauri::command]
fn set_workflow_run_lock(
    app: AppHandle,
    workspace_id: String,
    running: bool,
) -> Result<(), String> {
    if !valid_window_route_id(&workspace_id) {
        return Err("Workflow run lock contains an invalid workspace identifier".to_string());
    }
    let origin = app
        .try_state::<HostServer>()
        .ok_or_else(|| "Host server is not ready".to_string())?
        .origin()
        .to_string();
    let payload = serde_json::json!({ "running": running });
    for window in app.webview_windows().into_values() {
        if !window.label().starts_with("native-workspace-")
            || !window
                .url()
                .map(|url| url.origin().ascii_serialization() == origin)
                .unwrap_or(false)
            || !window
                .url()
                .map(|url| url.path().contains(&format!("/workspaces/{workspace_id}/")))
                .unwrap_or(false)
        {
            continue;
        }
        window
            .eval(format!(
                "window.dispatchEvent(new CustomEvent('pipline:workflow-run-lock', {{detail:{payload}}}));"
            ))
            .map_err(|error| format!("Cannot update conversation workflow lock: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn update_workflow_window_target(
    app: AppHandle,
    workspace_id: String,
    target: RuntimeTarget,
) -> Result<(), String> {
    if !valid_window_route_id(&workspace_id)
        || target.workspace_id != workspace_id
        || !valid_window_route_id(&target.session_id)
        || !valid_window_route_id(&target.instance_id)
    {
        return Err("Workflow window target is invalid".to_string());
    }
    let label = format!("native-workflow-{workspace_id}");
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(());
    };
    let value = serde_json::to_string(&target).map_err(|error| error.to_string())?;
    window
        .eval(format!(
            "window.dispatchEvent(new CustomEvent('pipline:workflow-target-changed', {{detail:{value}}}));"
        ))
        .map_err(|error| format!("Cannot update workflow Pi session target: {error}"))
}

/// Open the native folder picker and, if the user selects a directory, switch
/// the focused Picot window to that workspace. Returns the chosen path, or
/// `None` if cancelled.
#[tauri::command]
async fn open_folder_as_workspace(
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

/// Open a workspace that lives on a remote host. There is no local checkout to
/// pick, so the anchor directory is created for the user (see
/// `remote_workspace`), its `sshRemote` binding written, and the window opened
/// there — read/write/edit/bash then run over SSH from the first message.
#[tauri::command]
async fn open_remote_workspace(
    app: AppHandle,
    window: WebviewWindow,
    connection: remote_workspace::RemoteWorkspaceRequest,
    password: Option<String>,
) -> Result<String, String> {
    let root = remote_workspace::remotes_root()?;
    let anchor = remote_workspace::prepare_remote_anchor(&connection, &root)?;
    // Deliberately not part of the binding: a password stays in memory and is
    // injected into the workspace's pi process at spawn (native_pi_manager).
    if let Some(password) = password.as_deref() {
        remote_workspace::stash_password(&anchor, password.trim());
    }
    open_workspace_at_path(&app, Some(&window), &anchor, None)?;
    Ok(anchor.to_string_lossy().into_owned())
}

/// Open a brand-new session in the given workspace (identified by its
/// file-system path). If the workspace window is already open, spawn a fresh
/// runtime and navigate that window to the new temporary session; otherwise
/// open a new workspace window at the fresh session.
#[tauri::command]
async fn open_new_session_in_workspace(
    app: AppHandle,
    window: WebviewWindow,
    project_path: String,
) -> Result<(), String> {
    let cwd = PathBuf::from(&project_path);
    if !cwd.is_dir() {
        return Err(format!("Project folder no longer exists: {project_path}"));
    }
    open_fresh_session_at_path(&app, Some(&window), &cwd)
}

/// Switch the focused Picot window to `projectPath` and resume the given saved
/// session in it. Used by the sidebar to jump to a session that belongs to a
/// different project without opening a second project window.
#[tauri::command]
async fn open_session_in_project(
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

/// Show a task notification whose default click opens the completed session.
#[tauri::command]
async fn show_task_completion_notification(
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

/// Ensure the fixed Agent Inbox workspace exists, has a sidebar-visible saved
/// session, and has a background runtime running. Unlike normal project opens,
/// this command intentionally keeps the current window in place; the frontend
/// decides whether to navigate after the refreshed session list is available.
#[tauri::command]
async fn ensure_agent_inbox_session(app: AppHandle) -> Result<(), String> {
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

    host.register_workspace(&workspace_id, cwd.clone())?;
    if runtimes
        .statuses()
        .map(|statuses| {
            statuses
                .iter()
                .any(|status| status.target.workspace_id == workspace_id)
        })
        .unwrap_or(false)
    {
        return Ok(());
    }
    let _ = spawn_fresh_runtime(&runtimes, &launcher.launch, &cwd, workspace_id)?;
    Ok(())
}

/// Retry native startup from the bootstrap error window after a failed launch.
/// If startup already succeeded, just close the bootstrap window.
#[tauri::command]
async fn retry_startup(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if app.try_state::<HostServer>().is_some() {
        let _ = window.close();
        return Ok(());
    }
    let static_dir = find_static_dir(&app);
    setup_native_runtime(&app, static_dir)?;
    let _ = window.close();
    Ok(())
}

fn spawn_fresh_runtime(
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
    runtimes.spawn(target.clone(), launch_spec)?;
    Ok(target)
}

fn open_fresh_session_at_path(
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

    host.register_workspace(&workspace_id, cwd.to_path_buf())?;
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

fn open_workspace_at_path(
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

    host.register_workspace(&workspace_id, cwd.to_path_buf())?;

    // When resuming a saved session, navigate directly to that session id so
    // its history loads; otherwise start a fresh temporary session.
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

fn native_workspace_url(host_origin: &str, target: &RuntimeTarget) -> Result<tauri::Url, String> {
    format!(
        "{}/app/workspaces/{}/sessions/{}",
        host_origin, target.workspace_id, target.session_id
    )
    .parse()
    .map_err(|error| format!("Invalid native Host URL: {error}"))
}

fn set_window_workspace(app: &AppHandle, label: &str, workspace_id: &str) {
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

fn navigate_workspace_window(
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
    // Closely mirror Finder/Spotlight-style "open this item" behavior: a window
    // reached from a background notification click may be minimized, hidden, or
    // the app may simply not be the active application. `set_focus()` alone does
    // NOT unminimize a minimized window, and on macOS it does not activate the
    // app when we are in the background, so clicking a notification would
    // silently navigate the window without bringing Picot to the front.
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

/// Bring the running Picot application to the foreground. `set_focus()` on a
/// window is often not enough when the app is in the background (e.g. after a
/// notification click on macOS); here we additionally activate the application
/// so macOS orders it to the front.
fn activate_app(app: &AppHandle) {
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

/// Activates the running Cocoa application. On macOS 14+ `activate` (the
/// replacement for the deprecated `activateIgnoringOtherApps:`) orders the app
/// to the front even if we are currently in the background, which is what a
/// notification click should do.
#[cfg(target_os = "macos")]
fn activate_macos_app() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    // We are guaranteed to be on the main thread (called from
    // `run_on_main_thread`), so acquiring the marker is sound.
    if let Some(mtm) = MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        app.activate();
    }
}

fn open_native_workspace_window(
    app: &AppHandle,
    host_origin: &str,
    target: &RuntimeTarget,
) -> Result<(), String> {
    let label = format!("native-workspace-{}", target.workspace_id);
    let url = native_workspace_url(host_origin, target)?;
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
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
fn open_fresh_session_for_focused_workspace(app: &AppHandle) -> Result<(), String> {
    // Resolve the *actual* workspace window that currently has OS focus. Passing
    // this real window (instead of None) to `open_fresh_session_at_path`
    // guarantees the new session opens inside the focused window, rather than
    // falling back to a fragile label lookup that can spawn a brand-new window
    // when the global focus state is stale.
    let focused_window = app
        .webview_windows()
        .into_values()
        .find(|window| {
            window.label().starts_with("native-workspace-") && window.is_focused().unwrap_or(false)
        })
        .or_else(|| {
            // No window reports OS focus (e.g. focus was on the menu bar at
            // trigger time): fall back to the last-focused workspace id and look
            // up its existing window.
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

// With a native menu bar installed, macOS wires WKWebView's text-input
// context fully — including the "Press and Hold" accent picker, which
// swallows key auto-repeat and pops the diacritic popover (hold "u" → ü…).
// Terminal-style repeat requires the picker off; the flag lives in this
// app's own defaults domain, so the change is scoped to Picot only. Must run
// before the first webview creates its NSTextInputContext.
#[cfg(target_os = "macos")]
fn set_press_and_hold_enabled(setter: impl FnOnce(bool)) {
    setter(false);
}

#[cfg(target_os = "macos")]
fn disable_press_and_hold_accents() {
    use objc2_foundation::{NSString, NSUserDefaults};
    set_press_and_hold_enabled(|enabled| {
        let key = NSString::from_str("ApplePressAndHoldEnabled");
        NSUserDefaults::standardUserDefaults().setBool_forKey(enabled, &key);
    });
}

// Native menus belong in the macOS system menu bar. On Windows/Linux, Tauri
// draws the same items inside the window as File/Edit/Window/Help, which we
// do not want. New Session (Ctrl+N) is handled in the frontend.
#[cfg(target_os = "macos")]
fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let new_session = MenuItem::with_id(
        app,
        MENU_NEW_SESSION_ID,
        "New Session",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_session,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let help = Submenu::with_items(app, "Help", true, &[])?;
    let app_menu = Submenu::with_items(
        app,
        app.package_info().name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

fn open_bootstrap_window(app: &AppHandle, startup_error: &str) -> Result<(), String> {
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|error| format!("Failed to load window icon: {error}"))?;
    let encoded_error = startup_error
        .replace('&', "%26")
        .replace(' ', "%20")
        .replace('\n', "%0A");
    let url = format!("bootstrap.html?startupError={encoded_error}");
    let builder = WebviewWindowBuilder::new(app, "bootstrap", WebviewUrl::App(url.into()))
        .title("Pipline")
        .inner_size(900.0, 640.0)
        .min_inner_size(700.0, 480.0)
        .icon(icon)
        .map_err(|error| error.to_string())?;

    let builder = builder.decorations(true);
    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

fn canonical_if_exists(dir: PathBuf) -> Option<PathBuf> {
    if dir.join("index.html").exists() {
        Some(fs::canonicalize(&dir).unwrap_or(dir))
    } else {
        None
    }
}

fn resolve_static_dir(
    resource_dir: Option<PathBuf>,
    workspace_public: PathBuf,
    current_dir: Option<PathBuf>,
    debug_assertions: bool,
) -> PathBuf {
    let bundled_public = resource_dir.as_ref().map(|dir| dir.join("public"));
    let current_public = current_dir.unwrap_or_default().join("public");

    if debug_assertions {
        if let Some(dir) = canonical_if_exists(workspace_public) {
            return dir;
        }
        if let Some(dir) = canonical_if_exists(current_public.clone()) {
            return dir;
        }
        return current_public;
    }

    if let Some(dir) = bundled_public.and_then(canonical_if_exists) {
        return dir;
    }

    resource_dir
        .map(|dir| dir.join("public"))
        .unwrap_or_else(|| PathBuf::from("public"))
}

fn find_static_dir(app: &AppHandle) -> PathBuf {
    resolve_static_dir(
        app.path().resource_dir().ok(),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("public"),
        std::env::current_dir().ok(),
        cfg!(debug_assertions),
    )
}

fn agent_inbox_path() -> Result<PathBuf, String> {
    pi_agent_dir::agent_dir()
        .map(|agent_dir| agent_dir.join("super-agent"))
        .ok_or_else(|| "Cannot resolve Pi agent directory for Agent Inbox".to_string())
}

/// Encode a cwd the same way pi does for `~/.pi/agent/sessions/<dir>/`.
/// Leading `/` or `\` is stripped, then `/`, `\`, and `:` become `-`, so a
/// Windows path like `C:\Users\me\.pi\agent\super-agent` becomes
/// `--C--Users-me-.pi-agent-super-agent--` instead of a name containing `:`.
fn session_dir_name(cwd: &Path) -> String {
    let raw = cwd.to_string_lossy();
    let stripped = raw
        .strip_prefix('/')
        .or_else(|| raw.strip_prefix('\\'))
        .unwrap_or(raw.as_ref());
    format!("--{}--", stripped.replace(['/', '\\', ':'], "-"))
}

fn now_unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn now_iso_timestamp() -> String {
    let millis = now_unix_millis();
    let seconds = millis / 1000;
    let sub_millis = millis % 1000;
    format!("{seconds}.{sub_millis:03}Z")
}

/// Create `tasks.json` in the Agent Inbox workspace if it does not already
/// exist. The file is the authoritative task store for the Runtime panel,
/// persisted through the picot-config bridge (`read_super_agent_tasks` /
/// `write_super_agent_tasks`). Creating it eagerly on first open guarantees
/// the inbox context is bootstrapped before any task reads arrive.
fn ensure_agent_inbox_tasks_file(cwd: &Path) -> Result<(), String> {
    let tasks_path = cwd.join("tasks.json");
    if tasks_path.exists() {
        return Ok(());
    }
    let default = r#"{"tasks":[]}"#;
    fs::write(&tasks_path, default)
        .map_err(|error| format!("Cannot create Agent Inbox tasks.json: {error}"))?;
    Ok(())
}

fn ensure_agent_inbox_placeholder_session(cwd: &Path) -> Result<(), String> {
    if find_latest_session_for_cwd(cwd).is_some() {
        return Ok(());
    }
    let sessions_root = pi_agent_dir::agent_dir()
        .ok_or_else(|| "Cannot resolve Pi agent directory for Agent Inbox sessions".to_string())?
        .join("sessions")
        .join(session_dir_name(cwd));
    fs::create_dir_all(&sessions_root)
        .map_err(|error| format!("Cannot create Agent Inbox session folder: {error}"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let path = sessions_root.join(format!("{}_{}.jsonl", now_unix_millis(), id));
    let timestamp = now_iso_timestamp();
    let cwd_json = serde_json::to_string(&cwd.to_string_lossy().into_owned())
        .map_err(|error| format!("Cannot encode Agent Inbox path: {error}"))?;
    let mut file = File::create(&path)
        .map_err(|error| format!("Cannot create Agent Inbox session file: {error}"))?;
    writeln!(
        file,
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"{timestamp}\",\"cwd\":{cwd_json}}}"
    )
    .map_err(|error| format!("Cannot write Agent Inbox session header: {error}"))?;
    writeln!(
        file,
        "{{\"type\":\"session_info\",\"id\":\"{}\",\"parentId\":null,\"timestamp\":\"{timestamp}\",\"name\":\"Agent Inbox\"}}",
        uuid::Uuid::new_v4().simple()
    )
    .map_err(|error| format!("Cannot write Agent Inbox session name: {error}"))?;
    Ok(())
}

fn find_latest_session_for_cwd(cwd: &Path) -> Option<PathBuf> {
    let sessions_root = pi_agent_dir::sessions_dir()?;
    list_session_files(&sessions_root)
        .into_iter()
        .filter(|path| {
            extract_session_cwd(path)
                .map(|session_cwd| same_dir(Path::new(&session_cwd), cwd))
                .unwrap_or(false)
        })
        .filter_map(|path| {
            let mtime = fs::metadata(&path).ok()?.modified().ok()?;
            Some((mtime, path))
        })
        .max_by_key(|(mtime, _)| *mtime)
        .map(|(_, path)| path)
}

fn same_dir(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn list_session_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(inner_entries) = fs::read_dir(path) else {
            continue;
        };
        for inner in inner_entries.flatten() {
            let session_path = inner.path();
            if session_path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
                files.push(session_path);
            }
        }
    }
    files
}

fn extract_session_cwd(session_path: &Path) -> Option<String> {
    let file = File::open(session_path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(200).flatten() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        let cwd = value.get("cwd").and_then(Value::as_str)?.trim();
        if cwd.is_empty() {
            return None;
        }
        return Some(cwd.to_string());
    }
    None
}

fn choose_latest_existing_boot_target(
    session_cwds_newest_first: impl IntoIterator<Item = (String, String)>,
) -> Option<(String, String)> {
    for (cwd, session_path) in session_cwds_newest_first {
        if Path::new(&cwd).is_dir() {
            return Some((cwd, session_path));
        }
        log::info!("[picot-native] startup skipped missing workspace {cwd} from {session_path}");
    }
    None
}

fn find_latest_session_boot_target() -> Option<(String, String)> {
    let sessions_root = pi_agent_dir::sessions_dir()?;
    if !sessions_root.exists() {
        log::info!(
            "[picot-native] startup target skipped: sessions dir not found at {}",
            sessions_root.display()
        );
        return None;
    }

    let mut ranked: Vec<(std::time::SystemTime, PathBuf)> = list_session_files(&sessions_root)
        .into_iter()
        .filter_map(|path| {
            let mtime = fs::metadata(&path).ok()?.modified().ok()?;
            Some((mtime, path))
        })
        .collect();
    ranked.sort_by_key(|(mtime, _)| Reverse(*mtime));
    let candidates = ranked.into_iter().filter_map(|(_, session_path)| {
        let cwd = extract_session_cwd(&session_path)?;
        Some((cwd, session_path.to_string_lossy().into_owned()))
    });
    choose_latest_existing_boot_target(candidates)
}

fn select_fresh_startup_target(
    home_cwd: String,
    latest_session: Option<(String, String)>,
) -> (String, Option<String>) {
    let cwd = latest_session
        .and_then(|(session_cwd, _session_path)| {
            Path::new(&session_cwd).is_dir().then_some(session_cwd)
        })
        .unwrap_or(home_cwd);
    (cwd, None)
}

fn setup_native_runtime(app: &AppHandle, static_dir: PathBuf) -> Result<(), String> {
    let home_cwd = pi_agent_dir::home_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let (cwd, session_path) =
        select_fresh_startup_target(home_cwd, find_latest_session_boot_target());
    let metadata_path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Pipline app data directory: {error}"))?
        .join("picot.sqlite3");
    let metadata = Arc::new(Mutex::new(MetadataStore::open(&metadata_path)?));
    let workspace_id = metadata
        .lock()
        .map_err(|_| "Pipline metadata store is unavailable".to_string())?
        .workspace_id_for_path(Path::new(&cwd))?;
    let session_id = format!("temporary-{}", uuid::Uuid::new_v4().simple());
    let target = RuntimeTarget::new(
        workspace_id,
        session_id,
        format!("instance-{}", uuid::Uuid::new_v4().simple()),
    );
    let launch_resolver = PiLaunchResolver::new(static_dir.clone());
    let launch = launch_resolver.native_launch_spec(&cwd, session_path.as_deref())?;
    let runtimes = NativePiManager::new(256);
    let remote_auth = Arc::new(Mutex::new(RemoteAuth::new(metadata.clone())));
    let host = tauri::async_runtime::block_on(async {
        let host = HostServer::start_with_workspaces(
            static_dir,
            runtimes.clone(),
            remote_auth,
            std::collections::HashMap::from([(target.workspace_id.clone(), PathBuf::from(&cwd))]),
            Some(app.clone()),
            Some(Arc::clone(&metadata)),
        )
        .await?;
        runtimes.spawn(target.clone(), launch)?;
        Ok::<HostServer, String>(host)
    })?;
    if let Err(error) = open_native_workspace_window(app, host.origin(), &target) {
        runtimes.stop_all();
        return Err(error);
    }
    log::info!(
        "[picot-native] started workspace_id={} session_id={} instance_id={} origin={}",
        target.workspace_id,
        target.session_id,
        target.instance_id,
        host.origin()
    );
    app.manage(runtimes);
    app.manage(host);
    app.manage(WorkspaceLauncher {
        metadata,
        launch: launch_resolver,
    });
    app.manage(FocusedWorkspaceState(Mutex::new(Some(
        target.workspace_id.clone(),
    ))));
    let window_workspaces = HashMap::from([(
        format!("native-workspace-{}", target.workspace_id),
        target.workspace_id.clone(),
    )]);
    app.manage(WindowWorkspaceState(Mutex::new(window_workspaces)));
    Ok(())
}

fn main() {
    #[cfg(all(feature = "workflow-code-runner-prototype", windows))]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--workflow-code-runner"))
    {
        // This private helper mode remains disconnected from workflow Runs.
        // On Windows it acts as a trusted stdio shim that launches the actual
        // QuickJS worker inside a zero-capability AppContainer.
        std::process::exit(workflow_code_runner::run_stdio());
    }

    if let Err(error) = fix_path_env::fix_all_vars() {
        eprintln!("[picot] failed to sync login-shell environment: {error}");
    }

    // Runtimes left behind by a Picot that was killed outright: no teardown of
    // ours ran for those, so this is the only chance to collect them.
    let swept = child_supervision::sweep_orphans();
    if swept > 0 {
        log::info!("[picot-native] cleaned up {swept} orphaned pi runtime(s) from a previous run");
    }

    #[cfg(target_os = "macos")]
    disable_press_and_hold_accents();

    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_app_menu).on_menu_event(|app, event| {
        if event.id().as_ref() == MENU_NEW_SESSION_ID {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = open_fresh_session_for_focused_workspace(&app) {
                    log::error!("[picot-native] failed to open new session from menu: {error}");
                }
            });
        }
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            open_workflow_window,
            close_workflow_window,
            set_workflow_window_title,
            send_workflow_context,
            set_workflow_run_lock,
            update_workflow_window_target,
            open_folder_as_workspace,
            open_remote_workspace,
            open_new_session_in_workspace,
            open_session_in_project,
            show_task_completion_notification,
            ensure_agent_inbox_session,
            retry_startup,
            stable_updates_available,
            check_beta_update,
            install_beta_update,
            export_app_logs
        ])
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("tokio_util", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let static_dir = find_static_dir(&handle);
            if let Err(error) = setup_native_runtime(&handle, static_dir) {
                log::error!("[picot-native] startup failed: {error}");
                if let Err(window_error) = open_bootstrap_window(&handle, &error) {
                    log::error!(
                        "[picot-native] failed to open bootstrap window after startup error: {window_error}"
                    );
                    app.dialog()
                        .message(format!(
                            "Pipline could not start the embedded pi runtime.\n\n{error}\n\nThe Pipline installation may be incomplete or corrupted. Please reinstall Pipline and try again."
                        ))
                        .title("Pipline startup failed")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label();
            match event {
                tauri::WindowEvent::CloseRequested { api, .. }
                    if label.starts_with("native-workflow-") =>
                {
                    api.prevent_close();
                    let _ = window.hide();
                    if let Some(workspace_id) = label.strip_prefix("native-workflow-") {
                        let _ = notify_workflow_window_hidden(window.app_handle(), workspace_id);
                    }
                }
                tauri::WindowEvent::Destroyed if label.starts_with("native-workflow-") => {
                    if let Some(workspace_id) = label.strip_prefix("native-workflow-") {
                        let origin = window
                            .try_state::<HostServer>()
                            .map(|host| host.origin().to_string());
                        if let Some(origin) = origin {
                            for chat_window in window.app_handle().webview_windows().into_values() {
                                if !chat_window.label().starts_with("native-workspace-")
                                    || !chat_window
                                        .url()
                                        .map(|url| {
                                            url.origin().ascii_serialization() == origin
                                                && url.path().contains(&format!("/workspaces/{workspace_id}/"))
                                        })
                                        .unwrap_or(false)
                                {
                                    continue;
                                }
                                let _ = chat_window.eval(
                                    "window.dispatchEvent(new CustomEvent('pipline:workflow-window-closed')); window.dispatchEvent(new CustomEvent('pipline:workflow-run-lock', {detail:{running:false}}));",
                                );
                            }
                        }
                    }
                }
                tauri::WindowEvent::Focused(true) if label.starts_with("native-workspace-") => {
                    let workspace_id = window
                        .try_state::<WindowWorkspaceState>()
                        .and_then(|state| {
                            state
                                .0
                                .lock()
                                .ok()
                                .and_then(|windows| windows.get(label).cloned())
                        })
                        .or_else(|| label.strip_prefix("native-workspace-").map(str::to_string));
                    if let (Some(workspace_id), Some(state)) =
                        (workspace_id, window.try_state::<FocusedWorkspaceState>())
                    {
                        if let Ok(mut focused_workspace) = state.0.lock() {
                            *focused_workspace = Some(workspace_id);
                        }
                    }
                }
                tauri::WindowEvent::Destroyed if label.starts_with("native-workspace-") => {
                    let workspace_id = window
                        .try_state::<WindowWorkspaceState>()
                        .and_then(|state| {
                            state
                                .0
                                .lock()
                                .ok()
                                .and_then(|mut windows| windows.remove(label))
                        })
                        .or_else(|| label.strip_prefix("native-workspace-").map(str::to_string));
                    if let Some(workspace_id) = workspace_id {
                        if let Some(state) = window.try_state::<FocusedWorkspaceState>() {
                            if let Ok(mut focused_workspace) = state.0.lock() {
                                if focused_workspace.as_deref() == Some(workspace_id.as_str()) {
                                    *focused_workspace = None;
                                }
                            }
                        }
                        if let Some(manager) = window.try_state::<NativePiManagerState>() {
                            manager.stop_workspace(&workspace_id);
                        }
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle: &tauri::AppHandle, event| {
            if let tauri::RunEvent::Ready = event {
                install_termination_handlers(app_handle.clone());
            }
            if let tauri::RunEvent::Exit = event {
                if let Some(manager) = app_handle.try_state::<NativePiManagerState>() {
                    manager.stop_all();
                }
                child_supervision::clear_registry();
            }
        });
}

/// Tear runtimes down on the signals that otherwise skip `RunEvent::Exit`
/// entirely: Ctrl-C under `tauri dev`, a logout or shutdown (SIGTERM), and a
/// closing terminal (SIGHUP). Nothing can be done about SIGKILL — that case is
/// what the startup sweep exists for.
#[cfg(unix)]
fn install_termination_handlers(app_handle: tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    for signal in [
        tokio::signal::unix::SignalKind::terminate(),
        tokio::signal::unix::SignalKind::interrupt(),
        tokio::signal::unix::SignalKind::hangup(),
    ] {
        let app_handle = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(mut stream) = tokio::signal::unix::signal(signal) else {
                return;
            };
            if stream.recv().await.is_none() {
                return;
            }
            if let Some(manager) = app_handle.try_state::<NativePiManagerState>() {
                manager.stop_all();
            }
            child_supervision::clear_registry();
            app_handle.exit(0);
        });
    }
}

#[cfg(not(unix))]
fn install_termination_handlers(_app_handle: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::set_press_and_hold_enabled;
    use super::{
        choose_latest_existing_boot_target, resolve_static_dir, select_fresh_startup_target,
        session_dir_name,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("picot-{label}-{suffix}"))
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn press_and_hold_helper_disables_accent_picker() {
        let mut value = true;
        set_press_and_hold_enabled(|enabled| value = enabled);
        assert!(!value);
    }

    #[test]
    fn debug_build_prefers_workspace_public_over_bundled_copy() {
        let root = unique_temp_dir("static-dir-debug");
        let workspace_public = root.join("workspace").join("public");
        let bundled_public = root.join("bundled").join("public");

        fs::create_dir_all(&workspace_public).unwrap();
        fs::create_dir_all(&bundled_public).unwrap();
        fs::write(workspace_public.join("index.html"), "workspace").unwrap();
        fs::write(bundled_public.join("index.html"), "bundled").unwrap();

        let resolved = resolve_static_dir(
            Some(root.join("bundled")),
            workspace_public.clone(),
            Some(root.join("workspace")),
            true,
        );

        assert_eq!(resolved, fs::canonicalize(&workspace_public).unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn session_dir_name_matches_pi_encoding_on_unix_and_windows_paths() {
        assert_eq!(
            session_dir_name(Path::new("/Users/me/.pi/agent/super-agent")),
            "--Users-me-.pi-agent-super-agent--"
        );
        assert_eq!(
            session_dir_name(Path::new(r"C:\Users\me\.pi\agent\super-agent")),
            "--C--Users-me-.pi-agent-super-agent--"
        );
        assert!(
            !session_dir_name(Path::new(r"C:\Users\me\.pi\agent\super-agent")).contains(':'),
            "Windows session folders cannot contain a drive colon"
        );
    }

    #[test]
    fn keeps_the_latest_workspace_but_never_resumes_its_session_on_app_start() {
        let workspace = unique_temp_dir("startup-ws");
        fs::create_dir_all(&workspace).unwrap();
        let cwd = workspace.to_string_lossy().into_owned();
        let selected = select_fresh_startup_target(
            "/home/user".to_string(),
            Some((cwd.clone(), "/sessions/old-session.jsonl".to_string())),
        );
        assert_eq!(selected, (cwd, None));
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn falls_back_to_home_when_latest_session_workspace_is_gone() {
        let selected = select_fresh_startup_target(
            "/home/user".to_string(),
            Some((
                "/definitely-missing-picot-workspace/does-not-exist".to_string(),
                "/sessions/old-session.jsonl".to_string(),
            )),
        );
        assert_eq!(selected, ("/home/user".to_string(), None));
    }

    #[test]
    fn skips_deleted_workspace_and_uses_next_existing_session() {
        let gone = unique_temp_dir("gone-ws");
        let live = unique_temp_dir("live-ws");
        fs::create_dir_all(&live).unwrap();
        let picked = choose_latest_existing_boot_target(vec![
            (
                gone.to_string_lossy().into_owned(),
                "newer-missing.jsonl".to_string(),
            ),
            (
                live.to_string_lossy().into_owned(),
                "older-live.jsonl".to_string(),
            ),
        ]);
        assert_eq!(
            picked,
            Some((
                live.to_string_lossy().into_owned(),
                "older-live.jsonl".to_string()
            ))
        );
        let _ = fs::remove_dir_all(live);
    }
}
