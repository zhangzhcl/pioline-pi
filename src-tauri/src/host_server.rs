use crate::acp_manager::AcpAgentManager;
use crate::host_data::HostDataPlane;
use crate::host_router::HostRouter;
use crate::markitdown_preview::MarkitdownPreviewService;
use crate::metadata_store::MetadataStore;
use crate::native_pi_manager::NativePiManager;
use crate::pi_launch::PiLaunchResolver;
use crate::remote_auth::RemoteAuth;
use crate::runtime_coordinator::RuntimeTarget;
use crate::terminal_manager::TerminalManager;
use crate::terminal_registry::TerminalRegistry;
use crate::terminal_state_store::TerminalStateStore;
use crate::window_owner::OwnerId;
use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, PRAGMA};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde_json::Value;
use std::collections::HashMap;
use std::convert::Infallible;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
#[cfg(test)]
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use tower::ServiceBuilder;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

#[cfg(test)]
#[path = "host_server_real_pi_smoke.rs"]
mod real_pi_smoke;

#[cfg(test)]
#[path = "host_server_workflow_broadcast.rs"]
mod workflow_broadcast_smoke;

#[path = "host_server/dispatch.rs"]
pub(crate) mod dispatch;
#[path = "host_server/host_operations.rs"]
pub(crate) mod host_operations;
#[path = "host_server/http_helpers.rs"]
mod http_helpers;
#[path = "host_server/routes/mod.rs"]
mod routes;
#[path = "host_server/static_assets.rs"]
mod static_assets;
#[path = "host_server/workflow_operations.rs"]
pub(crate) mod workflow_operations;
#[path = "host_server/ws.rs"]
pub(crate) mod ws;

pub(crate) use dispatch::dispatch;
#[cfg(test)]
use dispatch::{
    messages_from_entries_response, runtime_request_timeout, RUNTIME_INTERACTIVE_REQUEST_TIMEOUT,
    RUNTIME_REQUEST_TIMEOUT,
};
pub(crate) use http_helpers::{
    api_error, api_error_with_detail, host_data_error, host_data_http_error,
    is_public_http_request, now_seconds, trusted_loopback_request,
};
use routes::auth::{
    approve_device_request, claim_device_request, create_device_request, deny_device_request,
    list_device_requests, remote_access,
};
use routes::files::{file_mentions, raw_file_content, read_file_content, write_file_content};
use routes::git::{git_file_diff, git_stat_handler, git_status};
use routes::health::{health, health_model_test, health_runtime};
use routes::sessions::{app_launcher_redirect, bootstrap_target, list_all_sessions_http};
use routes::workspace::{new_session, resolve_workspace, workspace_info_handler};
use static_assets::fingerprint_static_dir;
use workflow_operations::WorkflowCodeCancellationRegistry;
pub(crate) use ws::extension_ui_requires_owner;
use ws::websocket_upgrade;

const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_WS_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

pub(crate) struct HostState {
    pub(crate) router: Mutex<HostRouter>,
    pub(crate) runtimes: NativePiManager,
    pub(crate) acp: AcpAgentManager,
    pub(crate) auth: Arc<Mutex<RemoteAuth>>,
    pub(crate) session_owners: Mutex<std::collections::HashMap<RuntimeTarget, String>>,
    pub(crate) data: HostDataPlane,
    pub(crate) markitdown: MarkitdownPreviewService,
    pub(crate) pi_launch: PiLaunchResolver,
    pub(crate) port: u16,
    pub(crate) terminal_manager: TerminalManager,
    pub(crate) terminal_events: tokio::sync::broadcast::Sender<(OwnerId, Value)>,
    pub(crate) workflow_events: tokio::sync::broadcast::Sender<Value>,
    pub(crate) workflow_code_cancellations: Mutex<WorkflowCodeCancellationRegistry>,
    pub(crate) git_service: Arc<crate::git_service::GitService>,
    pub(crate) git_events: tokio::sync::broadcast::Sender<(String, Value)>,
    pub(crate) skill_registry: Arc<crate::skill_source_registry::SkillSourceRegistry>,
    pub(crate) session_ui_profiles: Arc<crate::session_ui_profile_store::SessionUiProfileStore>,
    pub(crate) metadata: Option<Arc<Mutex<MetadataStore>>>,
    pub(crate) install_secret: String,
    pub(crate) app_handle: Option<tauri::AppHandle>,
    pub(crate) connection_shutdown: tokio::sync::watch::Receiver<bool>,
    pub(crate) active_websockets: AtomicUsize,
    pub(crate) websockets_idle: tokio::sync::Notify,
}

