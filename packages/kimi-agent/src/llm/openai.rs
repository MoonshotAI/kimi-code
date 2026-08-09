//! OpenAI Chat Completions request projection and response parsing.
//!
//! Pure functions only — no HTTP. The transport layer (reqwest) and credential
//! wiring are added in a later step; these functions own the provider-specific
//! JSON shape and are unit-tested against fixtures.
#![allow(dead_code)]

use serde_json::{json, Value};

use crate::llm::wire::WireMessage;
use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::{ContentBlock, LLMChatResponse, ToolCall, ToolInfo};

/// Build an OpenAI Chat Completions request body.
///
/// - Assistant tool calls become `tool_calls[]` with `function.arguments`
///   serialized to a JSON **string** (OpenAI's encoding).
/// - Tool results become `{ role: "tool", tool_call_id, content }`.
/// - An assistant turn that only calls tools sends `content: null`.
pub fn build_request(model: &str, messages: &[WireMessage], tools: &[ToolInfo]) -> Value {
    build_request_with_options(model, messages, tools, false)
}

/// Prompt-cache namespace shared by every session (Moonshot/OpenAI
/// `prompt_cache_key`). The system prompt and tool table are byte-stable
/// across sessions, so a single global key lets the provider's prefix cache
/// be shared model-wide: every session re-uses the same prefill for
/// system + tools. A per-session key would partition identical prefixes into
/// separate buckets and force each session to re-prefill the shared prefix.
const GLOBAL_CACHE_KEY: &str = "kimi-code";

/// Build an OpenAI Chat Completions request body, optionally streaming.
/// Streaming requests set `stream_options.include_usage` so the final
/// chunk carries token usage.
///
/// The request always carries a stable `prompt_cache_key`, scoping the
/// provider's prefix cache to the global namespace (system prompt + tool
/// tables are session-independent).
pub fn build_request_with_options(
    model: &str,
    messages: &[WireMessage],
    tools: &[ToolInfo],
    stream: bool,
) -> Value {
    let msgs: Vec<Value> = messages.iter().map(project_message).collect();

    let mut req = json!({
        "model": model,
        "messages": msgs,
        "stream": stream,
    });
    if stream {
        req["stream_options"] = json!({ "include_usage": true });
    }
    req["prompt_cache_key"] = json!(GLOBAL_CACHE_KEY);

    if !tools.is_empty() {
        let tool_defs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    }
                })
            })
            .collect();
        req["tools"] = json!(tool_defs);
    }

    req
}

fn project_message(m: &WireMessage) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("role".into(), json!(m.role));

    // Multimodal blocks project to the content-parts array form. An
    // assistant turn that only calls tools carries a null content per the
    // OpenAI schema; everything else carries its (possibly empty) text.
    if !m.blocks.is_empty() {
        let parts: Vec<Value> = m.blocks.iter().map(project_block).collect();
        obj.insert("content".into(), json!(parts));
    } else if m.role == "assistant" && !m.tool_calls.is_empty() && m.content.is_empty() {
        obj.insert("content".into(), Value::Null);
    } else {
        obj.insert("content".into(), json!(m.content));
    }

    if !m.tool_calls.is_empty() {
        let tcs: Vec<Value> = m
            .tool_calls
            .iter()
            .map(|tc| {
                json!({
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        // OpenAI expects arguments as a JSON-encoded string.
                        "arguments": serde_json::to_string(&tc.arguments)
                            .unwrap_or_else(|_| "{}".to_string()),
                    }
                })
            })
            .collect();
        obj.insert("tool_calls".into(), json!(tcs));
    }

    if let Some(ref tcid) = m.tool_call_id {
        obj.insert("tool_call_id".into(), json!(tcid));
    }

    Value::Object(obj)
}

/// Project a single content block to the OpenAI content-parts form.
fn project_block(b: &ContentBlock) -> Value {
    match b {
        ContentBlock::Text { text } => json!({ "type": "text", "text": text }),
        ContentBlock::Image { media_type, data } => json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{media_type};base64,{data}") },
        }),
        ContentBlock::ImageUrl { url } => json!({
            "type": "image_url",
            "image_url": { "url": url },
        }),
    }
}

