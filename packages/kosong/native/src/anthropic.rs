//! Anthropic Messages API adapter.
//! Mirrors `packages/kosong/src/providers/anthropic.ts`.

use crate::errors::ProviderError;
use crate::http::HttpClient;
use crate::message::*;
use napi_derive::napi;
use std::collections::HashMap;

const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";

/// Map a `ThinkingEffort` token to an Anthropic `budget_tokens` value.
/// Used in `budget` mode for Opus 4.5 and earlier.
/// Mirrors `budgetTokensForEffort` in `packages/kosong/src/providers/anthropic.ts`.
fn budget_tokens_for_effort(effort: &str) -> Option<i32> {
    match effort.to_lowercase().as_str() {
        "low" => Some(1024),
        "medium" => Some(4096),
        "on" | "high" | "xhigh" | "max" => Some(32_000),
        _ => None,
    }
}

/// Determine the thinking mode for an Anthropic-protocol model by name.
/// Mirrors `matchKnownAnthropicModelProfile` in
/// `packages/kosong/src/providers/anthropic-profile.ts`.
///
/// Returns `Adaptive` for Opus 4.6+, Sonnet 5, Opus 5, Fable 5, Mythos 5.
/// Returns `Budget` for Opus 4.5, Sonnet/Haiku <= 4.5, and unknown models
/// (defaulting to the conservative budget mode for safety).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThinkingMode {
    Budget,
    Adaptive,
}

fn resolve_thinking_mode(model: &str) -> ThinkingMode {
    let normalized = model.to_lowercase();

    // Adaptive-mode families. Order matters — more specific patterns first.
    if normalized.contains("opus-5")
        || normalized.contains("opus-4-8")
        || normalized.contains("opus-4-7")
        || normalized.contains("opus-4-6")
        || normalized.contains("sonnet-5")
        || normalized.contains("sonnet-4-6")
        || normalized.contains("fable-5")
        || normalized.contains("mythos-5")
    {
        return ThinkingMode::Adaptive;
    }
    ThinkingMode::Budget
}

fn build_anthropic_request(
    model: &str,
    messages: &[Message],
    system_prompt: Option<&str>,
    tools: Option<&[crate::tool::Tool]>,
    max_tokens: Option<i32>,
    thinking_effort: Option<&str>,
) -> Result<String, ProviderError> {
    let mut body = serde_json::Map::new();

    body.insert("model".to_string(), serde_json::Value::String(model.to_string()));
    body.insert("stream".to_string(), serde_json::Value::Bool(true));

    // max_tokens
    body.insert(
        "max_tokens".to_string(),
        serde_json::Value::Number(serde_json::Number::from(max_tokens.unwrap_or(4096) as i64)),
    );

    // thinking — model-aware emission matching TS `withThinking` logic.
    if let Some(effort_raw) = thinking_effort {
        let effort = effort_raw.to_lowercase();
        match resolve_thinking_mode(model) {
            ThinkingMode::Adaptive => {
                // Opus 5 / Sonnet 5 / Opus 4.6+ / Fable 5 / Mythos 5 use the
                // adaptive API: `thinking: { type: 'adaptive', display: 'summarized' }`
                // plus `output_config: { effort: ... }` for granular control.
                if effort == "off" {
                    body.insert(
                        "thinking".to_string(),
                        serde_json::json!({ "type": "disabled" }),
                    );
                } else {
                    body.insert(
                        "thinking".to_string(),
                        serde_json::json!({ "type": "adaptive", "display": "summarized" }),
                    );
                    // 'on' (and 'adaptive') leaves output_config unset; everything
                    // else threads the effort through.
                    if effort != "on" && effort != "adaptive" {
                        body.insert(
                            "output_config".to_string(),
                            serde_json::json!({ "effort": effort }),
                        );
                    }
                }
            }
            ThinkingMode::Budget => {
                // Opus 4.5 and earlier: `thinking: { type: 'enabled', budget_tokens: N }`
                // optionally paired with `output_config: { effort }` when the
                // model supports it. `off` disables thinking outright.
                if effort == "off" {
                    body.insert(
                        "thinking".to_string(),
                        serde_json::json!({ "type": "disabled" }),
                    );
                } else {
                    let budget = budget_tokens_for_effort(&effort);
                    let thinking = match budget {
                        Some(n) => serde_json::json!({ "type": "enabled", "budget_tokens": n }),
                        None => serde_json::json!({ "type": "enabled" }),
                    };
                    body.insert("thinking".to_string(), thinking);

                    // Mirror TS: emit `output_config.effort` for the named efforts
                    // when the model supports it (Opus 4.5+ does). 'on' / 'adaptive'
                    // intentionally omit output_config.
                    let named_effort = matches!(
                        effort.as_str(),
                        "low" | "medium" | "high" | "xhigh" | "max"
                    );
                    if named_effort {
                        body.insert(
                            "output_config".to_string(),
                            serde_json::json!({ "effort": effort }),
                        );
                    }
                }
            }
        }
    }

    // system prompt
    if let Some(sys) = system_prompt {
        if !sys.is_empty() {
            body.insert(
                "system".to_string(),
                serde_json::json!([{ "type": "text", "text": sys, "cache_control": { "type": "ephemeral" } }]),
            );
        }
    }

    // messages
    let msgs: Vec<serde_json::Value> = messages.iter().map(|m| message_to_anthropic(m)).collect();
    body.insert("messages".to_string(), serde_json::Value::Array(msgs));

    // tools
    if let Some(tools_list) = tools {
        if !tools_list.is_empty() {
            let anthropic_tools: Vec<serde_json::Value> = tools_list
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.parameters.as_deref().and_then(|p| serde_json::from_str(p).ok()).unwrap_or(serde_json::json!({}))
                    })
                })
                .collect();
            body.insert("tools".to_string(), serde_json::Value::Array(anthropic_tools));
        }
    }

    serde_json::to_string(&serde_json::Value::Object(body))
        .map_err(|e| ProviderError::Serialization(e.to_string()))
}

