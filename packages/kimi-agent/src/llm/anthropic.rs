//! Anthropic Messages request projection and response parsing.
//!
//! Pure functions only — no HTTP. Anthropic differs from OpenAI in three ways
//! this layer handles: the system prompt is a top-level `system` field (not a
//! message), assistant tool calls are `tool_use` content blocks whose `input`
//! is a JSON **object** (not a string), and tool results are `tool_result`
//! blocks carried on a `user` message.
#![allow(dead_code)]

use serde_json::{json, Value};

use crate::llm::wire::WireMessage;
use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::{ContentBlock, LLMChatResponse, ToolCall, ToolInfo};

/// Build an Anthropic Messages request body. `max_tokens` is required by the
/// API and must be supplied by the caller.
pub fn build_request(
    model: &str,
    max_tokens: u32,
    messages: &[WireMessage],
    tools: &[ToolInfo],
) -> Value {
    build_request_with_options(model, max_tokens, messages, tools, false, None, None)
}

/// Map a reasoning-effort level to an Anthropic `thinking.budget_tokens`.
/// Returns `None` for unrecognized values (treated as "no thinking").
fn budget_tokens_for_effort(effort: &str) -> Option<u32> {
    match effort {
        "low" => Some(1024),
        "medium" => Some(4096),
        "high" | "on" => Some(32_000),
        _ => None,
    }
}

/// Build an Anthropic Messages request body, optionally streaming.
///
/// When `reasoning_effort` is `Some("low"|"medium"|"high")`, the request
/// includes `thinking: { type: "enabled", budget_tokens: N }` and
/// `max_tokens` is raised above the budget if needed (Anthropic requires
/// `max_tokens > budget_tokens`).
///
/// When `session_id` is present, prompt-cache breakpoints are injected
/// (`cache_control: { type: "ephemeral" }` on the system block, the last
/// tool definition, and the last content block of the last message) and the
/// affinity key rides `metadata.user_id`. The cacheable block types mirror
/// the TS provider (`text`/`image`/`tool_use`/`tool_result`).
pub fn build_request_with_options(
    model: &str,
    max_tokens: u32,
    messages: &[WireMessage],
    tools: &[ToolInfo],
    stream: bool,
    reasoning_effort: Option<&str>,
    session_id: Option<&str>,
) -> Value {
    let mut system = String::new();
    let mut msgs: Vec<Value> = Vec::new();

    for m in messages {
        match m.role.as_str() {
            "system" => {
                if !system.is_empty() {
                    system.push_str("\n\n");
                }
                system.push_str(&m.content);
            }
            "assistant" => {
                let mut blocks: Vec<Value> = Vec::new();
                if !m.content.is_empty() {
                    blocks.push(json!({ "type": "text", "text": m.content }));
                }
                for tc in &m.tool_calls {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        // Anthropic expects the arguments as a JSON object.
                        "input": tc.arguments,
                    }));
                }
                msgs.push(json!({ "role": "assistant", "content": blocks }));
            }
            "tool" => {
                // A tool result is a `tool_result` block on a user message.
                let tool_use_id = m.tool_call_id.clone().unwrap_or_default();
                msgs.push(json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": m.content,
                    }]
                }));
            }
            _ => {
                // user (and any unknown role) -> user content blocks.
                // Multimodal blocks win over the plain text content.
                let content: Vec<Value> = if m.blocks.is_empty() {
                    vec![json!({ "type": "text", "text": m.content })]
                } else {
                    m.blocks.iter().map(project_block).collect()
                };
                msgs.push(json!({ "role": "user", "content": content }));
            }
        }
    }

    // Sliding cache breakpoint on the last content block of the last message
    // (after role projection, so it lands on the final tool_result in a merged
    // tool-result user turn). Only cacheable block types take the marker.
    if let Some(last) = msgs.last_mut() {
        if let Some(content) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
            if let Some(last_block) = content.last_mut() {
                if block_type_is_cacheable(last_block) {
                    last_block["cache_control"] = json!({ "type": "ephemeral" });
                }
            }
        }
    }

    // When thinking is enabled the effective max_tokens must exceed the
    // thinking budget (Anthropic rejects max_tokens <= budget_tokens).
    let thinking_budget = reasoning_effort.and_then(budget_tokens_for_effort);
    let effective_max = match thinking_budget {
        Some(budget) if max_tokens <= budget => budget + 4096,
        _ => max_tokens,
    };

    let mut req = json!({
        "model": model,
        "max_tokens": effective_max,
        "messages": msgs,
    });
    if stream {
        req["stream"] = json!(true);
    }
    if let Some(budget) = thinking_budget {
        req["thinking"] = json!({ "type": "enabled", "budget_tokens": budget });
    }

    if !system.is_empty() {
        // A block-array `system` (rather than a bare string) is what allows
        // the cache breakpoint on the system prefix.
        let mut sys = json!({ "type": "text", "text": system });
        sys["cache_control"] = json!({ "type": "ephemeral" });
        req["system"] = json!([sys]);
    }
    if !tools.is_empty() {
        let tool_defs: Vec<Value> = tools
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let mut def = json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                });
                // Stable cache breakpoint: the last tool definition.
                if i == tools.len() - 1 {
                    def["cache_control"] = json!({ "type": "ephemeral" });
                }
                def
            })
            .collect();
        req["tools"] = json!(tool_defs);
    }

    if let Some(sid) = session_id {
        if !sid.is_empty() {
            req["metadata"] = json!({ "user_id": sid });
        }
    }

    req
}

