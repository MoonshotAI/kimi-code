// Phase 9.1 -- Rust `run_turn` skeleton.
//
// Migrates the LLM call + response parsing hot path from
// `packages/agent-core/src/loop/turn-step.ts` into Rust. The TS
// orchestrator keeps the state machine and approval/permission
// logic; Rust owns the HTTP request, SSE parsing, and accumulated
// state -- so the FFI crosses once per turn instead of once per
// event.
//
// Wire model:
//
//   TS turn loop                          Rust
//      |                                     |
//      |--- runTurn(TurnRequest) ----------->|
//      |                                     |  spawn task:
//      |                                     |   build request
//      |                                     |   HTTP POST
//      |                                     |   read SSE stream
//      |                                     |   accumulate parts
//      |<--------- TurnResult --------------|
//
// The returned `TurnResult` is the same shape that
// `executeLoopStep` in the TS loop eventually produces -- the TS
// side maps it back to `Message.content` + `Message.toolCalls` and
// dispatches the actual tool execution.

use std::sync::Mutex;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::message::TokenUsage;
use crate::streaming_providers::{apply_anthropic_usage, apply_openai_usage};

/// Provider selection. Drives URL, auth header, SSE terminator, and
/// event-mapping in one switch.
#[derive(Debug, Clone)]
pub enum Provider {
    Anthropic { api_key: String },
    OpenAI { api_key: String },
}