/// Convert a Message to an Anthropic API message param.
fn message_to_anthropic(msg: &Message) -> serde_json::Value {
    let role = &msg.role;
    let content: Vec<serde_json::Value> = msg
        .content
        .iter()
        .map(|part| content_part_to_anthropic(part))
        .collect();

    let mut obj = serde_json::Map::new();
    obj.insert("role".to_string(), serde_json::Value::String(role.clone()));

    // Tool calls
    if !msg.tool_calls.is_empty() {
        let tool_calls: Vec<serde_json::Value> = msg
            .tool_calls
            .iter()
            .map(|tc| {
                let input: serde_json::Value = tc
                    .arguments
                    .as_deref()
                    .and_then(|a| serde_json::from_str(a).ok())
                    .unwrap_or(serde_json::json!({}));
                serde_json::json!({
                    "type": "tool_use",
                    "id": tc.id,
                    "name": tc.name,
                    "input": input
                })
            })
            .collect();
        // For assistant messages with tool calls, content is the tool_use blocks
        obj.insert("content".to_string(), serde_json::Value::Array(tool_calls));
    } else if role == "tool" {
        // Tool result messages
        let tool_call_id = msg.tool_call_id.as_deref().unwrap_or("");
        let blocks: Vec<serde_json::Value> = msg
            .content
            .iter()
            .map(|part| {
                let text = part.text.as_deref().unwrap_or("");
                serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": [{ "type": "text", "text": text }]
                })
            })
            .collect();
        obj.insert("content".to_string(), serde_json::Value::Array(blocks));
    } else {
        obj.insert("content".to_string(), serde_json::Value::Array(content));
    }

    serde_json::Value::Object(obj)
}

/// Convert a ContentPart to an Anthropic content block.
fn content_part_to_anthropic(part: &ContentPart) -> serde_json::Value {
    match part.part_type.as_str() {
        "text" => {
            let text = part.text.as_deref().unwrap_or("");
            serde_json::json!({ "type": "text", "text": text })
        }
        "think" => {
            let think = part.think.as_deref().unwrap_or("");
            if let Some(encrypted) = &part.encrypted {
                serde_json::json!({
                    "type": "thinking",
                    "thinking": think,
                    "signature": encrypted
                })
            } else {
                serde_json::json!({
                    "type": "thinking",
                    "thinking": think
                })
            }
        }
        "image_url" => {
            let url = part.image_url.as_ref().map(|i| &i.url).cloned().unwrap_or_default();
            serde_json::json!({
                "type": "image",
                "source": { "type": "url", "url": url }
            })
        }
        _ => {
            serde_json::json!({ "type": "text", "text": "" })
        }
    }
}

