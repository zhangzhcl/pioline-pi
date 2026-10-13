use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex};

#[derive(Debug, Clone, PartialEq)]
pub enum BridgeFrame {
    Event(Value),
    ExtensionUi(Value),
    ProtocolError(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeError {
    ProcessClosed,
    Timeout,
    Transport(String),
}

impl BridgeError {
    #[cfg(test)]
    pub fn is_process_closed(&self) -> bool {
        matches!(self, Self::ProcessClosed)
    }
}

/// Cap on stderr lines folded into an error message.
const DIAGNOSTIC_TAIL_LINES: usize = 20;

type PendingSender = oneshot::Sender<Result<Value, BridgeError>>;

struct BridgeInner {
    next_id: AtomicU64,
    outbound: mpsc::Sender<Value>,
    frames: Mutex<mpsc::Receiver<BridgeFrame>>,
    pending: Mutex<HashMap<String, PendingSender>>,
}

#[derive(Clone)]
pub struct PiRpcBridge {
    inner: Arc<BridgeInner>,
}

#[cfg(test)]
pub struct InMemoryPiProcess {
    outbound: mpsc::Receiver<Value>,
    incoming: Option<mpsc::Sender<RawFrame>>,
}

enum RawFrame {
    Bytes(Vec<u8>),
    Oversized,
}

pub struct PiRpcProcess {
    child: Arc<StdMutex<Child>>,
    /// Present for a real spawned process; `None` for the in-memory test double.
    tree: Option<Arc<StdMutex<crate::child_supervision::ChildTree>>>,
    diagnostics: Arc<StdMutex<VecDeque<String>>>,
}

impl PiRpcBridge {
    pub fn attach(
        mut child: Child,
        max_frame_bytes: usize,
    ) -> Result<(Self, PiRpcProcess), String> {
        let child_pid = child.id();
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Pi RPC process stdin is not piped".to_string())?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Pi RPC process stdout is not piped".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Pi RPC process stderr is not piped".to_string())?;
        let (outbound_tx, mut outbound_rx) = mpsc::channel::<Value>(64);
        let (incoming_tx, incoming_rx) = mpsc::channel::<RawFrame>(64);
        let (frame_tx, frame_rx) = mpsc::channel(64);
        let inner = Arc::new(BridgeInner {
            next_id: AtomicU64::new(1),
            outbound: outbound_tx,
            frames: Mutex::new(frame_rx),
            pending: Mutex::new(HashMap::new()),
        });
        // `attach` is called synchronously from the Tauri `setup` hook (main
        // thread, no entered Tokio runtime), so a bare `tokio::spawn` here
        // panics with "there is no reactor running". `tauri::async_runtime::spawn`
        // holds Tauri's global runtime handle internally and works from any
        // thread — same pattern as `broker_ws.rs`.
        tauri::async_runtime::spawn(read_frames(
            incoming_rx,
            frame_tx,
            Arc::clone(&inner),
            max_frame_bytes,
        ));

        std::thread::Builder::new()
            .name("picot-pi-rpc-writer".into())
            .spawn(move || {
                let mut buffer = Vec::with_capacity(512);
                while let Some(frame) = outbound_rx.blocking_recv() {
                    buffer.clear();
                    if serde_json::to_writer(&mut buffer, &frame).is_err() {
                        continue;
                    }
                    buffer.push(b'\n');
                    if stdin.write_all(&buffer).is_err() || stdin.flush().is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| format!("Cannot start Pi RPC writer: {error}"))?;

        std::thread::Builder::new()
            .name("picot-pi-rpc-reader".into())
            .spawn(move || read_jsonl_stdout(&mut stdout, &incoming_tx, max_frame_bytes))
            .map_err(|error| format!("Cannot start Pi RPC reader: {error}"))?;

        let diagnostics = Arc::new(StdMutex::new(VecDeque::with_capacity(
            DIAGNOSTIC_TAIL_LINES,
        )));
        let diagnostics_for_stderr = Arc::clone(&diagnostics);
        std::thread::Builder::new()
            .name("picot-pi-rpc-stderr".into())
            .spawn(move || {
                for mut line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if line.len() > 4096 {
                        let end = line
                            .char_indices()
                            .nth(4096)
                            .map_or(line.len(), |(idx, _)| idx);
                        line.truncate(end);
                    }
                    if let Ok(mut ring) = diagnostics_for_stderr.lock() {
                        if ring.len() >= DIAGNOSTIC_TAIL_LINES {
                            ring.pop_front();
                        }
                        ring.push_back(line);
                    }
                }
            })
            .map_err(|error| format!("Cannot start Pi RPC stderr reader: {error}"))?;

        Ok((
            Self { inner },
            PiRpcProcess {
                tree: Some(Arc::new(StdMutex::new(
                    crate::child_supervision::ChildTree::attach(child_pid),
                ))),
                child: Arc::new(StdMutex::new(child)),
                diagnostics,
            },
        ))
    }

    #[cfg(test)]
    pub(crate) fn in_memory(max_frame_bytes: usize) -> (Self, InMemoryPiProcess) {
        let (outbound_tx, outbound_rx) = mpsc::channel(32);
        let (incoming_tx, incoming_rx) = mpsc::channel(32);
        let (frame_tx, frame_rx) = mpsc::channel(32);
        let inner = Arc::new(BridgeInner {
            next_id: AtomicU64::new(1),
            outbound: outbound_tx,
            frames: Mutex::new(frame_rx),
            pending: Mutex::new(HashMap::new()),
        });
        tokio::spawn(read_frames(
            incoming_rx,
            frame_tx,
            Arc::clone(&inner),
            max_frame_bytes,
        ));
        (
            Self { inner },
            InMemoryPiProcess {
                outbound: outbound_rx,
                incoming: Some(incoming_tx),
            },
        )
    }

    pub async fn request(
        &self,
        mut command: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        let id = format!(
            "picot-{}",
            self.inner.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let object = command
            .as_object_mut()
            .ok_or_else(|| BridgeError::Transport("RPC command must be an object".into()))?;
        object.insert("id".into(), Value::String(id.clone()));

        let (response_tx, response_rx) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .await
            .insert(id.clone(), response_tx);
        if self.inner.outbound.send(command).await.is_err() {
            self.inner.pending.lock().await.remove(&id);
            return Err(BridgeError::ProcessClosed);
        }

        match tokio::time::timeout(timeout, response_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(BridgeError::ProcessClosed),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(BridgeError::Timeout)
            }
        }
    }

    pub async fn send_frame(&self, frame: Value) -> Result<(), BridgeError> {
        self.inner
            .outbound
            .send(frame)
            .await
            .map_err(|_| BridgeError::ProcessClosed)
    }

    pub async fn next_frame(&self) -> Option<BridgeFrame> {
        self.inner.frames.lock().await.recv().await
    }
}

impl PiRpcProcess {
    /// Stop the runtime and everything it spawned. Killing only the direct
    /// child would leave its descendants running with no one to reap them.
    pub fn kill(&self) -> Result<(), String> {
        if let Some(tree) = &self.tree {
            if let Ok(mut tree) = tree.lock() {
                tree.terminate();
                crate::child_supervision::forget_runtime(tree.pid());
            }
        }
        let mut child = self
            .child
            .lock()
            .map_err(|_| "Pi RPC process lock poisoned".to_string())?;
        let result = child
            .kill()
            .map_err(|error| format!("Cannot stop Pi RPC process: {error}"));
        // Reap it, or the terminated runtime lingers as a zombie for as long
        // as Picot runs.
        let _ = child.wait();
        result
    }

    /// Everything `pi` has written to stderr and we have not reported yet.
    /// When the process dies at startup its reason lands here — without this
    /// the caller can only say `ProcessClosed`, which explains nothing.
    pub fn drain_diagnostics(&self) -> Option<String> {
        let mut ring = self.diagnostics.lock().ok()?;
        if ring.is_empty() {
            return None;
        }
        let lines: Vec<String> = ring.drain(..).collect();
        Some(lines.join("\n"))
    }
}

fn read_jsonl_stdout(
    stdout: &mut impl Read,
    incoming: &mpsc::Sender<RawFrame>,
    max_frame_bytes: usize,
) {
    let mut chunk = [0_u8; 8192];
    let mut frame = Vec::new();
    let mut oversized = false;
    loop {
        let read = match stdout.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        for segment in chunk[..read].split_inclusive(|&b| b == b'\n') {
            let has_newline = segment.last() == Some(&b'\n');
            let payload = if has_newline {
                &segment[..segment.len() - 1]
            } else {
                segment
            };
            if !oversized {
                if frame.len() + payload.len() > max_frame_bytes {
                    frame.clear();
                    oversized = true;
                } else {
                    frame.extend_from_slice(payload);
                }
            }
            if has_newline {
                let item = if oversized {
                    oversized = false;
                    RawFrame::Oversized
                } else {
                    if frame.last() == Some(&b'\r') {
                        frame.pop();
                    }
                    RawFrame::Bytes(std::mem::take(&mut frame))
                };
                if incoming.blocking_send(item).is_err() {
                    return;
                }
            }
        }
    }
}

async fn read_frames(
    mut incoming: mpsc::Receiver<RawFrame>,
    frames: mpsc::Sender<BridgeFrame>,
    inner: Arc<BridgeInner>,
    max_frame_bytes: usize,
) {
    while let Some(incoming_frame) = incoming.recv().await {
        let raw = match incoming_frame {
            RawFrame::Bytes(raw) if raw.len() <= max_frame_bytes => raw,
            RawFrame::Bytes(_) | RawFrame::Oversized => {
                let _ = frames
                    .send(BridgeFrame::ProtocolError(format!(
                        "Pi RPC frame exceeded {max_frame_bytes} bytes"
                    )))
                    .await;
                continue;
            }
        };
        let parsed = match serde_json::from_slice::<Value>(&raw) {
            Ok(value) => value,
            Err(error) => {
                let _ = frames
                    .send(BridgeFrame::ProtocolError(format!(
                        "Invalid Pi RPC JSONL frame: {error}"
                    )))
                    .await;
                continue;
            }
        };
        if let Some(id) = parsed.get("id").and_then(Value::as_str) {
            let pending_sender = inner.pending.lock().await.remove(id);
            if let Some(sender) = pending_sender {
                let _ = sender.send(Ok(parsed));
                continue;
            }
        }
        let frame = if parsed
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind.starts_with("extension_ui"))
        {
            BridgeFrame::ExtensionUi(parsed)
        } else {
            BridgeFrame::Event(parsed)
        };
        let _ = frames.send(frame).await;
    }

    let pending: Vec<PendingSender> = inner
        .pending
        .lock()
        .await
        .drain()
        .map(|(_, sender)| sender)
        .collect();
    for sender in pending {
        let _ = sender.send(Err(BridgeError::ProcessClosed));
    }
}

#[cfg(test)]
impl InMemoryPiProcess {
    pub(crate) async fn read_request(&mut self) -> Option<Value> {
        self.outbound.recv().await
    }

    pub(crate) fn try_read_request(&mut self) -> Option<Value> {
        self.outbound.try_recv().ok()
    }

    pub(crate) async fn write_frame(&self, value: Value) -> Result<(), BridgeError> {
        self.write_raw(format!("{value}\n")).await
    }

    async fn write_raw(&self, raw: String) -> Result<(), BridgeError> {
        self.incoming
            .as_ref()
            .ok_or(BridgeError::ProcessClosed)?
            .send(RawFrame::Bytes(
                raw.trim_end_matches('\n').as_bytes().to_vec(),
            ))
            .await
            .map_err(|_| BridgeError::ProcessClosed)
    }

    async fn close(&mut self) {
        self.incoming.take();
    }
}

#[cfg(test)]
mod tests {
    use super::{BridgeFrame, PiRpcBridge};
    use serde_json::json;
    #[cfg(unix)]
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[tokio::test]
    async fn correlates_responses_and_surfaces_events() {
        let (bridge, mut process) = PiRpcBridge::in_memory(1024);

        let request = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .request(json!({ "type": "get_state" }), Duration::from_secs(1))
                    .await
            }
        });