/// One turn's worth of input.
#[derive(Debug, Clone)]
pub struct TurnRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<TurnMessage>,
    pub tools: Vec<TurnTool>,
    pub max_tokens: Option<u32>,
    pub thinking_effort: Option<String>,
    pub base_url: Option<String>,
    pub provider: Provider,
    pub trace_id: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnTool {
    pub name: String,
    pub description: String,
    pub parameters: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text { text: String },
    Think { think: String, encrypted: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    pub arguments_raw: String,
    pub stream_index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnResult {
    pub content_parts: Vec<ContentPart>,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    pub usage: TokenUsage,
    pub id: Option<String>,
    pub model: Option<String>,
    pub trace_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct ToolCallBuilder {
    id: String,
    name: String,
    args_raw: String,
    head_emitted: bool,
}

struct TurnAccumulator {
    msg_id: Mutex<Option<String>>,
    model: Mutex<Option<String>>,
    usage: Mutex<TokenUsage>,
    finish_reason: Mutex<Option<String>>,
    text_blocks: Mutex<std::collections::BTreeMap<u32, String>>,
    thinking_blocks: Mutex<std::collections::BTreeMap<u32, String>>,
    tool_calls: Mutex<std::collections::BTreeMap<u32, ToolCallBuilder>>,
}

impl Default for TurnAccumulator {
    fn default() -> Self {
        Self {
            msg_id: Mutex::new(None),
            model: Mutex::new(None),
            usage: Mutex::new(TokenUsage::new()),
            finish_reason: Mutex::new(None),
            text_blocks: Mutex::new(Default::default()),
            thinking_blocks: Mutex::new(Default::default()),
            tool_calls: Mutex::new(Default::default()),
        }
    }
}

fn handle_anthropic_event(parsed: &Value, acc: &TurnAccumulator) {
    let kind = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let index = parsed.get("index").and_then(|v| v.as_u64()).map(|n| n as u32);

    match kind {
        "message_start" => {
            if let Some(id) = parsed.pointer("/message/id").and_then(|v| v.as_str()) {
                *acc.msg_id.lock().unwrap() = Some(id.to_string());
            }
            if let Some(model) = parsed.pointer("/message/model").and_then(|v| v.as_str()) {
                *acc.model.lock().unwrap() = Some(model.to_string());
            }
            if let Some(u) = parsed.pointer("/message/usage") {
                apply_anthropic_usage(u, &acc.usage);
            }
        }
        "content_block_delta" => {
            let delta_type = parsed.pointer("/delta/type").and_then(|v| v.as_str()).unwrap_or("");
            let idx = index.unwrap_or(0);
            match delta_type {
                "text_delta" => {
                    let text = parsed
                        .pointer("/delta/text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    acc.text_blocks
                        .lock()
                        .unwrap()
                        .entry(idx)
                        .or_default()
                        .push_str(text);
                }
                "thinking_delta" => {
                    let text = parsed
                        .pointer("/delta/thinking")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    acc.thinking_blocks
                        .lock()
                        .unwrap()
                        .entry(idx)
                        .or_default()
                        .push_str(text);
                }
                "input_json_delta" => {
                    let args = parsed
                        .pointer("/delta/partial_json")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let mut tcs = acc.tool_calls.lock().unwrap();
                    let entry = tcs.entry(idx).or_default();
                    entry.args_raw.push_str(args);
                }
                _ => {}
            }
        }
        "content_block_start" => {
            let block_type = parsed
                .pointer("/content_block/type")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if block_type == "tool_use" {
                let id = parsed
                    .pointer("/content_block/id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let name = parsed
                    .pointer("/content_block/name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let mut tcs = acc.tool_calls.lock().unwrap();
                let entry = tcs.entry(index.unwrap_or(0)).or_default();
                if !entry.head_emitted {
                    entry.id = id.to_string();
                    entry.name = name.to_string();
                    entry.head_emitted = true;
                }
            }
        }
        "content_block_stop" => {}
        "message_delta" => {
            if let Some(stop) = parsed.pointer("/delta/stop_reason").and_then(|v| v.as_str()) {
                *acc.finish_reason.lock().unwrap() = Some(stop.to_string());
            }
            if let Some(u) = parsed.pointer("/usage") {
                apply_anthropic_usage(u, &acc.usage);
            }
        }
        _ => {}
    }
}

fn handle_openai_event(parsed: &Value, acc: &TurnAccumulator) {
    if let Some(id) = parsed.get("id").and_then(|v| v.as_str()) {
        if acc.msg_id.lock().unwrap().is_none() {
            *acc.msg_id.lock().unwrap() = Some(id.to_string());
        }
    }
    if let Some(model) = parsed.get("model").and_then(|v| v.as_str()) {
        *acc.model.lock().unwrap() = Some(model.to_string());
    }
    if let Some(u) = parsed.get("usage") {
        apply_openai_usage(u, &acc.usage);
    }
    if let Some(choice) = parsed.pointer("/choices/0") {
        if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
            *acc.finish_reason.lock().unwrap() = Some(fr.to_string());
        }
        if let Some(delta) = choice.get("delta") {
            if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                if !content.is_empty() {
                    acc.text_blocks
                        .lock()
                        .unwrap()
                        .entry(0)
                        .or_default()
                        .push_str(content);
                }
            }
            if let Some(reasoning) = delta.get("reasoning_content").and_then(|v| v.as_str()) {
                if !reasoning.is_empty() {
                    acc.thinking_blocks
                        .lock()
                        .unwrap()
                        .entry(0)
                        .or_default()
                        .push_str(reasoning);
                }
            }
            if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                let mut tcs = acc.tool_calls.lock().unwrap();
                for tc in tool_calls {
                    let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    let entry = tcs.entry(idx).or_default();
                    if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                        if !entry.head_emitted {
                            entry.id = id.to_string();
                            entry.head_emitted = true;
                        }
                    }
                    if let Some(name) = tc
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|v| v.as_str())
                    {
                        entry.name = name.to_string();
                    }
                    if let Some(args) = tc
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(|v| v.as_str())
                    {
                        entry.args_raw.push_str(args);
                    }
                }
            }
        }
    }
}

fn build_anthropic_request_body(req: &TurnRequest) -> Result<String, String> {
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(16384),
        "stream": true,
        "messages": req.messages,
    });
    if let Some(s) = &req.system {
        if !s.is_empty() {
            body["system"] = json!(s);
        }
    }
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters.clone().unwrap_or_else(|| json!({})),
                })
            })
            .collect();
        body["tools"] = json!(tools);
    }
    if let Some(effort) = &req.thinking_effort {
        if !effort.is_empty() {
            let is_adaptive = is_adaptive_model(&req.model);
            if effort == "off" {
                body["thinking"] = json!({"type": "disabled"});
            } else if is_adaptive {
                body["thinking"] = json!({"type": "adaptive", "display": "summarized"});
                if effort != "on" && effort != "adaptive" {
                    body["output_config"] = json!({"effort": effort});
                }
            } else {
                let budget = match effort.as_str() {
                    "low" => 1024,
                    "medium" => 4096,
                    "on" | "high" | "xhigh" | "max" => 32_000,
                    _ => 4096,
                };
                body["thinking"] = json!({"type": "enabled", "budget_tokens": budget});
            }
        }
    }
    serde_json::to_string(&body).map_err(|e| format!("body serialize: {e}"))
}