/// Parse an OpenAI Chat Completions (non-streaming) response.
pub fn parse_response(v: &Value) -> Result<LLMChatResponse, String> {
    let choice = v
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .ok_or("openai response missing choices[0]")?;
    let message = choice
        .get("message")
        .ok_or("openai response missing choices[0].message")?;

    let finish_reason = choice
        .get("finish_reason")
        .and_then(|f| f.as_str())
        .map(|s| s.to_string());

    let content = message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    let mut tool_calls = Vec::new();
    if let Some(tcs) = message.get("tool_calls").and_then(|t| t.as_array()) {
        for tc in tcs {
            let id = tc.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let func = tc
                .get("function")
                .ok_or("openai tool_call missing function")?;
            let name = func
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            // arguments is a JSON string; parse it back to a value (tolerating
            // a malformed/partial string by falling back to an empty object).
            let args_str = func.get("arguments").and_then(|x| x.as_str()).unwrap_or("{}");
            let arguments = serde_json::from_str(args_str).unwrap_or_else(|_| json!({}));
            tool_calls.push(ToolCall { id, name, arguments });
        }
    }

    Ok(LLMChatResponse {
        content,
        tool_calls,
        finish_reason,
        usage: parse_usage(v.get("usage")),
    })
}

fn parse_usage(usage: Option<&Value>) -> TokenUsage {
    let input_tokens = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let output_tokens = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let total_tokens = usage
        .and_then(|u| u.get("total_tokens"))
        .and_then(|x| x.as_u64())
        .map(|t| t as u32)
        .unwrap_or(input_tokens + output_tokens);
    TokenUsage { input_tokens, output_tokens, total_tokens }
}

/// Cache-hit input tokens reported by the provider: Moonshot top-level
/// `cached_tokens`, or OpenAI `prompt_tokens_details.cached_tokens`. `0`
/// when the provider does not report cache hits.
fn cached_tokens(usage: Option<&Value>) -> u32 {
    usage
        .and_then(|u| u.get("cached_tokens"))
        .and_then(|x| x.as_u64())
        .or_else(|| {
            usage
                .and_then(|u| u.get("prompt_tokens_details"))
                .and_then(|d| d.get("cached_tokens"))
                .and_then(|x| x.as_u64())
        })
        .unwrap_or(0) as u32
}

// ── Streaming (SSE) accumulation ───────────────────────────────────────

/// A tool call being accumulated across stream chunks, keyed by its
/// provider-assigned `index`.
#[derive(Debug, Default, Clone)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// Accumulates OpenAI Chat Completions stream chunks into a final
/// [`LLMChatResponse`]. Feed each SSE `data:` JSON payload to [`feed`];
/// text deltas are returned so the caller can forward them to the host.
#[derive(Debug, Default)]
pub struct StreamAccumulator {
    content: String,
    tool_calls: Vec<PartialToolCall>,
    finish_reason: Option<String>,
    usage: TokenUsage,
    /// Cache-hit input tokens from the final usage chunk (`cached_tokens` /
    /// `prompt_tokens_details.cached_tokens`). Reported separately because
    /// the wire `TokenUsage` carries no cache fields.
    pub cache_read: u32,
    /// Cache-write input tokens (not reported by OpenAI-compatible streams).
    pub cache_creation: u32,
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one stream chunk. Returns the delta contained in the chunk, if
    /// any — text deltas become assistant content, reasoning deltas are
    /// surfaced separately and never enter the transcript.
    pub fn feed(&mut self, v: &Value) -> Option<crate::llm::StreamDelta> {
        use crate::llm::StreamDelta;
        // The final usage-only chunk has an empty `choices` array.
        if let Some(usage) = v.get("usage") {
            if !usage.is_null() {
                self.usage = parse_usage(Some(usage));
                self.cache_read = cached_tokens(Some(usage));
            }
        }
        let choice = v.get("choices").and_then(|c| c.as_array()).and_then(|a| a.first())?;
        if let Some(fr) = choice.get("finish_reason").and_then(|f| f.as_str()) {
            self.finish_reason = Some(fr.to_string());
        }
        let delta = choice.get("delta")?;

        if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
            // Process every tool call in the chunk (parallel calls share a
            // chunk); surface the last one that advanced so a host can
            // preview accumulated arguments while they form.
            let mut advanced_slot: Option<(String, String, String)> = None;
            for tc in tcs {
                let index = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                while self.tool_calls.len() <= index {
                    self.tool_calls.push(PartialToolCall::default());
                }
                let slot = &mut self.tool_calls[index];
                let mut advanced = false;
                if let Some(id) = tc.get("id").and_then(|x| x.as_str()) {
                    slot.id.push_str(id);
                    advanced = true;
                }
                if let Some(func) = tc.get("function") {
                    if let Some(name) = func.get("name").and_then(|x| x.as_str()) {
                        slot.name.push_str(name);
                        advanced = true;
                    }
                    if let Some(args) = func.get("arguments").and_then(|x| x.as_str()) {
                        slot.arguments.push_str(args);
                        advanced = true;
                    }
                }
                if advanced && !slot.name.is_empty() {
                    advanced_slot = Some((slot.id.clone(), slot.name.clone(), slot.arguments.clone()));
                }
            }
            if let Some((id, name, args)) = advanced_slot {
                return Some(StreamDelta::ToolCall { id, name, args });
            }
        }