/// Process a single SSE data payload (JSON string).
pub fn process_sse_data(
    data: &str,
    content_parts: &mut Vec<StreamedMessagePart>,
    msg_id: &mut Option<String>,
    finish_reason: &mut Option<String>,
    usage: &mut TokenUsage,
) {
    let value: serde_json::Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return,
    };

    let event_type = value["type"].as_str().unwrap_or("").to_string();

    match event_type.as_str() {
        "message_start" => {
            if let Some(msg) = value["message"].as_object() {
                if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
                    *msg_id = Some(id.to_string());
                }
                if let Some(u) = msg.get("usage").and_then(|v| v.as_object()) {
                    usage.input_other = u.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                    if let Some(cache_read) = u.get("cache_read_input_tokens").and_then(|v| v.as_i64()) {
                        usage.input_cache_read = cache_read;
                    }
                    if let Some(cache_creation) = u.get("cache_creation_input_tokens").and_then(|v| v.as_i64()) {
                        usage.input_cache_creation = cache_creation;
                    }
                }
            }
        }
        "content_block_start" => {
            let block = &value["content_block"];
            let block_type = block["type"].as_str().unwrap_or("");
            match block_type {
                "text" => {
                    let text = block["text"].as_str().unwrap_or("").to_string();
                    content_parts.push(StreamedMessagePart::text(text));
                }
                "thinking" => {
                    let think = block["thinking"].as_str().unwrap_or("").to_string();
                    content_parts.push(StreamedMessagePart::think(think, None));
                }
                "tool_use" => {
                    let id = block["id"].as_str().unwrap_or("").to_string();
                    let name = block["name"].as_str().unwrap_or("").to_string();
                    let input = block["input"].to_string();
                    content_parts.push(StreamedMessagePart::tool_call(id, name, input));
                }
                _ => {}
            }
        }
        "content_block_delta" => {
            let delta = &value["delta"];
            let delta_type = delta["type"].as_str().unwrap_or("");
            let index = value["index"].as_i64().unwrap_or(0) as i32;
            match delta_type {
                "text_delta" => {
                    let text = delta["text"].as_str().unwrap_or("").to_string();
                    content_parts.push(StreamedMessagePart::text(text));
                }
                "thinking_delta" => {
                    let think = delta["thinking"].as_str().unwrap_or("").to_string();
                    content_parts.push(StreamedMessagePart::think(think, None));
                }
                "input_json_delta" => {
                    let partial = delta["partial_json"].as_str().unwrap_or("").to_string();
                    content_parts.push(StreamedMessagePart::tool_call_part(partial, index));
                }
                "signature_delta" => {
                    let signature = delta["signature"].as_str().unwrap_or("").to_string();
                    content_parts.push(StreamedMessagePart::think(String::new(), Some(signature)));
                }
                _ => {}
            }
        }
        "message_delta" => {
            if let Some(delta) = value["delta"].as_object() {
                if let Some(reason) = delta["stop_reason"].as_str() {
                    *finish_reason = Some(reason.to_string());
                }
            }
            if let Some(u) = value["usage"].as_object() {
                if let Some(output) = u["output_tokens"].as_i64() {
                    usage.output = output;
                }
            }
        }
        "message_stop" => {
            // No-op: stream is complete
        }
        "ping" => {
            // No-op: keep-alive
        }
        _ => {
            // Unknown event type - try to parse as error
            if let Some(error) = value["error"].as_object() {
                eprintln!("SSE error: {:?}", error);
            }
        }
    }
}

