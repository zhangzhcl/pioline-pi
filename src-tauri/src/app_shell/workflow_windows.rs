// 独立工作流窗口生命周期管理、跨窗口事件广播与工作流运行锁同步命令。

use serde_json::Value;
use tauri::image::Image;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::app_shell::workspace_windows::activate_app;
use crate::host_server::HostServer;
use crate::runtime_coordinator::RuntimeTarget;

pub(crate) fn valid_window_route_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[tauri::command]
pub(crate) async fn open_workflow_window(
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
        use std::fmt::Write as _;
        let _ = write!(
            route,
            "?sessionId={}&instanceId={}",
            target.session_id, target.instance_id
        );
    }
    let url = format!("{}{}", host.origin(), route)
        .parse()
        .map_err(|error| format!("Invalid workflow window URL: {error}"))?;
    let label = format!("native-workflow-{workspace_id}");
    if let Some(window) = app.get_webview_window(&label) {
        let same_route = window.url().is_ok_and(|current| {
            current.origin().ascii_serialization() == host.origin() && current.path() == route_path
        });
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
    let icon = Image::from_bytes(include_bytes!("../../icons/32x32.png"))
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
pub(crate) fn close_workflow_window(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let Some(workspace_id) = window.label().strip_prefix("native-workflow-") else {
        return Err("Only a workflow window may close itself".to_string());
    };
    window.hide().map_err(|error| error.to_string())?;
    notify_workflow_window_hidden(&app, workspace_id)
}

pub(crate) fn is_workspace_chat_window(
    window: &WebviewWindow,
    origin: &str,
    workspace_id: &str,
) -> bool {
    window.label().starts_with("native-workspace-")
        && window.url().is_ok_and(|url| {
            url.origin().ascii_serialization() == origin
                && url.path().contains(&format!("/workspaces/{workspace_id}/"))
        })
}

fn host_origin(app: &AppHandle) -> Result<String, String> {
    Ok(app
        .try_state::<HostServer>()
        .ok_or_else(|| "Host server is not ready".to_string())?
        .origin()
        .to_string())
}

pub(crate) fn notify_workflow_window_hidden(
    app: &AppHandle,
    workspace_id: &str,
) -> Result<(), String> {
    let origin = host_origin(app)?;
    for chat_window in app.webview_windows().into_values() {
        if !is_workspace_chat_window(&chat_window, &origin, workspace_id) {
            continue;
        }
        chat_window
            .eval("window.dispatchEvent(new CustomEvent('pipline:workflow-window-hidden'));")
            .map_err(|error| format!("Cannot restore workflow view in conversation: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn set_workflow_window_title(
    window: WebviewWindow,
    title: String,
) -> Result<(), String> {
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
pub(crate) fn send_workflow_context(
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
    let origin = host_origin(&app)?;
    let mut delivered = false;
    for window in app.webview_windows().into_values() {
        if !is_workspace_chat_window(&window, &origin, &workspace_id) {
            continue;
        }
        window
            .eval(format!(
                "window.dispatchEvent(new CustomEvent('pipline:workflow-context', {{detail:{{summary:{serialized_summary}}}}}));"
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
pub(crate) fn set_workflow_run_lock(
    app: AppHandle,
    workspace_id: String,
    running: bool,
) -> Result<(), String> {
    if !valid_window_route_id(&workspace_id) {
        return Err("Workflow run lock contains an invalid workspace identifier".to_string());
    }
    let origin = host_origin(&app)?;
    let payload = serde_json::json!({ "running": running });
    for window in app.webview_windows().into_values() {
        if !is_workspace_chat_window(&window, &origin, &workspace_id) {
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
pub(crate) fn update_workflow_window_target(
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