fn build_openai_request_body(req: &TurnRequest) -> Result<String, String> {
    let mut messages: Vec<Value> = Vec::new();
    for m in &req.messages {
        let mut obj = json!({ "role": m.role, "content": m.content });
        if let Some(id) = &m.tool_call_id {
            obj["tool_call_id"] = json!(id);
        }
        messages.push(obj);
    }
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(16384),
        "stream": true,
        "messages": messages,
    });
    if let Some(s) = &req.system {
        if !s.is_empty() {
            body["system_prompt"] = json!(s);
        }
    }
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters.clone().unwrap_or_else(|| json!({})),
                    }
                })
            })
            .collect();
        body["tools"] = json!(tools);
    }
    if let Some(effort) = &req.thinking_effort {
        if !effort.is_empty() && effort != "off" {
            body["reasoning_effort"] = json!(effort);
        }
    }
    serde_json::to_string(&body).map_err(|e| format!("body serialize: {e}"))
}

async fn consume_sse_stream(
    response: reqwest::Response,
    provider: &Provider,
    acc: &TurnAccumulator,
) -> Result<(), String> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("body read: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buffer.find("\n\n") {
            let event_block: String = buffer.drain(..idx + 2).collect();
            dispatch_sse_block(&event_block, provider, acc)?;
        }
    }
    Ok(())
}

fn dispatch_sse_block(
    event_block: &str,
    provider: &Provider,
    acc: &TurnAccumulator,
) -> Result<(), String> {
    let mut event_type: Option<&str> = None;
    let mut data_lines: Vec<&str> = Vec::new();
    for line in event_block.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("event: ") {
            event_type = Some(rest);
        } else if let Some(rest) = trimmed.strip_prefix("data: ") {
            data_lines.push(rest);
        }
    }
    let data = data_lines.join("\n");

    match provider {
        Provider::Anthropic { .. } => {
            if event_type == Some("message_stop") {
                return Ok(());
            }
        }
        Provider::OpenAI { .. } => {
            if data.trim() == "[DONE]" {
                return Ok(());
            }
        }
    }

    if data.is_empty() {
        return Ok(());
    }
    let parsed: Value = serde_json::from_str(&data)
        .map_err(|e| format!("SSE JSON parse: {e}"))?;
    match provider {
        Provider::Anthropic { .. } => handle_anthropic_event(&parsed, acc),
        Provider::OpenAI { .. } => handle_openai_event(&parsed, acc),
    }
    Ok(())
}