/// Whether a projected Anthropic content block may carry a cache breakpoint.
fn block_type_is_cacheable(block: &Value) -> bool {
    match block.get("type").and_then(|t| t.as_str()) {
        Some("text") | Some("image") | Some("tool_use") | Some("tool_result") => true,
        _ => false,
    }
}

/// Project a single content block to the Anthropic content-block form.
fn project_block(b: &ContentBlock) -> Value {
    match b {
        ContentBlock::Text { text } => json!({ "type": "text", "text": text }),
        ContentBlock::Image { media_type, data } => json!({
            "type": "image",
            "source": { "type": "base64", "media_type": media_type, "data": data },
        }),
        ContentBlock::ImageUrl { url } => json!({
            "type": "image",
            "source": { "type": "url", "url": url },
        }),
    }
}

/// Parse an Anthropic Messages (non-streaming) response.
pub fn parse_response(v: &Value) -> Result<LLMChatResponse, String> {
    let content = v
        .get("content")
        .and_then(|c| c.as_array())
        .ok_or("anthropic response missing content array")?;

    let mut text = String::new();
    let mut tool_calls = Vec::new();
    for block in content {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                    text.push_str(t);
                }
            }
            Some("tool_use") => {
                let id = block.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let name = block.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let arguments = block.get("input").cloned().unwrap_or_else(|| json!({}));
                tool_calls.push(ToolCall { id, name, arguments });
            }
            _ => {}
        }
    }

    let finish_reason = v
        .get("stop_reason")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());

    let input_tokens = v
        .get("usage")
        .and_then(|u| u.get("input_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let output_tokens = v
        .get("usage")
        .and_then(|u| u.get("output_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;

    Ok(LLMChatResponse {
        content: text,
        tool_calls,
        finish_reason,
        usage: TokenUsage {
            input_tokens,
            output_tokens,
            total_tokens: input_tokens + output_tokens,
        },
    })
}

// ── Streaming (SSE) accumulation ───────────────────────────────────────

/// A content block being accumulated across stream events, keyed by index.
#[derive(Debug, Clone)]
enum PartialBlock {
    Text,
    ToolUse { id: String, name: String, input_json: String },
}

/// Accumulates Anthropic Messages stream events into a final
/// [`LLMChatResponse`]. Feed each SSE `data:` JSON payload (each carries a
/// `type` discriminator) to [`feed`]; text deltas are returned so the
/// caller can forward them to the host.
#[derive(Debug, Default)]
pub struct StreamAccumulator {
    content: String,
    blocks: Vec<Option<PartialBlock>>,
    finish_reason: Option<String>,
    usage: TokenUsage,
    /// Cache-hit input tokens from the `message_start` usage block
    /// (`cache_read_input_tokens`). Reported separately because the wire
    /// `TokenUsage` carries no cache fields.
    pub cache_read: u32,
    /// Cache-write input tokens (`cache_creation_input_tokens`).
    pub cache_creation: u32,
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    fn slot(&mut self, index: usize) -> &mut Option<PartialBlock> {
        while self.blocks.len() <= index {
            self.blocks.push(None);
        }
        &mut self.blocks[index]
    }

    /// Feed one stream event. Returns the delta contained in the event, if
    /// any — text deltas become assistant content, thinking deltas are
    /// surfaced separately and never enter the transcript.
    pub fn feed(&mut self, v: &Value) -> Option<crate::llm::StreamDelta> {
        use crate::llm::StreamDelta;
        let event_type = v.get("type").and_then(|t| t.as_str())?;
        match event_type {
            "message_start" => {
                if let Some(usage) = v.get("message").and_then(|m| m.get("usage")) {
                    self.usage.input_tokens = usage
                        .get("input_tokens")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0) as u32;
                    // Anthropic reports cache hit/creation counts on the
                    // message_start usage block.
                    self.cache_read = usage
                        .get("cache_read_input_tokens")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0) as u32;
                    self.cache_creation = usage
                        .get("cache_creation_input_tokens")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0) as u32;
                }
                None
            }
            "content_block_start" => {
                let index = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                let block = v.get("content_block")?;
                let partial = match block.get("type").and_then(|t| t.as_str()) {
                    Some("tool_use") => PartialBlock::ToolUse {
                        id: block.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        name: block.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        input_json: String::new(),
                    },
                    _ => PartialBlock::Text,
                };
                *self.slot(index) = Some(partial);
                None
            }
            "content_block_delta" => {
                let index = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                let delta = v.get("delta")?;
                match delta.get("type").and_then(|t| t.as_str()) {
                    Some("text_delta") => {
                        let text = delta.get("text").and_then(|x| x.as_str())?;
                        if text.is_empty() {
                            return None;
                        }
                        self.content.push_str(text);
                        Some(StreamDelta::Text(text.to_string()))
                    }
                    // Anthropic streams reasoning as `thinking_delta`
                    // blocks. Forwarded to the host's `thinking.delta` UI
                    // stream; kept out of `content`.
                    Some("thinking_delta") => {
                        let thinking = delta.get("thinking").and_then(|x| x.as_str())?;
                        if thinking.is_empty() {
                            return None;
                        }
                        Some(StreamDelta::Thinking(thinking.to_string()))
                    }
                    Some("input_json_delta") => {
                        if let Some(Some(PartialBlock::ToolUse { id, name, input_json })) =
                            self.blocks.get_mut(index)
                        {
                            if let Some(fragment) =
                                delta.get("partial_json").and_then(|x| x.as_str())
                            {
                                input_json.push_str(fragment);
                            }
                            // Surface the accumulated partial arguments so a
                            // host can preview the tool call while forming.
                            if !name.is_empty() {
                                return Some(StreamDelta::ToolCall {
                                    id: id.clone(),
                                    name: name.clone(),
                                    args: input_json.clone(),
                                });
                            }
                        }
                        None
                    }
                    _ => None,
                }
            }
            "message_delta" => {
                if let Some(sr) = v
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(|s| s.as_str())
                {
                    self.finish_reason = Some(sr.to_string());
                }
                if let Some(out) = v
                    .get("usage")
                    .and_then(|u| u.get("output_tokens"))
                    .and_then(|x| x.as_u64())
                {
                    self.usage.output_tokens = out as u32;
                }
                None
            }
            // ping / content_block_stop / message_stop carry nothing we need.
            _ => None,
        }
    }

    /// Finalize the accumulated stream into a response.
    pub fn finish(mut self) -> LLMChatResponse {
        self.usage.total_tokens = self.usage.input_tokens + self.usage.output_tokens;
        let tool_calls = self
            .blocks
            .into_iter()
            .flatten()
            .filter_map(|b| match b {
                PartialBlock::ToolUse { id, name, input_json } if !name.is_empty() => {
                    Some(ToolCall {
                        id,
                        name,
                        arguments: serde_json::from_str(&input_json)
                            .unwrap_or_else(|_| json!({})),
                    })
                }
                _ => None,
            })
            .collect();
        LLMChatResponse {
            content: self.content,
            tool_calls,
            finish_reason: self.finish_reason,
            usage: self.usage,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_request_hoists_system_and_encodes_tool_use_as_object() {
        let messages = vec![
            WireMessage::text("system", "sys-a"),
            WireMessage::text("system", "sys-b"),
            WireMessage::text("user", "hi"),
            WireMessage::assistant_tool_calls(
                "let me look",
                vec![ToolCall {
                    id: "tu_1".into(),
                    name: "Read".into(),
                    arguments: json!({ "path": "a.txt" }),
                }],
            ),
            WireMessage::tool_result("tu_1", "file body"),
        ];
        let tools = vec![ToolInfo {
            name: "Read".into(),
            description: "read a file".into(),
            input_schema: json!({ "type": "object" }),
        }];

        let req = build_request("claude-x", 4096, &messages, &tools);

        assert_eq!(req["model"], "claude-x");
        assert_eq!(req["max_tokens"], 4096);
        // System messages are concatenated into the top-level `system` block
        // array carrying the cache breakpoint.
        let sys = req["system"].as_array().unwrap();
        assert_eq!(sys[0]["type"], "text");
        assert_eq!(sys[0]["text"], "sys-a\n\nsys-b");
        assert_eq!(sys[0]["cache_control"], json!({ "type": "ephemeral" }));

        let msgs = req["messages"].as_array().unwrap();
        // user, assistant, tool-result-as-user
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"][0]["type"], "text");

        // Assistant: text block + tool_use block with an OBJECT input.
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"][0]["type"], "text");
        let tool_use = &msgs[1]["content"][1];
        assert_eq!(tool_use["type"], "tool_use");
        assert_eq!(tool_use["id"], "tu_1");
        assert_eq!(tool_use["name"], "Read");
        assert_eq!(tool_use["input"], json!({ "path": "a.txt" }));

        // Tool result becomes a user message with a tool_result block.
        assert_eq!(msgs[2]["role"], "user");
        let tr = &msgs[2]["content"][0];
        assert_eq!(tr["type"], "tool_result");
        assert_eq!(tr["tool_use_id"], "tu_1");
        assert_eq!(tr["content"], "file body");

        // Tools use Anthropic's `input_schema` key.
        assert_eq!(req["tools"][0]["name"], "Read");
        assert_eq!(req["tools"][0]["input_schema"], json!({ "type": "object" }));
    }

    #[test]
    fn build_request_without_system_omits_field() {
        let req = build_request("m", 100, &[WireMessage::text("user", "x")], &[]);
        assert!(req.get("system").is_none());
        assert!(req.get("tools").is_none());
    }

    #[test]
    fn parse_response_extracts_tool_use_and_usage() {
        let v = json!({
            "content": [
                { "type": "text", "text": "sure" },
                { "type": "tool_use", "id": "tu_9", "name": "Grep", "input": { "q": "foo" } }
            ],
            "stop_reason": "tool_use",
            "usage": { "input_tokens": 20, "output_tokens": 8 }
        });

        let parsed = parse_response(&v).unwrap();
        assert_eq!(parsed.finish_reason.as_deref(), Some("tool_use"));
        assert_eq!(parsed.tool_calls.len(), 1);
        assert_eq!(parsed.tool_calls[0].id, "tu_9");
        assert_eq!(parsed.tool_calls[0].name, "Grep");
        // Anthropic input is already an object.
        assert_eq!(parsed.tool_calls[0].arguments, json!({ "q": "foo" }));
        assert_eq!(parsed.usage.input_tokens, 20);
        assert_eq!(parsed.usage.output_tokens, 8);
        assert_eq!(parsed.usage.total_tokens, 28);
    }

    #[test]
    fn parse_response_plain_text_has_no_tool_calls() {
        let v = json!({
            "content": [{ "type": "text", "text": "hello" }],
            "stop_reason": "end_turn",
            "usage": { "input_tokens": 3, "output_tokens": 2 }
        });
        let parsed = parse_response(&v).unwrap();
        assert!(parsed.tool_calls.is_empty());
        assert_eq!(parsed.finish_reason.as_deref(), Some("end_turn"));
    }

    #[test]
    fn parse_response_errors_on_missing_content() {
        assert!(parse_response(&json!({})).is_err());
    }

    #[test]
    fn parse_response_extracts_text_content() {
        let v = json!({
            "content": [
                { "type": "text", "text": "sure, " },
                { "type": "text", "text": "here" }
            ],
            "stop_reason": "end_turn",
            "usage": { "input_tokens": 1, "output_tokens": 1 }
        });
        let parsed = parse_response(&v).unwrap();
        assert_eq!(parsed.content, "sure, here");
    }

    #[test]
    fn build_request_streaming_sets_stream_flag() {
        let req = build_request_with_options("m", 100, &[WireMessage::text("user", "x")], &[], true, None, None);
        assert_eq!(req["stream"], true);
    }

    #[test]
    fn build_request_projects_image_blocks() {
        use crate::turn_loop::types::ContentBlock;
        let msg = WireMessage::with_blocks(
            "user",
            vec![
                ContentBlock::Text { text: "look".into() },
                ContentBlock::Image { media_type: "image/jpeg".into(), data: "BBBB".into() },
            ],
        );
        let req = build_request("m", 100, &[msg], &[]);
        let content = req["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "image/jpeg");
        assert_eq!(content[1]["source"]["data"], "BBBB");
    }

    #[test]
    fn stream_accumulator_collects_text_tool_use_and_usage() {
        let mut acc = StreamAccumulator::new();

        acc.feed(&json!({ "type": "message_start", "message": { "usage": { "input_tokens": 25 } } }));
        acc.feed(&json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text" } }));
        let d1 = acc.feed(&json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Hi " } }));
        assert_eq!(d1, Some(crate::llm::StreamDelta::Text("Hi ".into())));
        let d2 = acc.feed(&json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "there" } }));
        assert_eq!(d2, Some(crate::llm::StreamDelta::Text("there".into())));
        acc.feed(&json!({ "type": "content_block_stop", "index": 0 }));

        acc.feed(&json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "tu_1", "name": "Read" } }));
        // Each input_json_delta surfaces the accumulated partial arguments.
        let d3 = acc.feed(&json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"path\":" } }));
        match d3 {
            Some(crate::llm::StreamDelta::ToolCall { id, name, args }) => {
                assert_eq!(id, "tu_1");
                assert_eq!(name, "Read");
                assert_eq!(args, "{\"path\":");
            }
            other => panic!("expected ToolCall delta, got {other:?}"),
        }
        let d4 = acc.feed(&json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "\"a.txt\"}" } }));
        match d4 {
            Some(crate::llm::StreamDelta::ToolCall { id, name, args }) => {
                assert_eq!(id, "tu_1");
                assert_eq!(name, "Read");
                assert_eq!(args, "{\"path\":\"a.txt\"}");
            }
            other => panic!("expected ToolCall delta, got {other:?}"),
        }
        acc.feed(&json!({ "type": "content_block_stop", "index": 1 }));

        acc.feed(&json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 9 } }));
        acc.feed(&json!({ "type": "message_stop" }));

        let resp = acc.finish();
        assert_eq!(resp.content, "Hi there");
        assert_eq!(resp.finish_reason.as_deref(), Some("tool_use"));
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].id, "tu_1");
        assert_eq!(resp.tool_calls[0].name, "Read");
        assert_eq!(resp.tool_calls[0].arguments, json!({ "path": "a.txt" }));
        assert_eq!(resp.usage.input_tokens, 25);
        assert_eq!(resp.usage.output_tokens, 9);
        assert_eq!(resp.usage.total_tokens, 34);
    }

    #[test]
    fn stream_accumulator_surfaces_thinking_delta() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking" } }));
        let d = acc.feed(&json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "thinking_delta", "thinking": "pondering" }
        }));
        assert_eq!(
            d,
            Some(crate::llm::StreamDelta::Thinking("pondering".into()))
        );
        // Thinking never enters the transcript content.
        let resp = acc.finish();
        assert_eq!(resp.content, "");
    }

    #[test]
    fn reasoning_effort_emits_thinking_block() {
        let req = build_request_with_options(
            "claude-x",
            64_000,
            &[WireMessage::text("user", "think hard")],
            &[],
            true,
            Some("high"),
            None,
        );
        assert_eq!(req["thinking"]["type"], "enabled");
        assert_eq!(req["thinking"]["budget_tokens"], 32_000);
        // max_tokens (64k) > budget (32k), so it stays unchanged.
        assert_eq!(req["max_tokens"], 64_000);
    }

    #[test]
    fn reasoning_effort_raises_max_tokens_when_below_budget() {
        // max_tokens = 8192 is below the "high" budget of 32k → raised.
        let req = build_request_with_options(
            "claude-x",
            8192,
            &[WireMessage::text("user", "x")],
            &[],
            false,
            Some("high"),
            None,
        );
        assert_eq!(req["thinking"]["budget_tokens"], 32_000);
        assert_eq!(req["max_tokens"], 32_000 + 4096);
    }

    #[test]
    fn reasoning_effort_low_and_medium_map_correctly() {
        let low = build_request_with_options(
            "m", 64_000, &[WireMessage::text("user", "x")], &[], false, Some("low"), None,
        );
        assert_eq!(low["thinking"]["budget_tokens"], 1024);

        let med = build_request_with_options(
            "m", 64_000, &[WireMessage::text("user", "x")], &[], false, Some("medium"), None,
        );
        assert_eq!(med["thinking"]["budget_tokens"], 4096);
    }

    #[test]
    fn no_reasoning_effort_omits_thinking() {
        let req = build_request_with_options(
            "m", 4096, &[WireMessage::text("user", "x")], &[], false, None, None,
        );
        assert!(req.get("thinking").is_none());
    }

    #[test]
    fn session_id_stamps_metadata_user_id_and_tool_cache_breakpoint() {
        let tools = vec![
            ToolInfo {
                name: "Read".into(),
                description: "read".into(),
                input_schema: json!({ "type": "object" }),
            },
            ToolInfo {
                name: "Bash".into(),
                description: "run".into(),
                input_schema: json!({ "type": "object" }),
            },
        ];
        let req = build_request_with_options(
            "claude-x",
            4096,
            &[WireMessage::text("user", "hi")],
            &tools,
            false,
            None,
            Some("sess-7"),
        );
        assert_eq!(req["metadata"]["user_id"], "sess-7");
        // Last tool definition carries the cache breakpoint; the first does not.
        assert!(req["tools"][0].get("cache_control").is_none());
        assert_eq!(req["tools"][1]["cache_control"], json!({ "type": "ephemeral" }));
    }

    #[test]
    fn empty_session_id_omits_metadata() {
        let req = build_request_with_options(
            "m", 100, &[WireMessage::text("user", "x")], &[], false, None, Some(""),
        );
        assert!(req.get("metadata").is_none());
    }

    #[test]
    fn last_message_block_gets_cache_breakpoint() {
        let req = build_request_with_options(
            "m",
            100,
            &[WireMessage::tool_result("tu_1", "file body")],
            &[],
            false,
            None,
            None,
        );
        let last_msg = req["messages"].as_array().unwrap().last().unwrap();
        let blocks = last_msg["content"].as_array().unwrap();
        assert_eq!(blocks.last().unwrap()["cache_control"], json!({ "type": "ephemeral" }));
    }

    #[test]
    fn parse_response_reads_cache_tokens() {
        // Non-streaming parse carries no cache fields on the wire TokenUsage;
        // cache accounting flows only through the stream accumulator. This
        // asserts the plain parse still works with cache usage present.
        let v = json!({
            "content": [{ "type": "text", "text": "hi" }],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 5,
                "cache_read_input_tokens": 90,
                "cache_creation_input_tokens": 10
            }
        });
        let parsed = parse_response(&v).unwrap();
        assert_eq!(parsed.usage.input_tokens, 100);
        assert_eq!(parsed.usage.output_tokens, 5);
    }

    #[test]
    fn stream_accumulator_reads_cache_tokens() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({
            "type": "message_start",
            "message": {
                "usage": {
                    "input_tokens": 100,
                    "cache_read_input_tokens": 90,
                    "cache_creation_input_tokens": 10
                }
            }
        }));
        let cache_read = acc.cache_read;
        let cache_creation = acc.cache_creation;
        let resp = acc.finish();
        assert_eq!(cache_read, 90);
        assert_eq!(cache_creation, 10);
        assert_eq!(resp.usage.input_tokens, 100);
    }
}
