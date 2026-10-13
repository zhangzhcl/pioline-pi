#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(feature = "workflow-code-runner-prototype", not(debug_assertions)))]
compile_error!(
    "workflow-code-runner-prototype is a development-only experiment and cannot ship in release builds"
);

mod acp_launch;
mod acp_manager;
mod app_shell {
    pub(crate) mod startup;
    pub(crate) mod workflow_windows;
    pub(crate) mod workspace_windows;
}
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

use app_shell::startup::*;
use app_shell::workflow_windows::*;
use app_shell::workspace_windows::*;
use host_server::HostServer;
use metadata_store::MetadataStore;
use native_pi_manager::NativePiManager;
use pi_launch::PiLaunchResolver;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

pub(crate) type NativePiManagerState = NativePiManager;

#[cfg(target_os = "macos")]
const MENU_NEW_SESSION_ID: &str = "picot-new-session";

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

pub(crate) struct WorkspaceLauncher {
    pub(crate) metadata: Arc<Mutex<MetadataStore>>,
    pub(crate) launch: PiLaunchResolver,
}

pub(crate) struct FocusedWorkspaceState(pub(crate) Mutex<Option<String>>);
pub(crate) struct WindowWorkspaceState(pub(crate) Mutex<HashMap<String, String>>);

#[cfg(target_os = "macos")]
pub(crate) fn set_press_and_hold_enabled(setter: impl FnOnce(bool)) {
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

fn main() {
    #[cfg(all(feature = "workflow-code-runner-prototype", windows))]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--workflow-code-runner"))
    {
        std::process::exit(workflow_code_runner::run_stdio());
    }

    if let Err(error) = fix_path_env::fix_all_vars() {
        eprintln!("[picot] failed to sync login-shell environment: {error}");
    }

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
                                if !app_shell::workflow_windows::is_workspace_chat_window(
                                    &chat_window,
                                    &origin,
                                    workspace_id,
                                ) {
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
                    let mut still_bound_in_other_window = false;
                    let workspace_id = window
                        .try_state::<WindowWorkspaceState>()
                        .and_then(|state| {
                            state.0.lock().ok().and_then(|mut windows| {
                                let removed = windows.remove(label)?;
                                still_bound_in_other_window =
                                    windows.values().any(|active_id| active_id == &removed);
                                Some(removed)
                            })
                        })
                        .or_else(|| label.strip_prefix("native-workspace-").map(str::to_string));
                    if let Some(workspace_id) = workspace_id {
                        if !still_bound_in_other_window {
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
                            if let Some(host) = window.try_state::<HostServer>() {
                                host.stop_workspace_agents(&workspace_id);
                            }
                        }
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle: &tauri::AppHandle, event| {
            if matches!(event, tauri::RunEvent::Ready) {
                install_termination_handlers(app_handle.clone());
            }
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(manager) = app_handle.try_state::<NativePiManagerState>() {
                    manager.stop_all();
                }
                if let Some(host) = app_handle.try_state::<HostServer>() {
                    host.stop_all_agents();
                }
                child_supervision::clear_registry();
            }
        });
}

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
            if let Some(host) = app_handle.try_state::<HostServer>() {
                host.stop_all_agents();
            }
            child_supervision::clear_registry();
            app_handle.exit(0);
        });
    }
}

#[cfg(not(unix))]
fn install_termination_handlers(_app_handle: tauri::AppHandle) {}
