// 工作流代码节点执行、桌面客户端鉴权与取消注册表。

use std::collections::HashMap;
#[cfg(feature = "workflow-code-runner-prototype")]
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::host_router::ClientKind;

use super::super::HostState;

pub(crate) const MAX_PENDING_WORKFLOW_CODE_CANCELLATIONS: usize = 256;
pub(crate) const WORKFLOW_CODE_CANCELLATION_TTL: Duration = Duration::from_secs(10);

#[derive(Default)]
pub(crate) struct WorkflowCodeCancellationRegistry {
    pub(crate) active: HashMap<(String, String), oneshot::Sender<()>>,
    pub(crate) cancelled_before_registration: HashMap<(String, String), Instant>,
}

impl WorkflowCodeCancellationRegistry {
    #[cfg(any(test, feature = "workflow-code-runner-prototype"))]
    pub(crate) fn register(
        &mut self,
        key: (String, String),
    ) -> Result<oneshot::Receiver<()>, String> {
        self.prune_expired();
        if self.cancelled_before_registration.remove(&key).is_some() {
            return Err("Workflow code request was cancelled before execution started".into());
        }
        if self.active.contains_key(&key) {
            return Err("Workflow code request id is already active".into());
        }
        let (sender, receiver) = oneshot::channel();
        self.active.insert(key, sender);
        Ok(receiver)
    }

    pub(crate) fn cancel(&mut self, key: (String, String)) -> bool {
        self.prune_expired();
        if let Some(sender) = self.active.remove(&key) {
            return sender.send(()).is_ok();
        }
        if self.cancelled_before_registration.len() >= MAX_PENDING_WORKFLOW_CODE_CANCELLATIONS {
            if let Some(oldest_key) = self
                .cancelled_before_registration
                .iter()
                .min_by_key(|(_, created_at)| *created_at)
                .map(|(key, _)| key.clone())
            {
                self.cancelled_before_registration.remove(&oldest_key);
            }
        }
        self.cancelled_before_registration
            .insert(key, Instant::now());
        false
    }

    #[cfg(feature = "workflow-code-runner-prototype")]
    pub(crate) fn remove(&mut self, key: &(String, String)) {
        self.active.remove(key);
    }

    fn prune_expired(&mut self) {
        let now = Instant::now();
        self.cancelled_before_registration.retain(|_, created_at| {
            now.saturating_duration_since(*created_at) <= WORKFLOW_CODE_CANCELLATION_TTL
        });
    }
}

pub(crate) fn dispatch_cancel_workflow_code_operation(
    state: &HostState,
    client_id: &str,
    request_id: &str,
    frame: &Value,
) -> Result<Value, (&'static str, String)> {
    ensure_desktop_workflow_code_client(state, client_id)?;
    let execution_request_id = frame
        .get("executionRequestId")
        .and_then(Value::as_str)
        .filter(|value| valid_workflow_code_request_id(value))
        .ok_or_else(|| {
            (
                "invalid_workflow_code_request",
                "executionRequestId is required".into(),
            )
        })?;
    let cancelled = state
        .workflow_code_cancellations
        .lock()
        .map_err(|_| {
            (
                "host_operation_failed",
                "Workflow cancellation registry is poisoned".into(),
            )
        })?
        .cancel((client_id.to_owned(), execution_request_id.to_owned()));
    Ok(json!({
        "type": "host_response",
        "requestId": request_id,
        "operation": "cancel_workflow_code",
        "cancelled": cancelled,
    }))
}

pub(crate) fn ensure_desktop_workflow_code_client(
    state: &HostState,
    client_id: &str,
) -> Result<(), (&'static str, String)> {
    let router = state
        .router
        .lock()
        .map_err(|_| ("host_operation_failed", "Host router is unavailable".into()))?;
    match router.client_kind(client_id) {
        Some(ClientKind::Desktop) => Ok(()),
        Some(ClientKind::Remote) => Err((
            "workflow_code_forbidden",
            "Workflow code execution is only available to local desktop windows".into(),
        )),
        None => Err((
            "workflow_code_forbidden",
            "Workflow code execution requires an authenticated desktop window".into(),
        )),
    }
}

