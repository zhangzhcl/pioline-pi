// 应用启动引导、静态资源定位、Agent Inbox 会话占位初始化与最近工作区探测。

use serde_json::Value;
use std::cmp::Reverse;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::image::Image;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::app_shell::workspace_windows::open_native_workspace_window;
use crate::host_server::HostServer;
use crate::metadata_store::MetadataStore;
use crate::native_pi_manager::NativePiManager;
use crate::pi_agent_dir;
use crate::pi_launch::PiLaunchResolver;
use crate::remote_auth::RemoteAuth;
use crate::runtime_coordinator::RuntimeTarget;
use crate::{FocusedWorkspaceState, WindowWorkspaceState, WorkspaceLauncher};

#[tauri::command]
pub(crate) async fn retry_startup(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if app.try_state::<HostServer>().is_some() {
        let _ = window.close();
        return Ok(());
    }
    let static_dir = find_static_dir(&app);
    setup_native_runtime(&app, static_dir)?;
    let _ = window.close();
    Ok(())
}

pub(crate) fn open_bootstrap_window(app: &AppHandle, startup_error: &str) -> Result<(), String> {
    let icon = Image::from_bytes(include_bytes!("../../icons/32x32.png"))
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

fn canonical_if_exists(dir: &Path) -> Option<PathBuf> {
    dir.join("index.html")
        .exists()
        .then(|| fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf()))
}

pub(crate) fn resolve_static_dir(
    resource_dir: Option<PathBuf>,
    workspace_public: &Path,
    current_dir: Option<PathBuf>,
    debug_assertions: bool,
) -> PathBuf {
    if debug_assertions {
        let current_public = current_dir.unwrap_or_default().join("public");
        return canonical_if_exists(workspace_public)
            .or_else(|| canonical_if_exists(&current_public))
            .unwrap_or(current_public);
    }

    let bundled_public = resource_dir.map(|dir| dir.join("public"));
    if let Some(dir) = bundled_public.as_deref().and_then(canonical_if_exists) {
        return dir;
    }

    bundled_public.unwrap_or_else(|| PathBuf::from("public"))
}

pub(crate) fn find_static_dir(app: &AppHandle) -> PathBuf {
    resolve_static_dir(
        app.path().resource_dir().ok(),
        &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("public"),
        std::env::current_dir().ok(),
        cfg!(debug_assertions),
    )
}

pub(crate) fn agent_inbox_path() -> Result<PathBuf, String> {
    pi_agent_dir::agent_dir()
        .map(|agent_dir| agent_dir.join("super-agent"))
        .ok_or_else(|| "Cannot resolve Pi agent directory for Agent Inbox".to_string())
}

pub(crate) fn session_dir_name(cwd: &Path) -> String {
    let raw = cwd.to_string_lossy();
    let stripped = raw
        .strip_prefix('/')
        .or_else(|| raw.strip_prefix('\\'))
        .unwrap_or(&raw);
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

pub(crate) fn ensure_agent_inbox_tasks_file(cwd: &Path) -> Result<(), String> {
    let tasks_path = cwd.join("tasks.json");
    if tasks_path.exists() {
        return Ok(());
    }
    let default = r#"{"tasks":[]}"#;
    fs::write(&tasks_path, default)
        .map_err(|error| format!("Cannot create Agent Inbox tasks.json: {error}"))?;
    Ok(())
}

pub(crate) fn ensure_agent_inbox_placeholder_session(cwd: &Path) -> Result<(), String> {
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
                .is_some_and(|session_cwd| crate::host_data::same_dir(Path::new(&session_cwd), cwd))
        })
        .filter_map(|path| {
            let mtime = fs::metadata(&path).ok()?.modified().ok()?;
            Some((mtime, path))
        })
        .max_by_key(|(mtime, _)| *mtime)
        .map(|(_, path)| path)
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

pub(crate) fn choose_latest_existing_boot_target(
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

// 普通独立会话固定落于用户主目录，应用冷启动创建空白临时会话时默认归属用户主目录
pub(crate) fn select_fresh_startup_target(
    home_cwd: String,
    _latest_session: Option<(String, String)>,
) -> (String, Option<String>) {
    (home_cwd, None)
}

pub(crate) fn setup_native_runtime(app: &AppHandle, static_dir: PathBuf) -> Result<(), String> {
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
    let mut workspace_roots =
        std::collections::HashMap::from([(target.workspace_id.clone(), PathBuf::from(&cwd))]);
    if let Some(home) = dirs::home_dir() {
        let home = home.canonicalize().unwrap_or(home);
        let cwd_path = PathBuf::from(&cwd)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(&cwd));
        if home != cwd_path {
            let home_id = remote_auth
                .lock()
                .map_err(|_| "auth poisoned")?
                .resolve_workspace(&home);
            if let Ok(home_id) = home_id {
                workspace_roots.insert(home_id, home);
            }
        }
    }
    let host = tauri::async_runtime::block_on(async {
        let host = HostServer::start_with_workspaces(
            static_dir,
            runtimes.clone(),
            remote_auth,
            workspace_roots,
            Some(app.clone()),
            Some(Arc::clone(&metadata)),
        )
        .await?;
        runtimes.spawn(target.clone(), &launch)?;
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
        target.workspace_id,
    )]);
    app.manage(WindowWorkspaceState(Mutex::new(window_workspaces)));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        choose_latest_existing_boot_target, resolve_static_dir, select_fresh_startup_target,
        session_dir_name,
    };
    #[cfg(target_os = "macos")]
    use crate::set_press_and_hold_enabled;
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
            &workspace_public,
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
    fn always_targets_home_on_fresh_app_start() {
        let workspace = unique_temp_dir("startup-ws");
        fs::create_dir_all(&workspace).unwrap();
        let cwd = workspace.to_string_lossy().into_owned();
        let selected = select_fresh_startup_target(
            "/home/user".to_string(),
            Some((cwd.clone(), "/sessions/old-session.jsonl".to_string())),
        );
        assert_eq!(selected, ("/home/user".to_string(), None));
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
