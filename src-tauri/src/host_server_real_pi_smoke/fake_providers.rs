use axum::body::Body;
use axum::extract::{Json, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(super) struct FakeProviderState {
    pub(super) request_count: Arc<AtomicUsize>,
    pub(super) received_write_tool: Arc<AtomicBool>,
}

#[derive(Clone)]
pub(super) struct FakeWorkflowProviderState {
    pub(super) request_count: Arc<AtomicUsize>,
    pub(super) received_workflow_tool: Arc<AtomicBool>,
    pub(super) next_response_is_tool_call: Arc<AtomicBool>,
    pub(super) received_manual_workflow_read: Arc<AtomicBool>,
    pub(super) received_active_run_summary: Arc<AtomicBool>,
    pub(super) proposal: Arc<Mutex<Value>>,
}

pub(super) async fn fake_chat_completion(
    State(state): State<FakeProviderState>,
    Json(request): Json<Value>,
) -> Response<Body> {
    if request["stream"] != true {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from("the smoke provider requires streaming requests"))
            .expect("build bad request response");
    }
    let request_number = state.request_count.fetch_add(1, Ordering::SeqCst) + 1;
    state.received_write_tool.store(
        state.received_write_tool.load(Ordering::SeqCst)
            || request["tools"]
                .as_array()
                .is_some_and(|tools| tools.iter().any(|tool| tool["function"]["name"] == "write")),
        Ordering::SeqCst,
    );
    let chunks = if request_number == 1 {
        vec![
            json!({
                "id":"chatcmpl-pipline-host-smoke-1",
                "object":"chat.completion.chunk",
                "created":1,
                "model":"host-smoke-model",
                "choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]
            }),
            json!({
                "id":"chatcmpl-pipline-host-smoke-1",
                "object":"chat.completion.chunk",
                "created":1,
                "model":"host-smoke-model",
                "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_pipline_host_smoke_write","type":"function","function":{"name":"write","arguments":json!({"path":"pipline-host-smoke.txt","content":"Pipline Host to Pi write tool passed.\n"}).to_string()}}]},"finish_reason":null}]
            }),
            json!({
                "id":"chatcmpl-pipline-host-smoke-1",
                "object":"chat.completion.chunk",
                "created":1,
                "model":"host-smoke-model",
                "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]
            }),
        ]
    } else {
        vec![
            json!({
                "id":"chatcmpl-pipline-host-smoke-2",
                "object":"chat.completion.chunk",
                "created":1,
                "model":"host-smoke-model",
                "choices":[{"index":0,"delta":{"role":"assistant","content":"Pipline Host to Pi integration passed."},"finish_reason":null}]
            }),
            json!({
                "id":"chatcmpl-pipline-host-smoke-2",
                "object":"chat.completion.chunk",
                "created":1,
                "model":"host-smoke-model",
                "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]
            }),
        ]
    };
    let mut stream = chunks.iter().fold(String::new(), |mut out, chunk| {
        use std::fmt::Write as _;
        let _ = write!(out, "data: {chunk}\n\n");
        out
    });
    stream.push_str("data: [DONE]\n\n");
    Response::builder()
        .header(CONTENT_TYPE, "text/event-stream")
        .body(Body::from(stream))
        .expect("build fake provider stream")
}

pub(super) async fn fake_workflow_chat_completion(
    State(state): State<FakeWorkflowProviderState>,
    Json(request): Json<Value>,
) -> Response<Body> {
    if request["stream"] != true {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from(
                "the workflow smoke provider requires streaming requests",
            ))
            .expect("build bad request response");
    }
    let request_number = state.request_count.fetch_add(1, Ordering::SeqCst) + 1;
    let received_tool = request["tools"].as_array().is_some_and(|tools| {
        tools
            .iter()
            .any(|tool| tool["function"]["name"] == "pipline_workflow")
    });
    state
        .received_workflow_tool
        .fetch_or(received_tool, Ordering::SeqCst);
    let serialized_messages = request["messages"].to_string();
    if serialized_messages.contains("manual-assign")
        && serialized_messages.contains("manualAnswer")
        && serialized_messages.contains("assign-end")
    {
        state
            .received_manual_workflow_read
            .store(true, Ordering::SeqCst);
    }
    if serialized_messages.contains("run-manual-smoke")
        && serialized_messages.contains("running")
        && serialized_messages.contains("manual-assign")
    {
        state
            .received_active_run_summary
            .store(true, Ordering::SeqCst);
    }
    let chunks = if state
        .next_response_is_tool_call
        .swap(false, Ordering::SeqCst)
    {
        let proposal = state
            .proposal
            .lock()
            .map_or_else(|_| "{}".to_owned(), |value| value.to_string());
        let call_id = format!("call_pipline_workflow_host_smoke_{request_number}");
        vec![
            json!({
                "id":format!("chatcmpl-pipline-workflow-host-smoke-{request_number}"),
                "object":"chat.completion.chunk",
                "created":1,
                "model":"workflow-host-smoke-model",
                "choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]
            }),
            json!({
                "id":format!("chatcmpl-pipline-workflow-host-smoke-{request_number}"),
                "object":"chat.completion.chunk",
                "created":1,
                "model":"workflow-host-smoke-model",
                "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":call_id,"type":"function","function":{"name":"pipline_workflow","arguments":proposal}}]},"finish_reason":null}]
            }),
            json!({
                "id":format!("chatcmpl-pipline-workflow-host-smoke-{request_number}"),
                "object":"chat.completion.chunk",
                "created":1,
                "model":"workflow-host-smoke-model",
                "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]
            }),
        ]
    } else {
        let operation = state
            .proposal
            .lock()
            .ok()
            .and_then(|proposal| proposal["operation"].as_str().map(str::to_owned));
        let response = if operation.as_deref() == Some("propose_node_meta") {
            "The reusable custom NodeMeta template was saved; its implementation remains an inert draft."
        } else if operation.as_deref() == Some("read")
            && state.received_active_run_summary.load(Ordering::SeqCst)
        {
            "The current workflow run run-manual-smoke is running; its Assign node is active."
        } else if operation.as_deref() == Some("read") {
            "The manually composed workflow is Start → Assign (variable manualAnswer) → End, with the start input connected to Assign and Assign connected to End."
        } else {
            "I added an Assign node and connected it to the workflow."
        };
        vec![
            json!({
                "id":format!("chatcmpl-pipline-workflow-host-smoke-{request_number}"),
                "object":"chat.completion.chunk",
                "created":1,
                "model":"workflow-host-smoke-model",
                "choices":[{"index":0,"delta":{"role":"assistant","content":response},"finish_reason":null}]
            }),
            json!({
                "id":format!("chatcmpl-pipline-workflow-host-smoke-{request_number}"),
                "object":"chat.completion.chunk",
                "created":1,
                "model":"workflow-host-smoke-model",
                "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]
            }),
        ]
    };
    let mut stream = chunks.iter().fold(String::new(), |mut out, chunk| {
        use std::fmt::Write as _;
        let _ = write!(out, "data: {chunk}\n\n");
        out
    });
    stream.push_str("data: [DONE]\n\n");
    Response::builder()
        .header(CONTENT_TYPE, "text/event-stream")
        .body(Body::from(stream))
        .expect("build fake workflow provider stream")
}