pub(crate) fn valid_workflow_code_request_id(value: &str) -> bool {
    value.starts_with("host-") && value.len() <= 128
}

#[cfg(feature = "workflow-code-runner-prototype")]
pub(crate) struct WorkflowCodeCancellationRegistration<'a> {
    pub(crate) registry: &'a Mutex<WorkflowCodeCancellationRegistry>,
    pub(crate) key: (String, String),
}

#[cfg(feature = "workflow-code-runner-prototype")]
impl Drop for WorkflowCodeCancellationRegistration<'_> {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.remove(&self.key);
        }
    }
}

#[cfg(feature = "workflow-code-runner-prototype")]
pub(crate) async fn dispatch_workflow_code_operation(
    state: &HostState,
    client_id: &str,
    request_id: &str,
    frame: &Value,
) -> Result<Value, (&'static str, String)> {
    ensure_desktop_workflow_code_client(state, client_id)?;
    if !valid_workflow_code_request_id(request_id) {
        return Err((
            "invalid_workflow_code_request",
            "Workflow code request id is invalid".into(),
        ));
    }
    if !crate::workflow_code_runner::platform_isolated_execution_available() {
        return Err((
            "workflow_code_disabled",
            "No verified workflow code sandbox is available on this platform".into(),
        ));
    }
    let run_id = frame
        .get("runId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(("invalid_workflow_code_request", "runId is required".into()))?;
    let workspace_id = frame
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or((
            "invalid_workflow_code_request",
            "workspaceId is required".into(),
        ))?;
    let node_id = frame
        .get("nodeId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(("invalid_workflow_code_request", "nodeId is required".into()))?;
    let inputs = frame.get("inputs").ok_or((
        "invalid_workflow_code_request",
        "inputs are required".into(),
    ))?;
    let store = state.metadata.as_ref().ok_or((
        "workflow_code_disabled",
        "Workflow metadata store is unavailable".into(),
    ))?;
    let record = {
        let store = store
            .lock()
            .map_err(|_| ("host_operation_failed", "Workflow store is poisoned".into()))?;
        store
            .workflow_run_load(run_id, workspace_id)
            .map_err(|message| ("host_operation_failed", message))?
    }
    .ok_or((
        "invalid_workflow_code_request",
        "Workflow Run was not found".into(),
    ))?;
    let authorized = crate::workflow_code_authorization::authorize_code_node(
        &record,
        run_id,
        workspace_id,
        node_id,
        inputs,
    )
    .map_err(|message| ("workflow_code_forbidden", message))?;
    let cancellation_key = (client_id.to_owned(), request_id.to_owned());
    let cancellation_receiver = state
        .workflow_code_cancellations
        .lock()
        .map_err(|_| {
            (
                "host_operation_failed",
                "Workflow cancellation registry is poisoned".into(),
            )
        })?
        .register(cancellation_key.clone())
        .map_err(|message| ("invalid_workflow_code_request", message))?;
    let _cancellation_registration = WorkflowCodeCancellationRegistration {
        registry: &state.workflow_code_cancellations,
        key: cancellation_key,
    };
    let result = crate::workflow_code_process::execute_workflow_code(
        &authorized.node_meta,
        inputs,
        &authorized.params,
        cancellation_receiver,
    )
    .await
    .map_err(|message| ("workflow_code_failed", message))?;
    Ok(json!({
        "type": "host_response",
        "requestId": request_id,
        "operation": "execute_workflow_code",
        "output": result.output,
        "logs": result.logs,
    }))
}

#[cfg(not(feature = "workflow-code-runner-prototype"))]
pub(crate) async fn dispatch_workflow_code_operation(
    _state: &HostState,
    _client_id: &str,
    _request_id: &str,
    _frame: &Value,
) -> Result<Value, (&'static str, String)> {
    Err((
        "workflow_code_disabled",
        "Workflow code execution is not enabled in this build".into(),
    ))
}