        let outbound = process.read_request().await.expect("request frame");
        assert_eq!(outbound["type"], "get_state");
        let id = outbound["id"].as_str().expect("native request id");

        process
            .write_frame(json!({ "id": id, "type": "response", "success": true }))
            .await
            .expect("response frame");
        assert_eq!(request.await.unwrap().unwrap()["success"], true);

        process
            .write_frame(json!({ "type": "agent_start" }))
            .await
            .expect("event frame");
        assert_eq!(
            bridge.next_frame().await,
            Some(BridgeFrame::Event(json!({ "type": "agent_start" })))
        );
    }

    #[tokio::test]
    async fn rejects_oversized_frames_and_pending_requests_on_exit() {
        let (bridge, mut process) = PiRpcBridge::in_memory(32);
        let request = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .request(json!({ "type": "get_state" }), Duration::from_secs(1))
                    .await
            }
        });

        process.read_request().await.expect("request frame");
        process
            .write_raw(format!("{{\"value\":\"{}\"}}\n", "x".repeat(64)))
            .await
            .expect("oversized frame");

        assert!(matches!(
            bridge.next_frame().await,
            Some(BridgeFrame::ProtocolError(_))
        ));
        process.close().await;
        assert!(request.await.unwrap().unwrap_err().is_process_closed());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn attaches_to_a_real_jsonl_subprocess() {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("IFS= read -r line; printf '%s\\n' '{\"id\":\"picot-1\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true}'")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().unwrap();
        let (bridge, mut process) = PiRpcBridge::attach(child, 1024).unwrap();

        let response = bridge
            .request(json!({ "type": "get_state" }), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(response["command"], "get_state");
        assert!(process.wait().unwrap().success());
    }
}