pub async fn run_turn(req: TurnRequest) -> Result<TurnResult, String> {
    let _timeout = req.timeout_ms.unwrap_or(60_000);
    let client = crate::http::HttpClient::shared();

    let (url, body, api_key) = match &req.provider {
        Provider::Anthropic { api_key } => {
            let url = format!(
                "{}/messages",
                req.base_url
                    .clone()
                    .unwrap_or_else(|| "https://api.anthropic.com/v1".to_string())
            );
            let body = build_anthropic_request_body(&req)?;
            (url, body, api_key.clone())
        }
        Provider::OpenAI { api_key } => {
            let url = format!(
                "{}/chat/completions",
                req.base_url
                    .clone()
                    .unwrap_or_else(|| "https://api.openai.com/v1".to_string())
            );
            let body = build_openai_request_body(&req)?;
            (url, body, api_key.clone())
        }
    };

    let mut hdrs: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    hdrs.insert("x-api-key".to_string(), api_key.clone());
    if matches!(req.provider, Provider::Anthropic { .. }) {
        hdrs.insert("anthropic-version".to_string(), "2023-06-01".to_string());
        if !is_adaptive_model(&req.model) {
            hdrs.insert(
                "anthropic-beta".to_string(),
                "interleaved-thinking-2025-05-14".to_string(),
            );
        }
    }
    if let Some(trace) = &req.trace_id {
        hdrs.insert("x-trace-id".to_string(), trace.clone());
    }

    let response = client
        .post_json_stream(&url, &api_key, &body, Some(&hdrs))
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    let trace_id = response
        .headers()
        .get("x-trace-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {} (error): {}", status.as_u16(), body));
    }

    let acc = TurnAccumulator::default();
    consume_sse_stream(response, &req.provider, &acc).await?;

    let content_parts = {
        let mut parts: Vec<ContentPart> = Vec::new();
        // Emit in the same order they appeared in the stream: we
        // maintain a single `next_index` cursor and pull whichever
        // block (text or thinking) has content at that index. This
        // matches the Anthropic / OpenAI stream semantics where
        // thinking and text blocks interleave by index.
        let mut text_blocks = std::mem::take(&mut *acc.text_blocks.lock().unwrap());
        let mut thinking_blocks = std::mem::take(&mut *acc.thinking_blocks.lock().unwrap());
        let max_index = text_blocks
            .keys()
            .chain(thinking_blocks.keys())
            .copied()
            .max()
            .unwrap_or(0);
        for idx in 0..=max_index {
            if let Some(think) = thinking_blocks.remove(&idx) {
                if !think.is_empty() {
                    parts.push(ContentPart::Think {
                        think,
                        encrypted: None,
                    });
                }
            }
            if let Some(text) = text_blocks.remove(&idx) {
                if !text.is_empty() {
                    parts.push(ContentPart::Text { text });
                }
            }
        }
        parts
    };

    let tool_calls: Vec<ToolCall> = {
        let tcs = std::mem::take(&mut *acc.tool_calls.lock().unwrap());
        let mut keys: Vec<u32> = tcs.keys().copied().collect();
        keys.sort();
        keys.into_iter()
            .filter_map(|idx| {
                tcs.get(&idx).map(|b| {
                    let arguments =
                        serde_json::from_str(&b.args_raw).unwrap_or_else(|_| json!({}));
                    ToolCall {
                        id: b.id.clone(),
                        name: b.name.clone(),
                        arguments,
                        arguments_raw: b.args_raw.clone(),
                        stream_index: idx,
                    }
                })
            })
            .collect()
    };

    let usage = acc.usage.lock().unwrap().clone();
    let finish_reason = acc.finish_reason.lock().unwrap().clone();
    let id = acc.msg_id.lock().unwrap().clone();
    let model = acc.model.lock().unwrap().clone();

    Ok(TurnResult {
        content_parts,
        tool_calls,
        finish_reason,
        usage,
        id,
        model,
        trace_id,
    })
}