pub struct HostServer {
    origin: String,
    shutdown: Option<oneshot::Sender<()>>,
    connection_shutdown: Option<tokio::sync::watch::Sender<bool>>,
    server_task: Option<tokio::task::JoinHandle<()>>,
    state: Arc<HostState>,
}

impl HostServer {
    #[cfg(test)]
    pub async fn start(
        static_dir: PathBuf,
        runtimes: NativePiManager,
        auth: Arc<Mutex<RemoteAuth>>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<Self, String> {
        Self::start_with_workspaces(static_dir, runtimes, auth, HashMap::new(), app_handle, None)
            .await
    }

    /// Same as [`Self::start`] but additionally exposes the metadata store to
    /// authenticated host preference operations (`ui.*` keys). `start` passes
    /// `None`, so tests keep an infallible constructor.
    pub async fn start_with_workspaces(
        static_dir: PathBuf,
        runtimes: NativePiManager,
        auth: Arc<Mutex<RemoteAuth>>,
        workspace_roots: HashMap<String, PathBuf>,
        app_handle: Option<tauri::AppHandle>,
        metadata: Option<Arc<Mutex<MetadataStore>>>,
    ) -> Result<Self, String> {
        let mut data = HostDataPlane::new(workspace_roots)
            .map_err(|error| format!("Cannot initialize Host data plane: {error:?}"))?;
        if let Some(sessions_dir) = crate::pi_agent_dir::sessions_dir() {
            data = data.with_session_root(sessions_dir);
        }
        const PREFERRED_PORT_BASE: u16 = 57620;
        const PREFERRED_PORT_COUNT: u16 = 32;
        let mut listener = None;
        for offset in 0..PREFERRED_PORT_COUNT {
            let candidate = PREFERRED_PORT_BASE + offset;
            if let Ok(bound) =
                tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, candidate)).await
            {
                listener = Some(bound);
                break;
            }
        }
        let listener = match listener {
            Some(listener) => listener,
            None => tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))
                .await
                .map_err(|error| format!("Cannot bind Pipline Host: {error}"))?,
        };
        let address = listener
            .local_addr()
            .map_err(|error| format!("Cannot read Pipline Host address: {error}"))?;
        let loopback_origin = format!("http://127.0.0.1:{}", address.port());
        let (terminal_events, _) = tokio::sync::broadcast::channel(256);
        let (workflow_events, _) = tokio::sync::broadcast::channel(256);
        let (git_events, _) = tokio::sync::broadcast::channel(256);
        let git_service = Arc::new(crate::git_service::GitService::new());
        let skill_registry = Arc::new(crate::skill_source_registry::SkillSourceRegistry::new());
        let profile_dir = dirs::config_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("picot");
        let session_ui_profiles = Arc::new(
            crate::session_ui_profile_store::SessionUiProfileStore::open(
                profile_dir.join("session-ui-profiles.json"),
            )?,
        );
        let install_secret = {
            use base64::Engine;
            use rand::RngCore;
            let mut bytes = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut bytes);
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
        };
        let terminal_manager = TerminalManager::new(
            TerminalRegistry::new(15),
            TerminalStateStore::new(profile_dir),
        );
        let terminal_event_sender = terminal_events.clone();
        terminal_manager.set_event_sink(Arc::new(move |owner, event| {
            let _ = terminal_event_sender.send((owner.clone(), event));
        }));
        let (connection_shutdown, connection_shutdown_rx) = tokio::sync::watch::channel(false);
        let state = Arc::new(HostState {
            router: Mutex::new(HostRouter::new()),
            runtimes,
            acp: AcpAgentManager::new(),
            auth,
            session_owners: Mutex::new(std::collections::HashMap::new()),
            data,
            markitdown: MarkitdownPreviewService::default(),
            pi_launch: PiLaunchResolver::new(static_dir.clone()),
            port: address.port(),
            terminal_manager,
            terminal_events,
            workflow_events,
            workflow_code_cancellations: Mutex::new(WorkflowCodeCancellationRegistry::default()),
            git_service,
            git_events,
            skill_registry,
            session_ui_profiles,
            metadata,
            install_secret,
            app_handle,
            connection_shutdown: connection_shutdown_rx,
            active_websockets: AtomicUsize::new(0),
            websockets_idle: tokio::sync::Notify::new(),
        });
        let index = static_dir.join("index.html");
        let versioned_prefix = format!("/v/{}", fingerprint_static_dir(&static_dir));
        let index_html =
            axum::body::Bytes::from(fs::read_to_string(&index).unwrap_or_default().replacen(
                "<base href=\"/\" />",
                &format!("<base href=\"{versioned_prefix}/\" />"),
                1,
            ));
        let index_fallback = tower::service_fn(move |_req: axum::extract::Request| {
            let html = index_html.clone();
            std::future::ready(Ok::<_, Infallible>(
                Response::builder()
                    .header(CONTENT_TYPE, "text/html; charset=utf-8")
                    .body(Body::from(html))
                    .expect("static index.html response is well-formed"),
            ))
        });
        let static_service = ServeDir::new(static_dir.clone()).fallback(index_fallback);
        let static_service = ServiceBuilder::new()
            .layer(SetResponseHeaderLayer::overriding(
                CACHE_CONTROL,
                HeaderValue::from_static("no-store, no-cache, must-revalidate, max-age=0"),
            ))
            .layer(SetResponseHeaderLayer::overriding(
                PRAGMA,
                HeaderValue::from_static("no-cache"),
            ))
            .service(static_service);
        let versioned_service = ServiceBuilder::new()
            .layer(SetResponseHeaderLayer::overriding(
                CACHE_CONTROL,
                HeaderValue::from_static("no-store, no-cache, must-revalidate, max-age=0"),
            ))
            .layer(SetResponseHeaderLayer::overriding(
                PRAGMA,
                HeaderValue::from_static("no-cache"),
            ))
            .service(ServeDir::new(static_dir));
        let app = Router::new()
            .route("/", get(app_launcher_redirect))
            .route("/health", get(health))
            .route("/health/runtime", get(health_runtime))
            .route("/health/models/test", post(health_model_test))
            .route("/v2/ws", get(websocket_upgrade))
            .route("/v2/bootstrap", get(bootstrap_target))
            .route("/v2/sessions", get(list_all_sessions_http))
            .route(
                "/v2/auth/device-requests",
                post(create_device_request).get(list_device_requests),
            )
            .route(
                "/v2/auth/device-requests/{request_id}/claim",
                post(claim_device_request),
            )
            .route(
                "/v2/auth/device-requests/{request_id}/approve",
                post(approve_device_request),
            )
            .route(
                "/v2/auth/device-requests/{request_id}/deny",
                post(deny_device_request),
            )
            .route("/v2/remote-access", get(remote_access))
            .route(
                "/api/files/content",
                get(read_file_content).put(write_file_content),
            )
            .route("/api/files/raw", get(raw_file_content))
            .route("/api/git/status", get(git_status))
            .route("/api/git/diff", get(git_file_diff))
            .route("/api/git/stat", get(git_stat_handler))
            .route("/api/file-mentions", get(file_mentions))
            .route("/api/workspace-info", get(workspace_info_handler))
            .route("/v2/new-session", post(new_session))
            .route("/v2/resolve-workspace", post(resolve_workspace))
            .nest_service(
                &versioned_prefix,
                Router::new().fallback_service(versioned_service),
            )
            .fallback_service(static_service)
            .layer(DefaultBodyLimit::max(MAX_HTTP_BODY_BYTES))
            .with_state(state.clone());
        let auth_for_http = state.auth.clone();
        let app = app.layer(middleware::from_fn(
            move |request: axum::extract::Request, next: middleware::Next| {
                let auth = auth_for_http.clone();
                async move {
                    let path = request.uri().path();
                    if is_public_http_request(request.method(), path) {
                        return next.run(request).await;
                    }
                    let loopback = request
                        .extensions()
                        .get::<ConnectInfo<std::net::SocketAddr>>()
                        .copied()
                        .is_some_and(|peer| {
                            trusted_loopback_request(peer, request.headers(), request.uri())
                        });
                    let authorized = loopback
                        || request
                            .headers()
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                            .and_then(|value| value.strip_prefix("Bearer "))
                            .and_then(|token| auth.lock().ok()?.authorize(token).ok())
                            .unwrap_or(false);
                    if authorized {
                        next.run(request).await
                    } else {
                        Response::builder()
                            .status(StatusCode::UNAUTHORIZED)
                            .header(CONTENT_TYPE, "application/json")
                            .body(Body::from(r#"{"error":{"code":"unauthorized_device"}}"#))
                            .expect("authorization response is valid")
                    }
                }
            },
        ));
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let server_task = tokio::spawn(async move {
            if let Err(error) = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            {
                log::error!("[picot-host] server stopped unexpectedly: {error}");
            }
        });
        Ok(Self {
            origin: loopback_origin,
            shutdown: Some(shutdown_tx),
            connection_shutdown: Some(connection_shutdown),
            server_task: Some(server_task),
            state,
        })
    }

    pub fn register_workspace(&self, workspace_id: &str, root: &Path) -> Result<(), String> {
        self.state
            .data
            .register_workspace(workspace_id, root)
            .map_err(|error| format!("Cannot register workspace: {error:?}"))
    }

    pub fn workspace_root_path(&self, workspace_id: &str) -> Result<PathBuf, String> {
        self.state
            .data
            .workspace_root_path(workspace_id)
            .map_err(|error| format!("Cannot resolve workspace path: {error:?}"))
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn stop_workspace_agents(&self, workspace_id: &str) {
        self.state.acp.stop_workspace(workspace_id);
        if let Ok(root) = self.state.data.workspace_root_path(workspace_id) {
            self.state.terminal_manager.kill_workspace(&root);
        }
    }

    pub fn stop_all_agents(&self) {
        self.state.terminal_manager.kill_all();
        self.state.acp.stop_all();
    }

    #[cfg(test)]
    pub async fn stop(mut self) {
        self.state.terminal_manager.kill_all();
        self.state.acp.stop_all();
        if let Some(shutdown) = self.connection_shutdown.take() {
            let _ = shutdown.send(true);
        }
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(server_task) = self.server_task.take() {
            let _ = server_task.await;
        }
        while self.state.active_websockets.load(Ordering::Acquire) > 0 {
            self.state.websockets_idle.notified().await;
        }
    }
}

impl Drop for HostServer {
    fn drop(&mut self) {
        self.state.terminal_manager.kill_all();
        self.state.acp.stop_all();
        if let Some(shutdown) = self.connection_shutdown.take() {
            let _ = shutdown.send(true);
        }
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(server_task) = self.server_task.take() {
            server_task.abort();
        }
    }
}

#[cfg(test)]
#[path = "host_server/tests.rs"]
mod tests;
