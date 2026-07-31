// Real streaming providers - Phase 8 proper (post-spike).
//
// Replaces the "buffer-then-yield" pattern with "push-each-event-as-it-
// arrives" via napi-rs ThreadsafeFunction. Each SSE event becomes a
// JSON-encoded string pushed to the JS callback as soon as the bytes
// are parsed.
//
// ## Payload shapes (JSON-encoded String)
//
// Delta:
//   {"kind":"delta","event_type":"content_block_delta","index":0,
//    "text_delta":"hello","thinking_delta":null,"tool_call_id":null,
//    "tool_call_name":null,"tool_call_args":null}
// Done:
//   {"kind":"done","id":"msg_...","model":"claude-...","usage":{...},
//    "finish_reason":"end_turn","trace_id":"..."}
// Error:
//   {"kind":"error","message":"..."}

use crate::message::TokenUsage;
use futures_util::StreamExt;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use napi::JsFunction;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::sync::oneshot;

static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

#[napi]
pub struct ProviderStreamHandle {
    pub id: u32,
    cancel_tx: Option<oneshot::Sender<()>>,
}

#[napi]
impl ProviderStreamHandle {
    #[napi]
    pub fn cancel(&mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
    }
}

fn encode_delta_event(
    event_type: &str,
    index: Option<u32>,
    text_delta: Option<&str>,
    thinking_delta: Option<&str>,
    tool_call_id: Option<&str>,
    tool_call_name: Option<&str>,
    tool_call_args: Option<&str>,
) -> String {
    let index_json = match index {
        Some(i) => i.to_string(),
        None => "null".to_string(),
    };
    let text_json = text_delta
        .map(|s| serde_json::to_string(s).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    let think_json = thinking_delta
        .map(|s| serde_json::to_string(s).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    let tc_id_json = tool_call_id
        .map(|s| serde_json::to_string(s).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    let tc_name_json = tool_call_name
        .map(|s| serde_json::to_string(s).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    let tc_args_json = tool_call_args
        .map(|s| serde_json::to_string(s).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    format!(
        r#"{{"kind":"delta","event_type":{},"index":{},"text_delta":{},"thinking_delta":{},"tool_call_id":{},"tool_call_name":{},"tool_call_args":{}}}"#,
        serde_json::to_string(event_type).unwrap_or_else(|_| "null".to_string()),
        index_json,
        text_json,
        think_json,
        tc_id_json,
        tc_name_json,
        tc_args_json,
    )
}

fn encode_done_event(
    id: Option<&str>,
    model: Option<&str>,
    usage: &TokenUsage,
    finish_reason: Option<&str>,
    trace_id: Option<&str>,
) -> String {
    let id_json = id
        .map(|s| serde_json::to_string(s).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    let model_json = model
        .map(|s| serde_json::to_string(s).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    let finish_json = finish_reason
        .map(|s| serde_json::to_string(s).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    let trace_json = trace_id
        .map(|s| serde_json::to_string(s).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    let usage_json = format!(
        r#"{{"input_other":{},"output":{},"input_cache_read":{},"input_cache_creation":{}}}"#,
        usage.input_other,
        usage.output,
        usage.input_cache_read,
        usage.input_cache_creation,
    );
    format!(
        r#"{{"kind":"done","id":{id_json},"model":{model_json},"usage":{usage_json},"finish_reason":{finish_json},"trace_id":{trace_json}}}"#
    )
}

fn encode_error_event(message: &str) -> String {
    format!(
        r#"{{"kind":"error","message":{}}}"#,
        serde_json::to_string(message).unwrap_or_else(|_| "null".to_string())
    )
}

struct StreamConfig {
    url: String,
    body: String,
    headers: Vec<(String, String)>,
    model: Option<String>,
    format: ProviderFormat,
    use_bearer_auth: bool,
    api_key: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProviderFormat {
    Anthropic,
    OpenAi,
    Google,
}

struct StreamState {
    msg_id: Mutex<Option<String>>,
    model: Mutex<Option<String>>,
    usage: Mutex<TokenUsage>,
    finish_reason: Mutex<Option<String>>,
    content_block_buffers: Mutex<ContentBlockBuffers>,
    thinking_buffers: Mutex<ContentBlockBuffers>,
    // Google-only: Gemini does not send tool-call ids/indices, so we assign a
    // monotonic index per functionCall to key the TS-side argument buffers.
    next_tool_index: Mutex<u32>,
}

#[derive(Default)]
struct ContentBlockBuffers {
    blocks: std::collections::HashMap<u32, String>,
}

impl ContentBlockBuffers {
    fn append(&mut self, index: u32, s: &str) {
        self.blocks.entry(index).or_default().push_str(s);
    }

    fn take(&mut self, index: u32) -> Option<String> {
        self.blocks.remove(&index)
    }
}

fn run_streaming(cfg: StreamConfig, callback: JsFunction) -> Result<ProviderStreamHandle> {
    let tsfn: ThreadsafeFunction<String, ErrorStrategy::Fatal> = callback
        .create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;

    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    let id = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed) as u32;

    tokio::spawn(async move {
        let mut hdrs: std::collections::HashMap<String, String> =
            cfg.headers.iter().cloned().collect();
        hdrs.insert("x-api-key".to_string(), cfg.api_key.clone());

        let client = crate::http::HttpClient::shared();
        let response_result = client
            .post_json_stream(&cfg.url, &cfg.api_key, &cfg.body, Some(&hdrs))
            .await
            .map_err(|e| format!("HTTP request failed: {e}"));

        let response = match response_result {
            Ok(r) => r,
            Err(e) => {
                let _ = tsfn.call(
                    encode_error_event(&e),
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
                return;
            }
        };

        let trace_id = response
            .headers()
            .get("x-trace-id")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let _ = tsfn.call(
                encode_error_event(&format!("HTTP {} (error): {}", status.as_u16(), body)),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
            return;
        }

        let state = StreamState {
            msg_id: Mutex::new(None),
            model: Mutex::new(cfg.model.clone()),
            usage: Mutex::new(TokenUsage::new()),
            finish_reason: Mutex::new(None),
            content_block_buffers: Mutex::new(ContentBlockBuffers::default()),
            thinking_buffers: Mutex::new(ContentBlockBuffers::default()),
            next_tool_index: Mutex::new(0),
        };

        let mut buffer = String::new();
        let mut stream = response.bytes_stream();
        loop {
            tokio::select! {
                chunk = stream.next() => {
                    let Some(chunk) = chunk else { break };
                    if let Err(e) = chunk {
                        let _ = tsfn.call(
                            encode_error_event(&format!("body read: {e}")),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                        return;
                    }
                    let chunk = chunk.unwrap();
                    buffer.push_str(&String::from_utf8_lossy(&chunk));

                    while let Some(idx) = buffer.find("\n\n") {
                        let event_block: String = buffer.drain(..idx + 2).collect();
                        let should_stop = process_event_block(
                            &event_block,
                            &state,
                            Some(&tsfn),
                            cfg.format,
                        );
                        if should_stop {
                            while stream.next().await.is_some() {}
                            break;
                        }
                    }
                }
                _ = &mut cancel_rx => {
                    let _ = tsfn.call(
                        encode_error_event("cancelled"),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                    return;
                }
            }
        }

        let _ = tsfn.call(
            encode_done_event(
                state.msg_id.lock().unwrap().as_deref(),
                state.model.lock().unwrap().as_deref(),
                &state.usage.lock().unwrap(),
                state.finish_reason.lock().unwrap().as_deref(),
                trace_id.as_deref(),
            ),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    });

    Ok(ProviderStreamHandle {
        id,
        cancel_tx: Some(cancel_tx),
    })
}

fn process_event_block(
    event_block: &str,
    state: &StreamState,
    tsfn: Option<&ThreadsafeFunction<String, ErrorStrategy::Fatal>>,
    format: ProviderFormat,
) -> bool {
    let mut event_type: Option<String> = None;
    let mut data_lines: Vec<String> = Vec::new();

    for line in event_block.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("event: ") {
            event_type = Some(trimmed[7..].to_string());
            continue;
        }
        if trimmed.starts_with("data: ") {
            data_lines.push(trimmed[6..].to_string());
            continue;
        }
    }
    let data = data_lines.join("\n");

    match format {
        ProviderFormat::OpenAi => {
            if data.trim() == "[DONE]" {
                return true;
            }
        }
        ProviderFormat::Anthropic => {
            if event_type.as_deref() == Some("message_stop") {
                return true;
            }
        }
        ProviderFormat::Google => {}
    }

    if data.is_empty() {
        return false;
    }
    let parsed: Value = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(_) => return false,
    };

    match format {
        ProviderFormat::Google => dispatch_google_event(&parsed, state, tsfn),
        _ => dispatch_event(&parsed, event_type.as_deref(), state, tsfn),
    }
    false
}

fn dispatch_event(
    parsed: &Value,
    event_type: Option<&str>,
    state: &StreamState,
    tsfn: Option<&ThreadsafeFunction<String, ErrorStrategy::Fatal>>,
) {
    let kind = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let index = parsed.get("index").and_then(|v| v.as_u64()).map(|n| n as u32);

    let push = |payload: String| {
        if let Some(tsfn) = tsfn {
            let _ = tsfn.call(payload, ThreadsafeFunctionCallMode::NonBlocking);
        }
    };

    match kind {
        "message_start" => {
            if let Some(id) = parsed.pointer("/message/id").and_then(|v| v.as_str()) {
                *state.msg_id.lock().unwrap() = Some(id.to_string());
            }
            if let Some(model) = parsed.pointer("/message/model").and_then(|v| v.as_str()) {
                *state.model.lock().unwrap() = Some(model.to_string());
            }
            if let Some(usage_val) = parsed.pointer("/message/usage") {
                apply_anthropic_usage(usage_val, &state.usage);
            }
        }
        "content_block_start" => {}
        "content_block_delta" => {
            let delta_type = parsed
                .pointer("/delta/type")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let idx = index.unwrap_or(0);
            match delta_type {
                "text_delta" => {
                    let text = parsed
                        .pointer("/delta/text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    state.content_block_buffers.lock().unwrap().append(idx, text);
                    push(encode_delta_event(
                        event_type.unwrap_or("content_block_delta"),
                        Some(idx),
                        Some(text),
                        None,
                        None,
                        None,
                        None,
                    ));
                }
                "thinking_delta" => {
                    let text = parsed
                        .pointer("/delta/thinking")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    state.thinking_buffers.lock().unwrap().append(idx, text);
                    push(encode_delta_event(
                        "thinking_delta",
                        Some(idx),
                        None,
                        Some(text),
                        None,
                        None,
                        None,
                    ));
                }
                "signature_delta" => {
                    let sig = parsed
                        .pointer("/delta/signature")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    push(encode_delta_event(
                        "signature_delta",
                        Some(idx),
                        None,
                        Some(sig),
                        None,
                        None,
                        None,
                    ));
                }
                "input_json_delta" => {
                    let args = parsed
                        .pointer("/delta/partial_json")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    state.content_block_buffers.lock().unwrap().append(idx, args);
                    push(encode_delta_event(
                        "tool_call_delta",
                        Some(idx),
                        None,
                        None,
                        None,
                        None,
                        Some(args),
                    ));
                }
                _ => {}
            }
        }
        "content_block_stop" => {
            // Buffers stay populated so callers can read the final
            // accumulated content. They're cleaned up on stream end
            // (when the `StreamState` is dropped).
            let _ = index;
        }
        "message_delta" => {
            if let Some(stop) = parsed.pointer("/delta/stop_reason").and_then(|v| v.as_str()) {
                *state.finish_reason.lock().unwrap() = Some(stop.to_string());
            }
            if let Some(usage_val) = parsed.pointer("/usage") {
                apply_anthropic_usage(usage_val, &state.usage);
            }
            push(encode_delta_event(
                "message_delta",
                index,
                None,
                None,
                None,
                None,
                None,
            ));
        }
        _ => {
            if let Some(choice) = parsed.pointer("/choices/0") {
                if let Some(delta) = choice.get("delta") {
                    if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
                        *state.finish_reason.lock().unwrap() = Some(fr.to_string());
                    }
                    if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                        if !content.is_empty() {
                            push(encode_delta_event(
                                "content",
                                Some(0),
                                Some(content),
                                None,
                                None,
                                None,
                                None,
                            ));
                        }
                    }
                    if let Some(reasoning) = delta.get("reasoning_content").and_then(|v| v.as_str()) {
                        if !reasoning.is_empty() {
                            push(encode_delta_event(
                                "reasoning",
                                Some(0),
                                None,
                                Some(reasoning),
                                None,
                                None,
                                None,
                            ));
                        }
                    }
                    if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                        for tc in tool_calls {
                            let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                            let id = tc.get("id").and_then(|v| v.as_str());
                            let name = tc
                                .get("function")
                                .and_then(|f| f.get("name"))
                                .and_then(|v| v.as_str());
                            let args = tc
                                .get("function")
                                .and_then(|f| f.get("arguments"))
                                .and_then(|v| v.as_str());
                            state
                                .content_block_buffers
                                .lock()
                                .unwrap()
                                .append(idx, args.unwrap_or(""));
                            push(encode_delta_event(
                                "tool_call_delta",
                                Some(idx),
                                None,
                                None,
                                id,
                                name,
                                args,
                            ));
                        }
                    }
                }
            }
            if let Some(id) = parsed.get("id").and_then(|v| v.as_str()) {
                if state.msg_id.lock().unwrap().is_none() {
                    *state.msg_id.lock().unwrap() = Some(id.to_string());
                }
            }
            if let Some(model) = parsed.get("model").and_then(|v| v.as_str()) {
                *state.model.lock().unwrap() = Some(model.to_string());
            }
            if let Some(usage_val) = parsed.get("usage") {
                apply_openai_usage(usage_val, &state.usage);
            }
        }
    }
}

pub(crate) fn apply_anthropic_usage(usage_val: &Value, usage: &Mutex<TokenUsage>) {
    let mut u = usage.lock().unwrap();
    if let Some(n) = usage_val.get("input_tokens").and_then(|v| v.as_u64()) {
        u.input_other = n as i64;
    }
    if let Some(n) = usage_val.get("output_tokens").and_then(|v| v.as_u64()) {
        u.output = n as i64;
    }
    if let Some(n) = usage_val.get("cache_read_input_tokens").and_then(|v| v.as_u64()) {
        u.input_cache_read = n as i64;
    }
    if let Some(n) = usage_val.get("cache_creation_input_tokens").and_then(|v| v.as_u64()) {
        u.input_cache_creation = n as i64;
    }
}

pub(crate) fn apply_openai_usage(usage_val: &Value, usage: &Mutex<TokenUsage>) {
    let mut u = usage.lock().unwrap();
    if let Some(n) = usage_val.get("prompt_tokens").and_then(|v| v.as_u64()) {
        u.input_other = n as i64;
    }
    if let Some(n) = usage_val.get("completion_tokens").and_then(|v| v.as_u64()) {
        u.output = n as i64;
    }
    if let Some(n) = usage_val.get("cached_tokens").and_then(|v| v.as_u64()) {
        u.input_cache_read = n as i64;
    }
}

pub(crate) fn apply_google_usage(usage_val: &Value, usage: &Mutex<TokenUsage>) {
    let mut u = usage.lock().unwrap();
    let cached = usage_val.get("cachedContentTokenCount").and_then(|v| v.as_i64());
    if let Some(prompt) = usage_val.get("promptTokenCount").and_then(|v| v.as_i64()) {
        u.input_other = (prompt - cached.unwrap_or(0)).max(0);
    }
    if let Some(c) = cached {
        u.input_cache_read = c;
    }
    if let Some(output) = usage_val.get("candidatesTokenCount").and_then(|v| v.as_i64()) {
        u.output = output;
    }
}

fn dispatch_google_event(
    parsed: &Value,
    state: &StreamState,
    tsfn: Option<&ThreadsafeFunction<String, ErrorStrategy::Fatal>>,
) {
    let push = |payload: String| {
        if let Some(tsfn) = tsfn {
            let _ = tsfn.call(payload, ThreadsafeFunctionCallMode::NonBlocking);
        }
    };

    if let Some(id) = parsed.get("responseId").and_then(|v| v.as_str()) {
        let mut m = state.msg_id.lock().unwrap();
        if m.is_none() {
            *m = Some(id.to_string());
        }
    }

    if let Some(um) = parsed.get("usageMetadata") {
        apply_google_usage(um, &state.usage);
    }

    let Some(candidates) = parsed.get("candidates").and_then(|v| v.as_array()) else {
        return;
    };
    for candidate in candidates {
        if let Some(reason) = candidate.get("finishReason").and_then(|v| v.as_str()) {
            if !reason.is_empty() && reason != "FINISH_REASON_UNSPECIFIED" {
                *state.finish_reason.lock().unwrap() = Some(reason.to_string());
            }
        }
        let Some(parts) = candidate.pointer("/content/parts").and_then(|v| v.as_array()) else {
            continue;
        };
        for part in parts {
            if part.get("thought").and_then(|v| v.as_bool()) == Some(true) {
                let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
                if !text.is_empty() {
                    state.thinking_buffers.lock().unwrap().append(0, text);
                    push(encode_delta_event(
                        "thinking_delta",
                        Some(0),
                        None,
                        Some(text),
                        None,
                        None,
                        None,
                    ));
                }
            } else if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    state.content_block_buffers.lock().unwrap().append(0, text);
                    push(encode_delta_event(
                        "content",
                        Some(0),
                        Some(text),
                        None,
                        None,
                        None,
                        None,
                    ));
                }
            } else if let Some(fc) = part
                .get("functionCall")
                .or_else(|| part.get("function_call"))
                .and_then(|v| v.as_object())
            {
                if let Some(name) = fc.get("name").and_then(|v| v.as_str()) {
                    let args = fc
                        .get("args")
                        .map(|a| a.to_string())
                        .unwrap_or_else(|| "{}".to_string());
                    let idx = {
                        let mut n = state.next_tool_index.lock().unwrap();
                        let cur = *n;
                        *n += 1;
                        cur
                    };
                    // Gemini provides no tool-call id; synthesize a stable one so
                    // the TS side emits a function part (it needs a non-empty id).
                    let synth_id = format!("call_{idx}");
                    state.content_block_buffers.lock().unwrap().append(idx, &args);
                    push(encode_delta_event(
                        "tool_call_delta",
                        Some(idx),
                        None,
                        None,
                        Some(synth_id.as_str()),
                        Some(name),
                        Some(args.as_str()),
                    ));
                }
            }
        }
    }
}

#[napi]
pub fn anthropic_chat_streaming(
    api_key: String,
    model: String,
    request_body: String,
    trace_id_header: Option<String>,
    base_url: Option<String>,
    callback: JsFunction,
) -> Result<ProviderStreamHandle> {
    let url = format!(
        "{}/messages",
        base_url.unwrap_or_else(|| "https://api.anthropic.com/v1".to_string())
    );
    let mut headers: Vec<(String, String)> = vec![
        ("anthropic-version".to_string(), "2023-06-01".to_string()),
    ];
    if let Some(trace) = trace_id_header {
        headers.push(("x-trace-id".to_string(), trace));
    }
    run_streaming(
        StreamConfig {
            url,
            body: request_body,
            headers,
            model: Some(model),
            format: ProviderFormat::Anthropic,
            use_bearer_auth: false,
            api_key,
        },
        callback,
    )
}

#[napi]
pub fn openai_chat_streaming(
    api_key: String,
    model: String,
    request_body: String,
    trace_id_header: Option<String>,
    base_url: Option<String>,
    callback: JsFunction,
) -> Result<ProviderStreamHandle> {
    let url = format!(
        "{}/chat/completions",
        base_url.unwrap_or_else(|| "https://api.openai.com/v1".to_string())
    );
    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(trace) = trace_id_header {
        headers.push(("x-trace-id".to_string(), trace));
    }
    run_streaming(
        StreamConfig {
            url,
            body: request_body,
            headers,
            model: Some(model),
            format: ProviderFormat::OpenAi,
            use_bearer_auth: true,
            api_key,
        },
        callback,
    )
}

/// Streaming Gemini (Google GenAI) chat. Mirrors the one-shot `google_genai_chat`
/// but pushes each SSE delta as it arrives. Reuses `build_gemini_request` so the
/// request body construction stays identical to the non-streaming path.
#[napi]
pub fn google_genai_chat_streaming(
    api_key: String,
    model: String,
    messages: Vec<crate::message::Message>,
    system_prompt: Option<String>,
    tools: Option<Vec<crate::tool::Tool>>,
    max_tokens: Option<i32>,
    thinking_effort: Option<String>,
    base_url: Option<String>,
    callback: JsFunction,
) -> Result<ProviderStreamHandle> {
    let base = base_url.unwrap_or_else(|| crate::google_genai::DEFAULT_GEMINI_URL.to_string());
    let url = format!("{base}/{model}:streamGenerateContent?alt=sse&key={api_key}");
    let body = crate::google_genai::build_gemini_request(
        &model,
        &messages,
        system_prompt.as_deref(),
        tools.as_deref(),
        max_tokens,
        thinking_effort.as_deref(),
    )
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    run_streaming(
        StreamConfig {
            url,
            body,
            headers: Vec::new(),
            model: Some(model),
            format: ProviderFormat::Google,
            use_bearer_auth: false,
            api_key,
        },
        callback,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_delta_event_text_only() {
        let json = encode_delta_event("content_block_delta", Some(0), Some("hello"), None, None, None, None);
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "delta");
        assert_eq!(parsed["event_type"], "content_block_delta");
        assert_eq!(parsed["text_delta"], "hello");
        assert!(parsed["thinking_delta"].is_null());
        assert!(parsed["tool_call_args"].is_null());
    }

    #[test]
    fn encode_delta_event_thinking() {
        let json = encode_delta_event(
            "thinking_delta",
            Some(0),
            None,
            Some("reasoning"),
            None,
            None,
            None,
        );
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "delta");
        assert_eq!(parsed["event_type"], "thinking_delta");
        assert!(parsed["text_delta"].is_null());
        assert_eq!(parsed["thinking_delta"], "reasoning");
    }

    #[test]
    fn encode_delta_event_tool_call() {
        let json = encode_delta_event(
            "tool_call_delta",
            Some(2),
            None,
            None,
            Some("tu_1"),
            Some("get_weather"),
            Some(r#"{"loc":"SF"}"#),
        );
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "delta");
        assert_eq!(parsed["index"], 2);
        assert_eq!(parsed["tool_call_id"], "tu_1");
        assert_eq!(parsed["tool_call_name"], "get_weather");
        assert_eq!(parsed["tool_call_args"], r#"{"loc":"SF"}"#);
    }

    #[test]
    fn encode_done_event_round_trips() {
        let usage = TokenUsage {
            input_other: 10,
            output: 20,
            input_cache_read: 5,
            input_cache_creation: 1,
        };
        let json = encode_done_event(
            Some("msg_1"),
            Some("claude-3-7-sonnet"),
            &usage,
            Some("end_turn"),
            Some("t-1"),
        );
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "done");
        assert_eq!(parsed["id"], "msg_1");
        assert_eq!(parsed["model"], "claude-3-7-sonnet");
        assert_eq!(parsed["usage"]["output"], 20);
        assert_eq!(parsed["usage"]["input_cache_read"], 5);
        assert_eq!(parsed["finish_reason"], "end_turn");
        assert_eq!(parsed["trace_id"], "t-1");
    }

    #[test]
    fn encode_done_event_handles_nulls() {
        let usage = TokenUsage::new();
        let json = encode_done_event(None, None, &usage, None, None);
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert!(parsed["id"].is_null());
        assert!(parsed["model"].is_null());
        assert!(parsed["finish_reason"].is_null());
        assert!(parsed["trace_id"].is_null());
    }

    #[test]
    fn encode_error_event_carries_message() {
        let json = encode_error_event("upstream returned 503");
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "error");
        assert_eq!(parsed["message"], "upstream returned 503");
    }

    #[test]
    fn content_block_buffers_accumulate() {
        let mut b = ContentBlockBuffers::default();
        b.append(0, "{\"a\":");
        b.append(0, "1}");
        assert_eq!(b.take(0).as_deref(), Some("{\"a\":1}"));
        assert!(b.take(0).is_none());
    }

    #[test]
    fn apply_anthropic_usage_extracts_all_fields() {
        let usage_val = serde_json::json!({
            "input_tokens": 100,
            "output_tokens": 50,
            "cache_read_input_tokens": 25,
            "cache_creation_input_tokens": 5,
        });
        let usage: Mutex<TokenUsage> = Mutex::new(TokenUsage::new());
        apply_anthropic_usage(&usage_val, &usage);
        let u = usage.lock().unwrap();
        assert_eq!(u.input_other, 100);
        assert_eq!(u.output, 50);
        assert_eq!(u.input_cache_read, 25);
        assert_eq!(u.input_cache_creation, 5);
    }

    #[test]
    fn apply_openai_usage_extracts_all_fields() {
        let usage_val = serde_json::json!({
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "cached_tokens": 25,
        });
        let usage: Mutex<TokenUsage> = Mutex::new(TokenUsage::new());
        apply_openai_usage(&usage_val, &usage);
        let u = usage.lock().unwrap();
        assert_eq!(u.input_other, 100);
        assert_eq!(u.output, 50);
        assert_eq!(u.input_cache_read, 25);
    }

    #[test]
    fn anthropic_streaming_accumulates_full_event_sequence() {
        let events_str = vec![
            "event: message\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_real\",\"model\":\"claude-3-7\",\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
            "event: message\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: message\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
            "event: message\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}\n\n",
            "event: message\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: message\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        ];

        let state = StreamState {
            msg_id: Mutex::new(None),
            model: Mutex::new(None),
            usage: Mutex::new(TokenUsage::new()),
            finish_reason: Mutex::new(None),
            content_block_buffers: Mutex::new(ContentBlockBuffers::default()),
            thinking_buffers: Mutex::new(ContentBlockBuffers::default()),
            next_tool_index: Mutex::new(0),
        };

        for event_block in &events_str {
            process_event_block(event_block, &state, None, ProviderFormat::Anthropic);
        }

        assert_eq!(state.msg_id.lock().unwrap().as_deref(), Some("msg_real"));
        assert_eq!(state.model.lock().unwrap().as_deref(), Some("claude-3-7"));
        assert_eq!(state.usage.lock().unwrap().input_other, 1);
        assert_eq!(state.usage.lock().unwrap().output, 2);
        assert_eq!(
            state.finish_reason.lock().unwrap().as_deref(),
            Some("end_turn")
        );
    }

    #[test]
    fn openai_streaming_accumulates() {
        let events_str = vec![
            "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" world\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        ];

        let state = StreamState {
            msg_id: Mutex::new(None),
            model: Mutex::new(None),
            usage: Mutex::new(TokenUsage::new()),
            finish_reason: Mutex::new(None),
            content_block_buffers: Mutex::new(ContentBlockBuffers::default()),
            thinking_buffers: Mutex::new(ContentBlockBuffers::default()),
            next_tool_index: Mutex::new(0),
        };

        let mut terminated = false;
        for event_block in &events_str {
            if process_event_block(event_block, &state, None, ProviderFormat::OpenAi) {
                terminated = true;
                break;
            }
        }
        assert!(terminated);
        assert_eq!(state.model.lock().unwrap().as_deref(), Some("gpt-4o"));
        assert_eq!(state.finish_reason.lock().unwrap().as_deref(), Some("stop"));
    }

    #[test]
    fn thinking_delta_accumulates_in_thinking_buffer() {
        let state = StreamState {
            msg_id: Mutex::new(None),
            model: Mutex::new(None),
            usage: Mutex::new(TokenUsage::new()),
            finish_reason: Mutex::new(None),
            content_block_buffers: Mutex::new(ContentBlockBuffers::default()),
            thinking_buffers: Mutex::new(ContentBlockBuffers::default()),
            next_tool_index: Mutex::new(0),
        };
        let events = [
            "event: message\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"text\":\"\"}}\n\n",
            "event: message\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"step 1:\"}}\n\n",
            "event: message\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\" step 2\"}}\n\n",
            "event: message\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        ];
        for ev in &events {
            process_event_block(ev, &state, None, ProviderFormat::Anthropic);
        }
        assert_eq!(
            state.thinking_buffers.lock().unwrap().take(0).as_deref(),
            Some("step 1: step 2"),
        );
    }

    #[test]
    fn tool_call_delta_accumulates_arguments() {
        let state = StreamState {
            msg_id: Mutex::new(None),
            model: Mutex::new(None),
            usage: Mutex::new(TokenUsage::new()),
            finish_reason: Mutex::new(None),
            content_block_buffers: Mutex::new(ContentBlockBuffers::default()),
            thinking_buffers: Mutex::new(ContentBlockBuffers::default()),
            next_tool_index: Mutex::new(0),
        };
        let events = [
            "event: message\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_1\",\"name\":\"f\",\"input\":{}}}\n\n",
            "event: message\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"a\\\":\"}}\n\n",
            "event: message\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"1}\"}}\n\n",
            "event: message\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        ];
        for ev in &events {
            process_event_block(ev, &state, None, ProviderFormat::Anthropic);
        }
        assert_eq!(
            state.content_block_buffers.lock().unwrap().take(0).as_deref(),
            Some("{\"a\":1}"),
        );
    }

    #[test]
    fn handle_counter_is_monotonic() {
        let a = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        let b = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        assert!(b > a);
    }

    #[test]
    fn cancel_handle_is_safe_when_dropped() {
        let mut h = ProviderStreamHandle {
            id: 1,
            cancel_tx: None,
        };
        h.cancel();
    }

    #[test]
    fn unknown_event_types_are_silently_ignored() {
        let state = StreamState {
            msg_id: Mutex::new(None),
            model: Mutex::new(None),
            usage: Mutex::new(TokenUsage::new()),
            finish_reason: Mutex::new(None),
            content_block_buffers: Mutex::new(ContentBlockBuffers::default()),
            thinking_buffers: Mutex::new(ContentBlockBuffers::default()),
            next_tool_index: Mutex::new(0),
        };
        let event_block = "event: message\ndata: {\"type\":\"unknown_thing\",\"foo\":\"bar\"}\n\n";
        let _ = process_event_block(event_block, &state, None, ProviderFormat::Anthropic);
        assert!(state.msg_id.lock().unwrap().is_none());
    }

    #[test]
    fn google_streaming_text_usage_and_finish() {
        let state = StreamState {
            msg_id: Mutex::new(None),
            model: Mutex::new(None),
            usage: Mutex::new(TokenUsage::new()),
            finish_reason: Mutex::new(None),
            content_block_buffers: Mutex::new(ContentBlockBuffers::default()),
            thinking_buffers: Mutex::new(ContentBlockBuffers::default()),
            next_tool_index: Mutex::new(0),
        };
        let events = [
            "data: {\"responseId\":\"g1\",\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hello\"}]}}],\"usageMetadata\":{\"promptTokenCount\":5,\"cachedContentTokenCount\":2,\"candidatesTokenCount\":1}}\n\n",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\" world\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":5,\"cachedContentTokenCount\":2,\"candidatesTokenCount\":3}}\n\n",
        ];
        for ev in &events {
            assert!(!process_event_block(ev, &state, None, ProviderFormat::Google));
        }
        assert_eq!(state.msg_id.lock().unwrap().as_deref(), Some("g1"));
        assert_eq!(state.finish_reason.lock().unwrap().as_deref(), Some("STOP"));
        assert_eq!(state.usage.lock().unwrap().input_other, 3); // 5 prompt - 2 cached
        assert_eq!(state.usage.lock().unwrap().input_cache_read, 2);
        assert_eq!(state.usage.lock().unwrap().output, 3);
        assert_eq!(
            state.content_block_buffers.lock().unwrap().take(0).as_deref(),
            Some("Hello world"),
        );
    }

    #[test]
    fn google_streaming_thinking_and_tool_call() {
        let state = StreamState {
            msg_id: Mutex::new(None),
            model: Mutex::new(None),
            usage: Mutex::new(TokenUsage::new()),
            finish_reason: Mutex::new(None),
            content_block_buffers: Mutex::new(ContentBlockBuffers::default()),
            thinking_buffers: Mutex::new(ContentBlockBuffers::default()),
            next_tool_index: Mutex::new(0),
        };
        let events = [
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"reasoning\",\"thought\":true}]}}]}\n\n",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"get_weather\",\"args\":{\"loc\":\"SF\"}}}]},\"finishReason\":\"STOP\"}]}\n\n",
        ];
        for ev in &events {
            process_event_block(ev, &state, None, ProviderFormat::Google);
        }
        assert_eq!(
            state.thinking_buffers.lock().unwrap().take(0).as_deref(),
            Some("reasoning"),
        );
        // Gemini has no tool-call id/index; the first functionCall gets index 0.
        assert_eq!(
            state.content_block_buffers.lock().unwrap().take(0).as_deref(),
            Some("{\"loc\":\"SF\"}"),
        );
        assert_eq!(state.finish_reason.lock().unwrap().as_deref(), Some("STOP"));
    }
}
