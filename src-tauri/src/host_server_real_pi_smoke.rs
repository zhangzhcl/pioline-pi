//! Opt-in cross-process smoke for the real embedded Pi Runtime behind the
//! desktop Host WebSocket. Run explicitly with `cargo test real_pi_websocket -- --ignored`.

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_tungstenite::tungstenite::Message;

static PI_ENVIRONMENT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

type HostSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

#[path = "host_server_real_pi_smoke/extension_ui_smoke.rs"]
mod extension_ui_smoke;
#[path = "host_server_real_pi_smoke/fake_providers.rs"]
mod fake_providers;
#[path = "host_server_real_pi_smoke/node_meta_proposal.rs"]
mod node_meta_proposal;
#[path = "host_server_real_pi_smoke/session_smoke.rs"]
mod session_smoke;
#[path = "host_server_real_pi_smoke/workflow_proposal.rs"]
mod workflow_proposal;
#[path = "host_server_real_pi_smoke/workflow_run.rs"]
mod workflow_run;

struct PiEnvironmentGuard {
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
}

impl PiEnvironmentGuard {
    fn isolate(pi_agent_dir: &Path, home: &Path) -> Self {
        let names = ["PI_CODING_AGENT_DIR", "HOME", "USERPROFILE"];
        let previous = names
            .into_iter()
            .map(|name| (name, std::env::var_os(name)))
            .collect();
        std::env::set_var("PI_CODING_AGENT_DIR", pi_agent_dir);
        std::env::set_var("HOME", home);
        std::env::set_var("USERPROFILE", home);
        Self { previous }
    }
}

impl Drop for PiEnvironmentGuard {
    fn drop(&mut self) {
        for (name, value) in &self.previous {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }
}

#[tokio::test]
#[ignore = "requires the bundled Pi Runtime; run explicitly as an integration smoke"]
async fn real_pi_websocket_smoke() {
    let _environment_lock = PI_ENVIRONMENT_LOCK.lock().await;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("pipline-host-pi-smoke-{nonce}"));
    let public = temp.join("public");
    let pi_agent_dir = temp.join("pi-agent");
    let isolated_home = temp.join("home");
    let workspace = temp.join("workspace");
    fs::create_dir_all(&public).expect("create static directory");
    fs::create_dir_all(&pi_agent_dir).expect("create isolated Pi config directory");
    fs::create_dir_all(&isolated_home).expect("create isolated home directory");
    fs::create_dir_all(&workspace).expect("create isolated workspace");
    fs::create_dir_all(temp.join(".git"))
        .expect("mark smoke root to stop ancestor skill discovery");
    fs::write(public.join("index.html"), "Pipline Host to Pi smoke").expect("write index");
    let user_extensions = pi_agent_dir.join("extensions");
    fs::create_dir_all(&user_extensions).expect("create isolated user extension directory");
    fs::write(
        user_extensions.join("pipline-profile-smoke.ts"),
        r#"export default function (pi) {
  pi.registerCommand("pipline-profile-smoke", {
    description: "Verify Pipline reuses Pi user extensions",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Pipline user extension executed", "info");
    },
  });
  pi.registerCommand("pipline-profile-confirm", {
    description: "Verify blocking Pi extension UI responses through Pipline",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm("Pipline extension confirmation", "Continue?");
      ctx.ui.notify(`Pipline confirmation result: ${confirmed}`, "info");
    },
  });
  pi.registerCommand("pipline-profile-dialogs", {
    description: "Verify Pi extension select and input UI responses through Pipline",
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select("Choose a profile value", ["A", "B"]);
      const value = await ctx.ui.input("Enter a profile value", "placeholder");
      ctx.ui.notify(`Pipline dialog results: ${JSON.stringify({ choice, value })}`, "info");
    },
  });
  pi.registerCommand("pipline-profile-input-cancel", {
    description: "Verify Pi extension input cancellation through Pipline",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.input("Cancel a profile value", "placeholder");
      ctx.ui.notify(value === undefined ? "Pipline input cancelled" : "Pipline input was not cancelled", "info");
    },
  });
  pi.registerCommand("pipline-profile-custom-ui", {
    description: "Verify custom extension UI input through the Pipline RPC bridge",
    handler: async (_args, ctx) => {
      const result = await ctx.ui.custom((_tui, _theme, _keybindings, done) => ({
        render: () => ["Pipline custom panel", "Press b to continue"],
        handleInput: (data) => { if (data === "b") done("selected"); },
      }), { overlayOptions: { width: 42 } });
      ctx.ui.notify(`Pipline custom UI result: ${result ?? "cancelled"}`, "info");
    },
  });
}
"#,
    )
    .expect("write isolated user extension");

    let _environment = PiEnvironmentGuard::isolate(&pi_agent_dir, &isolated_home);

    let result = session_smoke::run_smoke(&temp, &public, &pi_agent_dir, &workspace).await;
    let cleanup = fs::remove_dir_all(&temp);
    if let Err(error) = result {
        panic!("real Pi Host WebSocket smoke failed: {error}");
    }
    cleanup.expect("remove isolated smoke data");
}

