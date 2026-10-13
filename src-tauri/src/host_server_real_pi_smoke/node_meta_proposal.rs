use super::fake_providers::FakeWorkflowProviderState;
use super::{read_through_agent_end, read_until, read_until_collect_events, send_json, HostSocket};
use crate::runtime_coordinator::RuntimeTarget;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

pub(super) async fn verify_node_meta_and_workflow_history(
    socket: &mut HostSocket,
    workspace_id: &str,
    target: &RuntimeTarget,
    provider_observed: &FakeWorkflowProviderState,
    proposal_events: &mut Vec<Value>,
) -> Result<(), String> {
    send_json(
        socket,
        json!({ "type": "host_request", "requestId": "read-node-meta-catalog",
            "operation": "list_workflow_node_templates", "workspaceId": workspace_id }),
    )
    .await?;
    let catalog = read_until(socket, |frame| {
        frame["requestId"] == "read-node-meta-catalog"
    })
    .await
    .map_err(|error| format!("read NodeMeta catalog: {error}"))?;
    let node_meta_catalog_revision = catalog["catalogRevision"]
        .as_str()
        .ok_or("Host did not return NodeMeta catalog revision")?
        .to_owned();
    let candidate = json!({
        "schemaVersion": 1,
        "id": "custom.slugify",
        "version": "1.0.0",
        "type": "custom",
        "label": "Slugify",
        "description": "Convert text into a URL slug.",
        "inputs": [{ "name": "text", "label": "Text", "type": "string",
            "required": true, "allowStaticValue": true }],
        "outputs": [{ "name": "slug", "label": "Slug", "type": "string",
            "required": true, "allowStaticValue": false }],
        "params": [],
        "execution": { "kind": "user-code", "entrypoint": "slugify" },
        "permissions": { "filesystem": "none", "network": "none", "shell": "none" },
        "implementationDraft": { "language": "typescript",
            "source": "export function slugify(text: string) { return text.toLowerCase(); }",
            "entryFn": "slugify" },
        "i18n": {
            "en": { "label": "Slugify", "description": "Convert text into a URL slug.",
                "inputs": { "text": "Text" }, "outputs": { "slug": "Slug" }, "params": {} },
            "zh": { "label": "生成链接别名", "description": "将文本转换为链接别名。",
                "inputs": { "text": "文本" }, "outputs": { "slug": "链接别名" }, "params": {} },
            "es": { "label": "Crear slug", "description": "Convertir texto en un slug de URL.",
                "inputs": { "text": "Texto" }, "outputs": { "slug": "Slug" }, "params": {} },
            "ja": { "label": "URLスラッグ化", "description": "テキストをURLスラッグに変換します。",
                "inputs": { "text": "テキスト" }, "outputs": { "slug": "スラッグ" }, "params": {} }
        }
    });
    *provider_observed
        .proposal
        .lock()
        .map_err(|_| "workflow NodeMeta fixture is poisoned")? = json!({
        "operation": "propose_node_meta",
        "expectedCatalogRevision": node_meta_catalog_revision,
        "meta": candidate,
    });
    provider_observed
        .next_response_is_tool_call
        .store(true, Ordering::SeqCst);
    send_json(
        socket,
        json!({ "type": "runtime_request", "requestId": "ask-pi-for-node-meta",
            "idempotencyKey": "ask-pi-for-node-meta-key", "target": target,
            "command": { "type": "prompt", "message": "Create a reusable node template that converts text into a URL slug. Save the template only; do not add it to the active workflow." } }),
    )
    .await?;
    let prompt_response = read_until(socket, |frame| frame["requestId"] == "ask-pi-for-node-meta")
        .await
        .map_err(|error| format!("receive NodeMeta prompt response: {error}"))?;
    if prompt_response["type"] != "runtime_response"
        || prompt_response["response"]["success"] != true
    {
        return Err(format!(
            "Pi rejected NodeMeta generation prompt: {prompt_response}"
        ));
    }
    let (node_meta_request, node_meta_events) = read_until_collect_events(socket, |frame| {
        frame["type"] == "runtime_event"
            && frame["event"]["type"] == "extension_ui_request"
            && frame["event"]["method"] == "input"
    })
    .await
    .map_err(|error| format!("receive Pi NodeMeta approval request: {error}"))?;
    proposal_events.extend(node_meta_events);
    let node_meta_event = &node_meta_request["event"];
    let placeholder = node_meta_event["placeholder"]
        .as_str()
        .ok_or("Pi NodeMeta request omitted its workflow marker")?;
    let marker = "__PIPLINE_WORKFLOW_TOOL_V1__";
    let marker_offset = placeholder
        .find(marker)
        .ok_or("NodeMeta workflow marker is missing")?;
    let decoded_request: Value = serde_json::from_str(&placeholder[marker_offset + marker.len()..])
        .map_err(|error| format!("decode Pi NodeMeta request: {error}"))?;
    if decoded_request["operation"] != "propose_node_meta"
        || decoded_request["expectedCatalogRevision"] != node_meta_catalog_revision
        || decoded_request["meta"]["id"] != "custom.slugify"
        || decoded_request["meta"]["implementationDraft"]["source"]
            != candidate["implementationDraft"]["source"]
    {
        return Err(format!(
            "Pi sent an unexpected NodeMeta candidate: {decoded_request}"
        ));
    }
    let extension_request_id = node_meta_event["id"]
        .as_str()
        .ok_or("NodeMeta approval request id is missing")?;
    send_json(
        socket,
        json!({ "type": "host_request", "requestId": "approve-node-meta-candidate",
            "operation": "create_workflow_node_template", "workspaceId": workspace_id,
            "expectedCatalogRevision": node_meta_catalog_revision, "meta": candidate }),
    )
    .await?;
    let node_meta_saved = read_until(socket, |frame| {
        frame["requestId"] == "approve-node-meta-candidate"
    })
    .await
    .map_err(|error| format!("save approved NodeMeta through Host: {error}"))?;
    if node_meta_saved["type"] != "host_response" || node_meta_saved["created"] != true {
        return Err(format!(
            "Host rejected approved NodeMeta candidate: {node_meta_saved}"
        ));
    }
    let candidate_summary = json!({ "ok": true, "meta": {
        "id": candidate["id"], "version": candidate["version"], "implementation": { "compiled": false, "executable": false }
    }, "nodeCatalog": { "revision": node_meta_saved["catalogRevision"] } });
    send_json(
        socket,
        json!({ "type": "runtime_request", "requestId": "return-node-meta-approval",
            "idempotencyKey": "return-node-meta-approval-key", "target": target,
            "command": { "type": "extension_ui_response", "id": extension_request_id,
                "value": candidate_summary.to_string() } }),
    )
    .await?;
    let approval_response = read_until(socket, |frame| {
        frame["requestId"] == "return-node-meta-approval"
    })
    .await
    .map_err(|error| format!("return NodeMeta approval to Pi: {error}"))?;
    if approval_response["type"] != "runtime_response"
        || approval_response["response"]["success"] != true
    {
        return Err(format!(
            "Host did not return NodeMeta approval to Pi: {approval_response}"
        ));
    }
    let (node_meta_agent_end, mut extra_events) = read_through_agent_end(socket)
        .await
        .map_err(|error| format!("wait for NodeMeta proposal agent_end: {error}"))?;
    proposal_events.append(&mut extra_events);
    if node_meta_agent_end["event"]["type"] != "agent_end" {
        return Err(format!(
            "Pi did not finish NodeMeta proposal turn: {node_meta_agent_end}"
        ));
    }
    send_json(
        socket,
        json!({ "type": "host_request", "requestId": "verify-node-meta-template",
            "operation": "list_workflow_node_templates", "workspaceId": workspace_id }),
    )
    .await?;
    let templates = read_until(socket, |frame| {
        frame["requestId"] == "verify-node-meta-template"
    })
    .await
    .map_err(|error| format!("verify NodeMeta Host persistence: {error}"))?;
    if !templates["templates"]
        .as_array()
        .is_some_and(|items| items.contains(&candidate))
    {
        return Err(format!(
            "Host did not persist the approved custom NodeMeta template: {templates}"
        ));
    }
    send_json(
        socket,
        json!({ "type": "runtime_request", "requestId": "read-agent-workflow-history",
            "target": target, "command": { "type": "get_messages" } }),
    )
    .await?;
    let history_response = read_until(socket, |frame| {
        frame["requestId"] == "read-agent-workflow-history"
    })
    .await?;
    if history_response["response"]["success"] != true {
        return Err(format!(
            "Pi could not reload workflow conversation history: {history_response}"
        ));
    }
    let messages = history_response["response"]["data"]["messages"]
        .as_array()
        .ok_or_else(|| {
            format!("Pi workflow conversation history is missing: {history_response}")
        })?;
    let saved_workflow_call = messages.iter().any(|message| {
        message["role"] == "assistant"
            && message["content"].as_array().is_some_and(|parts| {
                parts
                    .iter()
                    .any(|part| part["type"] == "toolCall" && part["name"] == "pipline_workflow")
            })
    });
    let saved_approval = messages.iter().any(|message| {
        message["role"] == "toolResult"
            && message["toolName"] == "pipline_workflow"
            && message["content"].as_array().is_some_and(|parts| {
                parts.iter().any(|part| {
                    part["type"] == "text"
                        && part["text"].as_str().is_some_and(|text| {
                            serde_json::from_str::<Value>(text).is_ok_and(|result| {
                                result["applied"] == true && result["revision"] == 1
                            })
                        })
                })
            })
    });
    let saved_agent_summary = messages.iter().any(|message| {
        message["role"] == "assistant"
            && message["content"].as_array().is_some_and(|parts| {
                parts.iter().any(|part| {
                    part["type"] == "text"
                        && part["text"]
                            .as_str()
                            .is_some_and(|text| text.contains("I added an Assign node"))
                })
            })
    });
    if !saved_workflow_call || !saved_approval || !saved_agent_summary {
        return Err(format!(
            "Pi history must retain the workflow call, approved result, and assistant summary; call={saved_workflow_call}, approval={saved_approval}, summary={saved_agent_summary}, messages={messages:?}"
        ));
    }
    Ok(())
}
