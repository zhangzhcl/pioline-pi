use serde_json::Value;
use std::collections::HashMap;

#[cfg(test)]
mod tests;

pub const PROTOCOL_VERSION: u64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientKind {
    Desktop,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoutedAction {
    Runtime {
        client_id: String,
        request_id: String,
        frame: Value,
    },
    Host {
        client_id: String,
        request_id: String,
        operation: String,
        frame: Value,
    },
    Data {
        client_id: String,
        request_id: String,
        frame: Value,
    },
    Subscribe {
        client_id: String,
        request_id: String,
        target: Value,
    },
    Terminal {
        client_id: String,
        request_id: String,
        frame: Value,
    },
    Git {
        client_id: String,
        request_id: String,
        frame: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterError {
    pub code: &'static str,
    pub message: String,
}

impl RouterError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub struct HostRouter {
    clients: HashMap<String, ClientKind>,
}

impl HostRouter {
    pub fn new() -> Self {
        Self {
            clients: HashMap::new(),
        }
    }

    #[cfg(test)]
    pub fn connect(&mut self, client_id: &str, hello: &Value) -> Result<(), RouterError> {
        let kind = match hello.get("clientType").and_then(Value::as_str) {
            Some("desktop") => ClientKind::Desktop,
            Some("remote") => ClientKind::Remote,
            _ => {
                return Err(RouterError::new(
                    "invalid_client_type",
                    "Unsupported client type",
                ))
            }
        };
        self.connect_as(client_id, hello, kind)
    }

    pub fn connect_as(
        &mut self,
        client_id: &str,
        hello: &Value,
        kind: ClientKind,
    ) -> Result<(), RouterError> {
        if hello.get("type").and_then(Value::as_str) != Some("hello") {
            return Err(RouterError::new(
                "handshake_required",
                "First frame must be hello",
            ));
        }
        if hello.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
            return Err(RouterError::new(
                "protocol_mismatch",
                format!(
                    "Pipline protocol v{PROTOCOL_VERSION} is required; refresh or restart the app"
                ),
            ));
        }
        if client_id.is_empty() {
            return Err(RouterError::new(
                "invalid_client_id",
                "clientId is required",
            ));
        }
        self.clients.insert(client_id.to_owned(), kind);
        Ok(())
    }

    pub fn client_kind(&self, client_id: &str) -> Option<ClientKind> {
        self.clients.get(client_id).copied()
    }

    pub fn disconnect(&mut self, client_id: &str) {
        self.clients.remove(client_id);
    }

    #[cfg(test)]
    pub fn route(&self, client_id: &str, frame: &Value) -> Result<RoutedAction, RouterError> {
        self.route_owned(client_id, frame.clone())
    }

    pub fn route_owned(
        &self,
        client_id: &str,
        mut frame: Value,
    ) -> Result<RoutedAction, RouterError> {
        let _kind = self.client_kind(client_id).ok_or_else(|| {
            RouterError::new("unauthorized_client", "Client has not completed handshake")
        })?;
        let frame_type = frame
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| RouterError::new("invalid_frame", "Frame type is required"))?;
        let request_id = frame
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| RouterError::new("invalid_frame", "requestId is required"))?
            .to_owned();

        match frame_type {
            "git_command" | "git_ai_commit_message" => {
                if frame.get("workspaceId").and_then(Value::as_str).is_none() {
                    return Err(RouterError::new(
                        "invalid_git_command",
                        "workspaceId is required",
                    ));
                }
                Ok(RoutedAction::Git {
                    client_id: client_id.to_owned(),
                    request_id,
                    frame,
                })
            }
            "terminal_command" => {
                if frame.get("workspaceId").and_then(Value::as_str).is_none()
                    || !frame.get("payload").is_some_and(Value::is_object)
                {
                    return Err(RouterError::new(
                        "invalid_terminal_command",
                        "workspaceId and payload are required",
                    ));
                }
                Ok(RoutedAction::Terminal {
                    client_id: client_id.to_owned(),
                    request_id,
                    frame,
                })
            }
            "runtime_subscribe" => {
                let target = frame
                    .get_mut("target")
                    .map(Value::take)
                    .filter(|value| !value.is_null())
                    .ok_or_else(|| {
                        RouterError::new("invalid_target", "Runtime target is required")
                    })?;
                validate_target(&target)?;
                Ok(RoutedAction::Subscribe {
                    client_id: client_id.to_owned(),
                    request_id,
                    target,
                })
            }
            "runtime_request"
            | "runtime_snapshot_request"
            | "runtime_capabilities_request"
            | "runtime_rebind_session_request" => {
                if frame_type == "runtime_request" {
                    validate_runtime_request(&frame)?;
                }
                if frame_type == "runtime_rebind_session_request" {
                    let target = frame.get("target").ok_or_else(|| {
                        RouterError::new("invalid_target", "Runtime target is required")
                    })?;
                    validate_target(target)?;
                    if frame
                        .get("newSessionId")
                        .and_then(Value::as_str)
                        .is_none_or(str::is_empty)
                    {
                        return Err(RouterError::new(
                            "invalid_session_id",
                            "newSessionId is required",
                        ));
                    }
                }
                Ok(RoutedAction::Runtime {
                    client_id: client_id.to_owned(),
                    request_id,
                    frame,
                })
            }
            "host_request" => {
                let operation = frame
                    .get("operation")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RouterError::new("invalid_host_request", "operation is required")
                    })?
                    .to_owned();
                Ok(RoutedAction::Host {
                    client_id: client_id.to_owned(),
                    request_id,
                    operation,
                    frame,
                })
            }
            "data_request" => Ok(RoutedAction::Data {
                client_id: client_id.to_owned(),
                request_id,
                frame,
            }),
            _ => Err(RouterError::new(
                "unknown_frame_type",
                "Unsupported protocol v2 frame type",
            )),
        }
    }
}

fn validate_runtime_request(frame: &Value) -> Result<(), RouterError> {
    let target = frame
        .get("target")
        .ok_or_else(|| RouterError::new("invalid_target", "Runtime target is required"))?;
    validate_target(target)?;
    let command_type = frame
        .get("command")
        .and_then(|command| command.get("type"))
        .and_then(Value::as_str)
        .ok_or_else(|| RouterError::new("invalid_command", "Runtime command type is required"))?;
    if is_mutation(command_type)
        && frame
            .get("idempotencyKey")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err(RouterError::new(
            "idempotency_key_required",
            "Runtime mutations require idempotencyKey",
        ));
    }
    Ok(())
}

fn validate_target(target: &Value) -> Result<(), RouterError> {
    let target = target
        .as_object()
        .ok_or_else(|| RouterError::new("invalid_target", "Runtime target must be an object"))?;
    for field in ["workspaceId", "sessionId", "instanceId"] {
        if target.get(field).and_then(Value::as_str).is_none() {
            return Err(RouterError::new(
                "invalid_target",
                format!("{field} is required"),
            ));
        }
    }
    Ok(())
}

fn is_mutation(command_type: &str) -> bool {
    matches!(
        command_type,
        "prompt"
            | "steer"
            | "follow_up"
            | "compact"
            | "bash"
            | "fork"
            | "clone"
            | "navigate_tree"
            | "set_model"
            | "set_thinking_level"
            | "set_auto_compaction"
            | "set_auto_retry"
            | "set_steering_mode"
            | "set_follow_up_mode"
    )
}