/// Send a chat request to the Anthropic Messages API and return streamed results.
///
/// This is a napi-exported function callable from JS.
#[napi]
pub async fn anthropic_chat(
    api_key: String,
    model: String,
    messages: Vec<Message>,
    system_prompt: Option<String>,
    tools: Option<Vec<crate::tool::Tool>>,
    max_tokens: Option<i32>,
    thinking_effort: Option<String>,
    base_url: Option<String>,
) -> napi::Result<StreamedMessage> {
    let url = format!(
        "{}/messages",
        base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
    );

    let body = build_anthropic_request(
        &model,
        &crate::merge_user_messages::merge_consecutive_user_messages(messages),
        system_prompt.as_deref(),
        tools.as_deref(),
        max_tokens,
        thinking_effort.as_deref(),
    )
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let mut extra_headers = HashMap::new();
    extra_headers.insert(
        "anthropic-version".to_string(),
        ANTHROPIC_VERSION.to_string(),
    );
    // Adaptive-mode models (Opus 5 / Sonnet 5 / Opus 4.6+ / Fable 5 / Mythos 5)
    // drop the interleaved-thinking beta header per TS `withThinking` logic.
    if resolve_thinking_mode(&model) != ThinkingMode::Adaptive {
        extra_headers.insert(
            "anthropic-beta".to_string(),
            "interleaved-thinking-2025-05-14".to_string(),
        );
    }

    // Use the shared HTTP client (connection pooling, HTTP/1.1)
    let client = HttpClient::shared();
    let response = client
        .post_json_stream(&url, &api_key, &body, Some(&extra_headers))
        .await
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    // Read x-trace-id from response headers (Kimi/KFC trace identifier)
    let trace_id = response
        .headers()
        .get("x-trace-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let status = response.status();
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "unknown error".to_string());
        return Err(napi::Error::from_reason(format!(
            "Anthropic API error ({}): {}",
            status.as_u16(),
            error_text
        )));
    }

    // Read the entire response as text
    let mut full_body = String::new();
    {
        use futures_util::StreamExt;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| napi::Error::from_reason(e.to_string()))?;
            full_body.push_str(&String::from_utf8_lossy(&chunk));
        }
    }

    // Parse SSE events from the full body
    let mut content_parts: Vec<StreamedMessagePart> = vec![];
    let mut usage = TokenUsage {
        input_other: 0,
        output: 0,
        input_cache_read: 0,
        input_cache_creation: 0,
    };
    let mut msg_id: Option<String> = None;
    let mut finish_reason: Option<String> = None;
    let mut current_event_data = String::new();
    let mut in_event = false;

    for line in full_body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            // Empty line = end of SSE event; process the accumulated data
            if in_event && !current_event_data.is_empty() {
                process_sse_data(
                    &current_event_data,
                    &mut content_parts,
                    &mut msg_id,
                    &mut finish_reason,
                    &mut usage,
                );
                current_event_data.clear();
                in_event = false;
            }
            continue;
        }

        if trimmed.starts_with("event: ") {
            in_event = true;
            continue;
        }

        if trimmed.starts_with("data: ") {
            in_event = true;
            current_event_data.push_str(&trimmed[6..]);
            continue;
        }
    }

    // Process any remaining data
    if in_event && !current_event_data.is_empty() {
        process_sse_data(
            &current_event_data,
            &mut content_parts,
            &mut msg_id,
            &mut finish_reason,
            &mut usage,
        );
    }

    // Collect usage from the last message_start event
    // (simplified: in production, parse from the message_delta event)

    Ok(StreamedMessage {
        id: msg_id,
        content: content_parts,
        usage,
        finish_reason: finish_reason.clone(),
        raw_finish_reason: finish_reason,
        trace_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_sse(body: &str) -> (Vec<StreamedMessagePart>, TokenUsage, Option<String>, Option<String>) {
        let mut content_parts = vec![];
        let mut usage = TokenUsage::new();
        let mut msg_id = None;
        let mut finish_reason = None;
        let mut current_event_data = String::new();
        let mut in_event = false;

        for line in body.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                if in_event && !current_event_data.is_empty() {
                    process_sse_data(&current_event_data, &mut content_parts, &mut msg_id, &mut finish_reason, &mut usage);
                    current_event_data.clear();
                    in_event = false;
                }
                continue;
            }
            if trimmed.starts_with("event: ") {
                in_event = true;
                continue;
            }
            if trimmed.starts_with("data: ") {
                in_event = true;
                current_event_data.push_str(&trimmed[6..]);
                continue;
            }
        }
        if in_event && !current_event_data.is_empty() {
            process_sse_data(&current_event_data, &mut content_parts, &mut msg_id, &mut finish_reason, &mut usage);
        }
        (content_parts, usage, msg_id, finish_reason)
    }

    #[test]
    fn test_message_start() {
        let sse = "\
event: message_start
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_123\",\"usage\":{\"input_tokens\":10,\"output_tokens\":0,\"cache_creation_input_tokens\":5,\"cache_read_input_tokens\":3}}}

event: message_stop
data: {\"type\":\"message_stop\"}";
        let (parts, usage, msg_id, fr) = parse_sse(sse);
        assert_eq!(msg_id, Some("msg_123".into()));
        assert_eq!(usage.input_other, 10);
        assert_eq!(usage.input_cache_creation, 5);
        assert_eq!(usage.input_cache_read, 3);
        assert!(parts.is_empty());
        assert!(fr.is_none());
    }

    #[test]
    fn test_text_stream() {
        let sse = "\
event: message_start
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_t\",\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}

event: content_block_start
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"Hello\"}}

event: content_block_delta
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}

event: content_block_stop
data: {\"type\":\"content_block_stop\",\"index\":0}

event: message_delta
data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2},\"delta\":{\"stop_reason\":\"end_turn\"}}

event: message_stop
data: {\"type\":\"message_stop\"}";
        let (parts, usage, _id, fr) = parse_sse(sse);
        assert_eq!(fr, Some("end_turn".into()));
        assert_eq!(usage.output, 2);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].text.as_deref(), Some("Hello"));
        assert_eq!(parts[1].text.as_deref(), Some(" world"));
    }

    #[test]
    fn test_thinking_stream() {
        let sse = "\
event: message_start
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_t2\",\"usage\":{\"input_tokens\":5,\"output_tokens\":0}}}

event: content_block_start
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}