fn is_adaptive_model(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("opus-5")
        || m.contains("opus-4-6")
        || m.contains("opus-4-7")
        || m.contains("opus-4-8")
        || m.contains("sonnet-5")
        || m.contains("fable-5")
        || m.contains("mythos-5")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_registry::{ToolRegistry, ValidationError};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn anthropic_message_start(id: &str, model: &str) -> String {
        format!(
            "event: message\ndata: {{\"type\":\"message_start\",\"message\":{{\"id\":\"{id}\",\"model\":\"{model}\",\"usage\":{{\"input_tokens\":10,\"output_tokens\":0}}}}}}\n\n"
        )
    }

    fn anthropic_text_delta(index: u32, text: &str) -> String {
        format!(
            "event: message\ndata: {{\"type\":\"content_block_delta\",\"index\":{index},\"delta\":{{\"type\":\"text_delta\",\"text\":\"{text}\"}}}}\n\n"
        )
    }

    fn anthropic_thinking_delta(index: u32, text: &str) -> String {
        format!(
            "event: message\ndata: {{\"type\":\"content_block_delta\",\"index\":{index},\"delta\":{{\"type\":\"thinking_delta\",\"thinking\":\"{text}\"}}}}\n\n"
        )
    }

    fn anthropic_tool_use(index: u32, id: &str, name: &str, args: &str) -> Vec<String> {
        // Build the head event via `serde_json` so escaping is correct.
        let head_payload = serde_json::json!({
            "type": "content_block_start",
            "index": index,
            "content_block": {
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": {},
            }
        });
        let mut chunks = vec![format!(
            "event: message\ndata: {}\n\n",
            serde_json::to_string(&head_payload).unwrap()
        )];
        // Split the args string into 3-byte chunks to simulate streaming
        // JSON. Build each delta via `serde_json::json!` so embedded
        // quotes and braces are properly escaped into the
        // `partial_json` string value.
        for (i, _) in args.as_bytes().chunks(3).enumerate() {
            let chunk = &args[i * 3..std::cmp::min((i + 1) * 3, args.len())];
            let delta_payload = serde_json::json!({
                "type": "content_block_delta",
                "index": index,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": chunk,
                }
            });
            chunks.push(format!(
                "event: message\ndata: {}\n\n",
                serde_json::to_string(&delta_payload).unwrap()
            ));
        }
        let stop_payload = serde_json::json!({
            "type": "content_block_stop",
            "index": index,
        });
        chunks.push(format!(
            "event: message\ndata: {}\n\n",
            serde_json::to_string(&stop_payload).unwrap()
        ));
        chunks
    }

    fn anthropic_message_delta(stop: &str) -> String {
        format!(
            "event: message\ndata: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"{stop}\"}},\"usage\":{{\"output_tokens\":5}}}}\n\n"
        )
    }

    fn anthropic_message_stop() -> String {
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_string()
    }

    async fn spawn_sse_server(events: Vec<String>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let n = stream.read(&mut tmp).await.unwrap();
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let mut body = String::new();
            for e in &events {
                body.push_str(e);
            }
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                 x-trace-id: trace-xyz\r\nContent-Length: {}\r\n\
                 Connection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).await.unwrap();
            stream.write_all(body.as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
        });
        port
    }

    #[tokio::test]
    async fn run_turn_anthropic_text_only() {
        let mut events = vec![
            anthropic_message_start("msg_1", "claude-3-7-sonnet"),
            anthropic_text_delta(0, "hello"),
            anthropic_text_delta(0, " world"),
        ];
        events.push(anthropic_message_delta("end_turn"));
        events.push(anthropic_message_stop());
        let port = spawn_sse_server(events).await;

        let req = TurnRequest {
            model: "claude-3-7-sonnet".into(),
            system: None,
            messages: vec![TurnMessage {
                role: "user".into(),
                content: "hi".into(),
                tool_call_id: None,
            }],
            tools: vec![],
            max_tokens: Some(1024),
            thinking_effort: None,
            base_url: Some(format!("http://127.0.0.1:{port}")),
            provider: Provider::Anthropic {
                api_key: "test".into(),
            },
            trace_id: None,
            timeout_ms: Some(5000),
        };
        let result = run_turn(req).await.unwrap();
        assert_eq!(result.content_parts.len(), 1);
        match &result.content_parts[0] {
            ContentPart::Text { text } => assert_eq!(text, "hello world"),
            _ => panic!("expected Text part"),
        }
        assert_eq!(result.finish_reason.as_deref(), Some("end_turn"));
        assert_eq!(result.id.as_deref(), Some("msg_1"));
        assert_eq!(result.usage.output, 5);
        assert_eq!(result.usage.input_other, 10);
        assert_eq!(result.trace_id.as_deref(), Some("trace-xyz"));
        assert!(result.tool_calls.is_empty());
    }

    #[tokio::test]
    async fn run_turn_anthropic_text_and_thinking() {
        let mut events = vec![
            anthropic_message_start("msg_2", "claude-opus-5"),
            anthropic_thinking_delta(0, "Let me think..."),
            anthropic_text_delta(1, "Hello!"),
            anthropic_text_delta(1, " World!"),
        ];
        events.push(anthropic_message_delta("end_turn"));
        events.push(anthropic_message_stop());
        let port = spawn_sse_server(events).await;

        let req = TurnRequest {
            model: "claude-opus-5".into(),
            system: Some("You are helpful.".into()),
            messages: vec![TurnMessage {
                role: "user".into(),
                content: "say hello".into(),
                tool_call_id: None,
            }],
            tools: vec![],
            max_tokens: None,
            thinking_effort: Some("medium".into()),
            base_url: Some(format!("http://127.0.0.1:{port}")),
            provider: Provider::Anthropic {
                api_key: "test".into(),
            },
            trace_id: Some("t-42".into()),
            timeout_ms: Some(5000),
        };
        let result = run_turn(req).await.unwrap();
        assert_eq!(result.content_parts.len(), 2);
        match &result.content_parts[0] {
            ContentPart::Think { think, encrypted } => {
                assert_eq!(think, "Let me think...");
                assert!(encrypted.is_none());
            }
            _ => panic!("expected Think first"),
        }
        match &result.content_parts[1] {
            ContentPart::Text { text } => assert_eq!(text, "Hello! World!"),
            _ => panic!("expected Text second"),
        }
        assert_eq!(result.model.as_deref(), Some("claude-opus-5"));
    }

    #[tokio::test]
    async fn run_turn_anthropic_tool_call() {
        let args = r#"{"location":"San Francisco"}"#;
        let mut events = vec![anthropic_message_start("msg_3", "claude-3-7-sonnet")];
        events.extend(anthropic_tool_use(0, "tu_1", "get_weather", args));
        events.push(anthropic_message_delta("tool_use"));
        events.push(anthropic_message_stop());
        let port = spawn_sse_server(events).await;

        let req = TurnRequest {
            model: "claude-3-7-sonnet".into(),
            system: None,
            messages: vec![TurnMessage {
                role: "user".into(),
                content: "weather?".into(),
                tool_call_id: None,
            }],
            tools: vec![TurnTool {
                name: "get_weather".into(),
                description: "Get weather".into(),
                parameters: Some(json!({"type":"object"})),
            }],
            max_tokens: None,
            thinking_effort: None,
            base_url: Some(format!("http://127.0.0.1:{port}")),
            provider: Provider::Anthropic {
                api_key: "test".into(),
            },
            trace_id: None,
            timeout_ms: Some(5000),
        };
        let result = run_turn(req).await.unwrap();
        assert_eq!(result.tool_calls.len(), 1);
        let tc = &result.tool_calls[0];
        assert_eq!(tc.id, "tu_1");
        assert_eq!(tc.name, "get_weather");
        assert_eq!(tc.arguments["location"], "San Francisco");
        assert_eq!(tc.stream_index, 0);
        assert_eq!(result.finish_reason.as_deref(), Some("tool_use"));
    }

    #[tokio::test]
    async fn run_turn_handles_malformed_tool_args() {
        let events = vec![
            anthropic_message_start("msg_4", "claude-3-7-sonnet"),
            "event: message\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_2\",\"name\":\"f\",\"input\":{}}}\n\n".to_string(),
            "event: message\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{not valid\"}}\n\n".to_string(),
            "event: message\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n".to_string(),
            anthropic_message_delta("tool_use"),
            anthropic_message_stop(),
        ];
        let port = spawn_sse_server(events).await;

        let req = TurnRequest {
            model: "claude-3-7-sonnet".into(),
            system: None,
            messages: vec![TurnMessage {
                role: "user".into(),
                content: "x".into(),
                tool_call_id: None,
            }],
            tools: vec![],
            max_tokens: None,
            thinking_effort: None,
            base_url: Some(format!("http://127.0.0.1:{port}")),
            provider: Provider::Anthropic {
                api_key: "test".into(),
            },
            trace_id: None,
            timeout_ms: Some(5000),
        };
        let result = run_turn(req).await.unwrap();
        assert_eq!(result.tool_calls.len(), 1);
        let tc = &result.tool_calls[0];
        assert_eq!(tc.arguments, json!({}));
        assert_eq!(tc.arguments_raw, "{not valid");
    }

    #[test]
    fn run_turn_adaptive_model_emits_thinking_adaptive() {
        let body = build_anthropic_request_body(&TurnRequest {
            model: "claude-opus-5-20260101".into(),
            system: Some("sys".into()),
            messages: vec![TurnMessage {
                role: "user".into(),
                content: "hi".into(),
                tool_call_id: None,
            }],
            tools: vec![],
            max_tokens: Some(2048),
            thinking_effort: Some("high".into()),
            base_url: None,
            provider: Provider::Anthropic {
                api_key: "x".into(),
            },
            trace_id: None,
            timeout_ms: None,
        })
        .unwrap();
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["thinking"]["type"], "adaptive");
        assert_eq!(v["thinking"]["display"], "summarized");
        assert_eq!(v["output_config"]["effort"], "high");
    }

    #[test]
    fn run_turn_budget_model_emits_thinking_enabled() {
        let body = build_anthropic_request_body(&TurnRequest {
            model: "claude-opus-4-5".into(),
            system: None,
            messages: vec![TurnMessage {
                role: "user".into(),
                content: "x".into(),
                tool_call_id: None,
            }],
            tools: vec![],
            max_tokens: None,
            thinking_effort: Some("medium".into()),
            base_url: None,
            provider: Provider::Anthropic {
                api_key: "x".into(),
            },
            trace_id: None,
            timeout_ms: None,
        })
        .unwrap();
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["thinking"]["type"], "enabled");
        assert_eq!(v["thinking"]["budget_tokens"], 4096);
    }

    #[test]
    fn openai_request_body_includes_system_prompt() {
        let body = build_openai_request_body(&TurnRequest {
            model: "gpt-4o".into(),
            system: Some("be brief".into()),
            messages: vec![TurnMessage {
                role: "user".into(),
                content: "hi".into(),
                tool_call_id: None,
            }],
            tools: vec![],
            max_tokens: None,
            thinking_effort: None,
            base_url: None,
            provider: Provider::OpenAI {
                api_key: "x".into(),
            },
            trace_id: None,
            timeout_ms: None,
        })
        .unwrap();
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["system_prompt"], "be brief");
        assert_eq!(v["stream"], true);
    }

    #[test]
    fn is_adaptive_model_matches_opus5_and_friends() {
        for m in &[
            "claude-opus-5",
            "claude-opus-4-6",
            "claude-opus-4-7",
            "claude-opus-4-8",
            "claude-sonnet-5",
            "claude-fable-5",
            "claude-mythos-5",
        ] {
            assert!(is_adaptive_model(m), "expected adaptive for {m}");
        }
        for m in &[
            "claude-opus-4-5",
            "claude-3-7-sonnet",
            "claude-haiku-4-5",
        ] {
            assert!(!is_adaptive_model(m), "expected budget for {m}");
        }
    }

    #[test]
    fn turn_result_serializes_to_expected_shape() {
        let result = TurnResult {
            content_parts: vec![ContentPart::Text { text: "hi".into() }],
            tool_calls: vec![],
            finish_reason: Some("end_turn".into()),
            usage: TokenUsage {
                input_other: 1,
                output: 2,
                input_cache_read: 0,
                input_cache_creation: 0,
            },
            id: Some("msg_1".into()),
            model: Some("claude-3-7-sonnet".into()),
            trace_id: Some("t-1".into()),
        };
        let s = serde_json::to_string(&result).unwrap();
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["content_parts"][0]["type"], "text");
        assert_eq!(v["content_parts"][0]["text"], "hi");
        assert_eq!(v["finish_reason"], "end_turn");
        assert_eq!(v["usage"]["output"], 2);
        assert_eq!(v["id"], "msg_1");
        assert_eq!(v["model"], "claude-3-7-sonnet");
        assert_eq!(v["trace_id"], "t-1");
    }

    /// End-to-end integration: `run_turn` produces a `ToolCall` that
    /// passes `ToolRegistry::validate`. This is the contract that
    /// `executeLoopStep` in the TS loop depends on — a tool call that
    /// survives `run_turn` must be safe to dispatch.
    #[tokio::test]
    async fn run_turn_tool_call_passes_registry_validation() {
        let args = r#"{"location":"San Francisco"}"#;
        let mut events = vec![anthropic_message_start("msg_x", "claude-3-7-sonnet")];
        events.extend(anthropic_tool_use(0, "tu_99", "get_weather", args));
        events.push(anthropic_message_delta("tool_use"));
        events.push(anthropic_message_stop());
        let port = spawn_sse_server(events).await;

        // Pre-register the tool in the registry — exactly what the
        // TS loop does at agent startup.
        let mut registry = ToolRegistry::new();
        registry
            .register(&TurnTool {
                name: "get_weather".into(),
                description: "Get weather".into(),
                parameters: Some(json!({
                    "type": "object",
                    "properties": {
                        "location": {"type": "string"}
                    }
                })),
            })
            .unwrap();

        let req = TurnRequest {
            model: "claude-3-7-sonnet".into(),
            system: None,
            messages: vec![TurnMessage {
                role: "user".into(),
                content: "weather?".into(),
                tool_call_id: None,
            }],
            tools: vec![TurnTool {
                name: "get_weather".into(),
                description: "Get weather".into(),
                parameters: Some(json!({"type": "object"})),
            }],
            max_tokens: None,
            thinking_effort: None,
            base_url: Some(format!("http://127.0.0.1:{port}")),
            provider: Provider::Anthropic {
                api_key: "test".into(),
            },
            trace_id: None,
            timeout_ms: Some(5000),
        };
        let result = run_turn(req).await.unwrap();
        assert_eq!(result.tool_calls.len(), 1);

        // The tool call must be validatable against the registry.
        let call = &result.tool_calls[0];
        registry.validate(call).unwrap_or_else(|e| {
            panic!("registry rejected call: {e}");
        });

        // And the parsed arguments are usable.
        assert_eq!(call.arguments["location"], "San Francisco");
    }

    /// Negative integration: a tool call referencing an unknown tool
    /// is rejected by the registry. (Useful for the TS loop's error
    /// recovery path.)
    #[tokio::test]
    async fn run_turn_unknown_tool_is_flagged_by_registry() {
        // Server emits a tool call for a tool the registry doesn't know
        // about. `run_turn` itself doesn't know what's registered, so
        // it produces the call as-is — the registry is responsible for
        // detecting the mismatch.
        let args = r#"{"x":1}"#;
        let mut events = vec![anthropic_message_start("msg_y", "claude-3-7-sonnet")];
        events.extend(anthropic_tool_use(0, "tu_50", "phantom_tool", args));
        events.push(anthropic_message_delta("tool_use"));
        events.push(anthropic_message_stop());
        let port = spawn_sse_server(events).await;

        let mut registry = ToolRegistry::new();
        registry
            .register(&TurnTool {
                name: "different_tool".into(),
                description: "unrelated".into(),
                parameters: Some(json!({})),
            })
            .unwrap();

        let req = TurnRequest {
            model: "claude-3-7-sonnet".into(),
            system: None,
            messages: vec![TurnMessage {
                role: "user".into(),
                content: "test".into(),
                tool_call_id: None,
            }],
            tools: vec![TurnTool {
                name: "phantom_tool".into(), // register the tool
                description: "test".into(),
                parameters: Some(json!({})),
            }],
            max_tokens: None,
            thinking_effort: None,
            base_url: Some(format!("http://127.0.0.1:{port}")),
            provider: Provider::Anthropic {
                api_key: "test".into(),
            },
            trace_id: None,
            timeout_ms: Some(5000),
        };
        let result = run_turn(req).await.unwrap();
        assert_eq!(result.tool_calls.len(), 1);
        // Now wipe the registry to simulate the TS side losing sync.
        registry.unregister("phantom_tool");
        // The call should fail validation.
        let err = registry.validate(&result.tool_calls[0]).unwrap_err();
        assert!(matches!(err, ValidationError::UnknownTool { .. }));
    }
}