        // Reasoning models stream chain-of-thought as `reasoning_content`.
        if let Some(thinking) = delta.get("reasoning_content").and_then(|c| c.as_str()) {
            if !thinking.is_empty() {
                return Some(StreamDelta::Thinking(thinking.to_string()));
            }
        }

        let text = delta.get("content").and_then(|c| c.as_str())?;
        if text.is_empty() {
            return None;
        }
        self.content.push_str(text);
        Some(StreamDelta::Text(text.to_string()))
    }

    /// Finalize the accumulated stream into a response.
    pub fn finish(self) -> LLMChatResponse {
        let tool_calls = self
            .tool_calls
            .into_iter()
            .filter(|tc| !tc.name.is_empty())
            .map(|tc| ToolCall {
                id: tc.id,
                name: tc.name,
                arguments: serde_json::from_str(&tc.arguments).unwrap_or_else(|_| json!({})),
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
    fn build_request_projects_roles_tools_and_stringifies_arguments() {
        let messages = vec![
            WireMessage::text("system", "sys"),
            WireMessage::text("user", "hi"),
            WireMessage::assistant_tool_calls(
                "",
                vec![ToolCall {
                    id: "call_1".into(),
                    name: "Read".into(),
                    arguments: json!({ "path": "a.txt" }),
                }],
            ),
            WireMessage::tool_result("call_1", "file body"),
        ];
        let tools = vec![ToolInfo {
            name: "Read".into(),
            description: "read a file".into(),
            input_schema: json!({ "type": "object" }),
        }];

        let req = build_request("kimi-k2", &messages, &tools);

        assert_eq!(req["model"], "kimi-k2");
        assert_eq!(req["stream"], false);
        let msgs = req["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 4);

        // Assistant with only tool calls -> content null, tool_calls present.
        let assistant = &msgs[2];
        assert!(assistant["content"].is_null());
        let tc = &assistant["tool_calls"][0];
        assert_eq!(tc["id"], "call_1");
        assert_eq!(tc["type"], "function");
        assert_eq!(tc["function"]["name"], "Read");
        // arguments must be a STRING, not an object.
        let args = tc["function"]["arguments"].as_str().unwrap();
        assert_eq!(serde_json::from_str::<Value>(args).unwrap(), json!({ "path": "a.txt" }));

        // Tool result carries tool_call_id.
        let tool_msg = &msgs[3];
        assert_eq!(tool_msg["role"], "tool");
        assert_eq!(tool_msg["tool_call_id"], "call_1");
        assert_eq!(tool_msg["content"], "file body");

        // Tools projected under {type:function, function:{...}}.
        assert_eq!(req["tools"][0]["type"], "function");
        assert_eq!(req["tools"][0]["function"]["name"], "Read");
        assert_eq!(req["tools"][0]["function"]["parameters"], json!({ "type": "object" }));
    }

    #[test]
    fn build_request_omits_tools_when_empty() {
        let req = build_request("m", &[WireMessage::text("user", "x")], &[]);
        assert!(req.get("tools").is_none());
    }

    #[test]
    fn parse_response_extracts_tool_calls_finish_and_usage() {
        let v = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_9",
                        "type": "function",
                        "function": { "name": "Grep", "arguments": "{\"q\":\"foo\"}" }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19 }
        });

        let parsed = parse_response(&v).unwrap();
        assert_eq!(parsed.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(parsed.tool_calls.len(), 1);
        assert_eq!(parsed.tool_calls[0].id, "call_9");
        assert_eq!(parsed.tool_calls[0].name, "Grep");
        assert_eq!(parsed.tool_calls[0].arguments, json!({ "q": "foo" }));
        assert_eq!(parsed.usage.input_tokens, 12);
        assert_eq!(parsed.usage.output_tokens, 7);
        assert_eq!(parsed.usage.total_tokens, 19);
    }

    #[test]
    fn parse_response_plain_text_has_no_tool_calls() {
        let v = json!({
            "choices": [{ "message": { "role": "assistant", "content": "hello" }, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 3, "completion_tokens": 2 }
        });
        let parsed = parse_response(&v).unwrap();
        assert!(parsed.tool_calls.is_empty());
        assert_eq!(parsed.finish_reason.as_deref(), Some("stop"));
        // total_tokens absent -> derived from prompt + completion.
        assert_eq!(parsed.usage.total_tokens, 5);
    }

    #[test]
    fn parse_response_errors_on_missing_choices() {
        assert!(parse_response(&json!({})).is_err());
    }

    #[test]
    fn build_request_streaming_sets_stream_options() {
        let req = build_request_with_options("m", &[WireMessage::text("user", "x")], &[], true);
        assert_eq!(req["stream"], true);
        assert_eq!(req["stream_options"]["include_usage"], true);
    }

    #[test]
    fn build_request_carries_global_prompt_cache_key() {
        // System prompt + tool tables are byte-stable across sessions, so the
        // cache key must be session-independent to share the prefix globally.
        let req = build_request_with_options("m", &[WireMessage::text("user", "x")], &[], false);
        assert_eq!(req["prompt_cache_key"], "kimi-code");

        let req = build_request("m", &[WireMessage::text("user", "x")], &[]);
        assert_eq!(req["prompt_cache_key"], "kimi-code");
    }

    #[test]
    fn parse_usage_reads_moonshot_cached_tokens() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({ "choices": [], "usage": { "prompt_tokens": 100, "completion_tokens": 5, "total_tokens": 105, "cached_tokens": 90 } }));
        assert_eq!(acc.cache_read, 90);
        assert_eq!(acc.usage.input_tokens, 100);
        assert_eq!(acc.usage.output_tokens, 5);
    }

    #[test]
    fn parse_usage_reads_openai_prompt_tokens_details() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({
            "choices": [],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 5,
                "prompt_tokens_details": { "cached_tokens": 80 }
            }
        }));
        assert_eq!(acc.cache_read, 80);
    }

    #[test]
    fn build_request_projects_image_blocks() {
        use crate::turn_loop::types::ContentBlock;
        let msg = WireMessage::with_blocks(
            "user",
            vec![
                ContentBlock::Text { text: "what is this?".into() },
                ContentBlock::Image { media_type: "image/png".into(), data: "AAAA".into() },
                ContentBlock::ImageUrl { url: "https://example.com/x.png".into() },
            ],
        );
        let req = build_request("m", &[msg], &[]);
        let content = req["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "what is this?");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,AAAA");
        assert_eq!(content[2]["image_url"]["url"], "https://example.com/x.png");
    }

    #[test]
    fn parse_response_extracts_content_text() {
        let v = json!({
            "choices": [{ "message": { "role": "assistant", "content": "hello" }, "finish_reason": "stop" }],
        });
        let parsed = parse_response(&v).unwrap();
        assert_eq!(parsed.content, "hello");
    }

    #[test]
    fn stream_accumulator_collects_text_and_tool_calls() {
        let mut acc = StreamAccumulator::new();

        // Text deltas.
        let d1 = acc.feed(&json!({ "choices": [{ "delta": { "content": "Hel" } }] }));
        assert_eq!(d1, Some(crate::llm::StreamDelta::Text("Hel".into())));
        let d2 = acc.feed(&json!({ "choices": [{ "delta": { "content": "lo" } }] }));
        assert_eq!(d2, Some(crate::llm::StreamDelta::Text("lo".into())));

        // Tool call split across chunks (arguments arrive in fragments).
        acc.feed(&json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "id": "call_1", "function": { "name": "Grep", "arguments": "{\"q\":" } }
        ] } }] }));
        acc.feed(&json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "function": { "arguments": "\"foo\"}" } }
        ] } }] }));

        // Finish + usage-only chunk.
        acc.feed(&json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }));
        acc.feed(&json!({ "choices": [], "usage": { "prompt_tokens": 7, "completion_tokens": 3 } }));

        let resp = acc.finish();
        assert_eq!(resp.content, "Hello");
        assert_eq!(resp.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].id, "call_1");
        assert_eq!(resp.tool_calls[0].name, "Grep");
        assert_eq!(resp.tool_calls[0].arguments, json!({ "q": "foo" }));
        assert_eq!(resp.usage.input_tokens, 7);
        assert_eq!(resp.usage.output_tokens, 3);
        assert_eq!(resp.usage.total_tokens, 10);
    }

    #[test]
    fn stream_accumulator_surfaces_reasoning_content() {
        let mut acc = StreamAccumulator::new();
        let d = acc.feed(&json!({
            "choices": [{ "delta": { "reasoning_content": "thinking..." } }]
        }));
        assert_eq!(
            d,
            Some(crate::llm::StreamDelta::Thinking("thinking...".into()))
        );
        // Reasoning never enters the transcript content.
        assert_eq!(acc.finish().content, "");
    }

    #[test]
    fn stream_accumulator_parallel_tool_calls_by_index() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "id": "a", "function": { "name": "Read", "arguments": "{}" } },
            { "index": 1, "id": "b", "function": { "name": "Glob", "arguments": "{}" } }
        ] } }] }));
        let resp = acc.finish();
        assert_eq!(resp.tool_calls.len(), 2);
        assert_eq!(resp.tool_calls[0].name, "Read");
        assert_eq!(resp.tool_calls[1].name, "Glob");
    }

    #[test]
    fn tool_call_deltas_surface_accumulated_partial_args() {
        let mut acc = StreamAccumulator::new();
        // First chunk: id + name arrive; args are still empty.
        let d = acc.feed(&json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "id": "call_1", "function": { "name": "Read", "arguments": "" } }
        ] } }] }));
        match d {
            Some(crate::llm::StreamDelta::ToolCall { id, name, args }) => {
                assert_eq!(id, "call_1");
                assert_eq!(name, "Read");
                assert!(args.is_empty());
            }
            other => panic!("expected ToolCall delta, got {other:?}"),
        }
        // Second chunk: argument fragment arrives; the delta carries the
        // accumulated value, not just the fragment.
        let d = acc.feed(&json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "function": { "arguments": "{\"path\":" } }
        ] } }] }));
        match d {
            Some(crate::llm::StreamDelta::ToolCall { id, name, args }) => {
                assert_eq!(id, "call_1");
                assert_eq!(name, "Read");
                assert_eq!(args, "{\"path\":" );
            }
            other => panic!("expected ToolCall delta, got {other:?}"),
        }
        // Third chunk: more args; still accumulated.
        let d = acc.feed(&json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "function": { "arguments": " \"a.txt\"}" } }
        ] } }] }));
        match d {
            Some(crate::llm::StreamDelta::ToolCall { id, name, args }) => {
                assert_eq!(id, "call_1");
                assert_eq!(name, "Read");
                assert_eq!(args, "{\"path\": \"a.txt\"}");
            }
            other => panic!("expected ToolCall delta, got {other:?}"),
        }
        // Finish yields the complete, parsed call.
        let resp = acc.finish();
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].name, "Read");
        assert_eq!(resp.tool_calls[0].arguments, json!({ "path": "a.txt" }));
    }
}