#[tokio::test]
#[ignore = "requires the bundled Pi Runtime and bridge extension; run explicitly as an integration smoke"]
async fn real_pi_workflow_proposal_websocket_smoke() {
    let _environment_lock = PI_ENVIRONMENT_LOCK.lock().await;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("pipline-pi-workflow-host-smoke-{nonce}"));
    let public = temp.join("public");
    let pi_agent_dir = temp.join("pi-agent");
    let isolated_home = temp.join("home");
    let workspace = temp.join("workspace");
    fs::create_dir_all(&public).expect("create static directory");
    fs::create_dir_all(&pi_agent_dir).expect("create isolated Pi config directory");
    fs::create_dir_all(&isolated_home).expect("create isolated home directory");
    fs::create_dir_all(&workspace).expect("create isolated workspace");
    fs::create_dir_all(temp.join(".git"))
        .expect("mark smoke root to stop ancestor skill discovery");
    fs::write(public.join("index.html"), "Pipline Pi workflow Host smoke").expect("write index");

    let _environment = PiEnvironmentGuard::isolate(&pi_agent_dir, &isolated_home);
    let result =
        workflow_proposal::run_workflow_proposal_smoke(&temp, &public, &pi_agent_dir, &workspace)
            .await;
    let cleanup = fs::remove_dir_all(&temp);
    if let Err(error) = result {
        panic!("real Pi workflow Host WebSocket smoke failed: {error}");
    }
    cleanup.expect("remove isolated workflow smoke data");
}

async fn read_through_agent_end(socket: &mut HostSocket) -> Result<(Value, Vec<Value>), String> {
    let mut events: Vec<Value> = Vec::new();
    loop {
        let frame = read_frame(socket).await.map_err(|error| {
            format!(
                "{error}; observed Pi event types: {:?}",
                events
                    .iter()
                    .filter_map(|event| event["event"]["type"].as_str())
                    .collect::<Vec<_>>()
            )
        })?;
        if frame["type"] == "runtime_event" {
            let is_agent_end = frame["event"]["type"] == "agent_end";
            events.push(frame.clone());
            if is_agent_end {
                return Ok((frame, events));
            }
        }
    }
}

async fn send_json(socket: &mut HostSocket, value: Value) -> Result<(), String> {
    socket
        .send(Message::Text(value.to_string()))
        .await
        .map_err(|error| format!("send Host frame: {error}"))
}

async fn read_frame(socket: &mut HostSocket) -> Result<Value, String> {
    let message = tokio::time::timeout(std::time::Duration::from_secs(20), socket.next())
        .await
        .map_err(|_| "timed out waiting for Host frame".to_string())?
        .ok_or_else(|| "Host WebSocket closed".to_string())?
        .map_err(|error| format!("read Host frame: {error}"))?;
    serde_json::from_str(
        message
            .to_text()
            .map_err(|error| format!("non-text Host frame: {error}"))?,
    )
    .map_err(|error| format!("decode Host frame: {error}"))
}

async fn read_until<F>(socket: &mut HostSocket, mut predicate: F) -> Result<Value, String>
where
    F: FnMut(&Value) -> bool,
{
    loop {
        let frame = read_frame(socket).await?;
        if predicate(&frame) {
            return Ok(frame);
        }
    }
}

async fn read_until_collect_events<F>(
    socket: &mut HostSocket,
    mut predicate: F,
) -> Result<(Value, Vec<Value>), String>
where
    F: FnMut(&Value) -> bool,
{
    let mut events = Vec::new();
    loop {
        let frame = read_frame(socket).await?;
        if frame["type"] == "runtime_event" {
            events.push(frame.clone());
        }
        if predicate(&frame) {
            return Ok((frame, events));
        }
    }
}