event: content_block_delta
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Let me think\"}}

event: content_block_stop
data: {\"type\":\"content_block_stop\",\"index\":0}

event: content_block_start
data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}

event: content_block_delta
data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Answer: 42\"}}

event: message_delta
data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":10},\"delta\":{\"stop_reason\":\"end_turn\"}}

event: message_stop
data: {\"type\":\"message_stop\"}";
        let (parts, _usage, _id, fr) = parse_sse(sse);
        assert_eq!(fr, Some("end_turn".into()));
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0].part_type, "think");
        assert_eq!(parts[0].think.as_deref(), Some(""));
        assert_eq!(parts[1].think.as_deref(), Some("Let me think"));
        assert_eq!(parts[2].part_type, "text");
        assert_eq!(parts[2].text.as_deref(), Some(""));
        assert_eq!(parts[3].text.as_deref(), Some("Answer: 42"));
    }

    #[test]
    fn test_tool_use() {
        let sse = "\
event: message_start
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_tool\",\"usage\":{\"input_tokens\":10,\"output_tokens\":0}}}

event: content_block_start
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_1\",\"name\":\"get_weather\",\"input\":{\"loc\":\"NYC\"}}}

event: message_delta
data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":3},\"delta\":{\"stop_reason\":\"tool_use\"}}

event: message_stop
data: {\"type\":\"message_stop\"}";
        let (parts, _usage, _id, fr) = parse_sse(sse);
        assert_eq!(fr, Some("tool_use".into()));
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "function");
        assert_eq!(parts[0].id.as_deref(), Some("tu_1"));
        assert_eq!(parts[0].name.as_deref(), Some("get_weather"));
    }

    #[test]
    fn test_signature_delta() {
        let sse = "\
event: message_start
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sig\",\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}

event: content_block_start
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"reasoning\"}}

event: content_block_delta
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig_abc\"}}

event: message_delta
data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":5},\"delta\":{\"stop_reason\":\"end_turn\"}}

event: message_stop
data: {\"type\":\"message_stop\"}";
        let (parts, _usage, _id, fr) = parse_sse(sse);
        assert_eq!(fr, Some("end_turn".into()));
        assert_eq!(parts[0].part_type, "think");
        assert_eq!(parts[0].think.as_deref(), Some("reasoning"));
        assert_eq!(parts[1].part_type, "think");
        assert_eq!(parts[1].think.as_deref(), Some(""));
        assert_eq!(parts[1].encrypted.as_deref(), Some("sig_abc"));
    }

    #[test]
    fn test_empty_sse() {
        let (parts, usage, msg_id, fr) = parse_sse("");
        assert!(parts.is_empty());
        assert!(msg_id.is_none());
        assert!(fr.is_none());
        assert_eq!(usage.input_other, 0);
    }

    #[test]
    fn test_budget_tokens_for_effort() {
        assert_eq!(budget_tokens_for_effort("low"), Some(1024));
        assert_eq!(budget_tokens_for_effort("medium"), Some(4096));
        assert_eq!(budget_tokens_for_effort("high"), Some(32_000));
        assert_eq!(budget_tokens_for_effort("on"), Some(32_000));
        assert_eq!(budget_tokens_for_effort("off"), None);
        assert_eq!(budget_tokens_for_effort("unknown"), None);
        // Case-insensitive
        assert_eq!(budget_tokens_for_effort("LOW"), Some(1024));
        assert_eq!(budget_tokens_for_effort("Medium"), Some(4096));
    }

    #[test]
    fn test_resolve_thinking_mode() {
        // Adaptive-mode families
        for m in [
            "claude-opus-5-20260101",
            "claude-opus-4-6",
            "claude-opus-4-7",
            "claude-opus-4-8",
            "claude-sonnet-5",
            "claude-sonnet-4-6",
            "claude-fable-5",
            "claude-mythos-5",
        ] {
            assert_eq!(resolve_thinking_mode(m), ThinkingMode::Adaptive, "{}", m);
        }
        // Budget-mode families
        for m in [
            "claude-opus-4-5",
            "claude-opus-4-20250514",
            "claude-3-7-sonnet",
            "claude-3-5-sonnet",
            "claude-haiku-4-5",
        ] {
            assert_eq!(resolve_thinking_mode(m), ThinkingMode::Budget, "{}", m);
        }
    }

    #[test]
    fn test_build_request_opus5_adaptive_effort() {
        // Opus 5 (adaptive mode) — emits `thinking.adaptive` + `output_config.effort`.
        let body = build_anthropic_request(
            "claude-opus-5-20260101",
            &[],
            None,
            None,
            None,
            Some("high"),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            parsed["thinking"],
            serde_json::json!({ "type": "adaptive", "display": "summarized" })
        );
        assert_eq!(parsed["output_config"]["effort"], "high");
    }

    #[test]
    fn test_build_request_opus5_adaptive_off() {
        // 'off' on an adaptive-mode model disables thinking outright.
        let body = build_anthropic_request(
            "claude-opus-5-20260101",
            &[],
            None,
            None,
            None,
            Some("off"),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["thinking"]["type"], "disabled");
        assert!(parsed.get("output_config").is_none());
    }

    #[test]
    fn test_build_request_opus45_budget_tokens() {
        // Opus 4.5 (budget mode) — emits `thinking.enabled` with budget_tokens.
        let body = build_anthropic_request(
            "claude-opus-4-5",
            &[],
            None,
            None,
            None,
            Some("medium"),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            parsed["thinking"],
            serde_json::json!({ "type": "enabled", "budget_tokens": 4096 })
        );
        assert_eq!(parsed["output_config"]["effort"], "medium");
    }

    #[test]
    fn test_build_request_opus45_budget_off() {
        // 'off' on a budget-mode model also disables thinking.
        let body = build_anthropic_request(
            "claude-opus-4-5",
            &[],
            None,
            None,
            None,
            Some("off"),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["thinking"]["type"], "disabled");
    }

    #[test]
    fn test_build_request_no_thinking_effort_omits_thinking() {
        // When the caller doesn't pass thinking_effort, the request carries
        // neither thinking nor output_config — preserves prior behavior.
        let body = build_anthropic_request(
            "claude-opus-5-20260101",
            &[],
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(parsed.get("thinking").is_none());
        assert!(parsed.get("output_config").is_none());
    }

    #[test]
    fn test_build_request_sonnet5_adaptive_xhigh() {
        // Sonnet 5 supports xhigh (new effort tier introduced for adaptive models).
        let body = build_anthropic_request(
            "claude-sonnet-5",
            &[],
            None,
            None,
            None,
            Some("xhigh"),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["thinking"]["type"], "adaptive");
        assert_eq!(parsed["output_config"]["effort"], "xhigh");
    }
}