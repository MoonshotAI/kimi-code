//! Google Generative Language (Gemini) request projection and stream parsing.
//!
//! Pure functions only — no HTTP. Gemini differs from OpenAI/Anthropic in the
//! ways this layer handles: roles are `user`/`model` only (system prompts go
//! to a top-level `systemInstruction`), assistant tool calls are
//! `functionCall` parts whose `args` is a JSON object, tool results are
//! `functionResponse` parts matched **by tool name** (not id) on a `user`
//! turn, and consecutive `user` turns must be merged because the API requires
//! strictly alternating roles. Mirrors `kosong/src/providers/google-genai.ts`.
#![allow(dead_code)]

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::llm::wire::WireMessage;
use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::{ContentBlock, LLMChatResponse, ToolCall, ToolInfo};

/// Build a Gemini `generateContent` / `streamGenerateContent` request body.
///
/// The model is not part of the body (it lives in the URL); streaming is
/// selected by the endpoint (`:streamGenerateContent?alt=sse`), so there is
/// no `stream` flag either. `max_tokens` maps to
/// `generationConfig.maxOutputTokens` when present.
///
/// When `reasoning_effort` is `Some("low"|"medium"|"high")`, the request
/// includes `generationConfig.thinkingConfig.thinkingBudget` mapped from the
/// effort level (low=1024, medium=4096, high=16384).
pub fn build_request(
    messages: &[WireMessage],
    tools: &[ToolInfo],
    max_tokens: Option<u32>,
    reasoning_effort: Option<&str>,
) -> Value {
    let mut system = String::new();
    let mut contents: Vec<Value> = Vec::new();
    // functionResponse parts are matched by tool NAME; recover it from the
    // assistant tool_calls seen earlier in the history.
    let mut tool_name_by_id: HashMap<String, String> = HashMap::new();

    for m in messages {
        match m.role.as_str() {
            "system" => {
                if !system.is_empty() {
                    system.push_str("\n\n");
                }
                system.push_str(&m.content);
            }
            "assistant" => {
                let mut parts: Vec<Value> = Vec::new();
                if !m.content.is_empty() {
                    parts.push(json!({ "text": m.content }));
                }
                for tc in &m.tool_calls {
                    tool_name_by_id.insert(tc.id.clone(), tc.name.clone());
                    parts.push(json!({
                        "functionCall": { "name": tc.name, "args": tc.arguments }
                    }));
                }
                contents.push(json!({ "role": "model", "parts": parts }));
            }
            "tool" => {
                let id = m.tool_call_id.clone().unwrap_or_default();
                // Fall back to the raw id when the call is not in this
                // history slice — better a name mismatch error upstream
                // than dropping the result silently.
                let name = tool_name_by_id.get(&id).cloned().unwrap_or(id);
                push_user_content(
                    &mut contents,
                    vec![json!({
                        "functionResponse": {
                            "name": name,
                            "response": { "output": m.content },
                        }
                    })],
                );
            }
            _ => {
                // user (and any unknown role) -> user parts. Multimodal
                // blocks win over the plain text content.
                let parts: Vec<Value> = if m.blocks.is_empty() {
                    vec![json!({ "text": m.content })]
                } else {
                    m.blocks.iter().map(project_block).collect()
                };
                push_user_content(&mut contents, parts);
            }
        }
    }

    let mut req = json!({ "contents": contents });

    if !system.is_empty() {
        req["systemInstruction"] = json!({ "parts": [{ "text": system }] });
    }
    if !tools.is_empty() {
        // One functionDeclarations wrapper per tool, mirroring the TS side.
        let tool_defs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "functionDeclarations": [{
                        "name": t.name,
                        "description": t.description,
                        "parametersJsonSchema": t.input_schema,
                    }]
                })
            })
            .collect();
        req["tools"] = json!(tool_defs);
    }
    if let Some(max) = max_tokens {
        req["generationConfig"] = json!({ "maxOutputTokens": max });
    }

    // Thinking / reasoning effort → generationConfig.thinkingConfig.
    if let Some(effort) = reasoning_effort {
        let budget: Option<u32> = match effort {
            "low" => Some(1024),
            "medium" => Some(4096),
            "high" | "on" => Some(16_384),
            "off" => Some(0),
            _ => None,
        };
        if let Some(b) = budget {
            let gc = req
                .as_object_mut()
                .unwrap()
                .entry("generationConfig")
                .or_insert_with(|| json!({}));
            gc["thinkingConfig"] = json!({ "thinkingBudget": b });
        }
    }

    req
}

/// Append a `user` content, merging into the previous one when it is also a
/// `user` turn — Gemini requires strictly alternating user/model roles
/// (consecutive user turns arise from compaction and tool results).
fn push_user_content(contents: &mut Vec<Value>, parts: Vec<Value>) {
    if let Some(last) = contents.last_mut() {
        if last.get("role").and_then(|r| r.as_str()) == Some("user") {
            if let Some(existing) = last.get_mut("parts").and_then(|p| p.as_array_mut()) {
                existing.extend(parts);
                return;
            }
        }
    }
    contents.push(json!({ "role": "user", "parts": parts }));
}

/// Project a single content block to the Gemini part form.
fn project_block(b: &ContentBlock) -> Value {
    match b {
        ContentBlock::Text { text } => json!({ "text": text }),
        ContentBlock::Image { media_type, data } => json!({
            "inlineData": { "mimeType": media_type, "data": data },
        }),
        ContentBlock::ImageUrl { url } => json!({
            "fileData": { "fileUri": url },
        }),
    }
}

// ── Streaming (SSE) accumulation ───────────────────────────────────────

/// Accumulates Gemini `streamGenerateContent?alt=sse` chunks (each a
/// `GenerateContentResponse`) into a final [`LLMChatResponse`]. Feed each SSE
/// `data:` JSON payload to [`feed`]; text deltas are returned so the caller
/// can forward them to the host.
///
/// Unlike Anthropic, Gemini streams whole `functionCall` parts (no argument
/// deltas) and provides no tool-call id — ids are synthesized as
/// `{name}_{index}_{entropy}` so they stay unique across the session.
#[derive(Debug, Default)]
pub struct StreamAccumulator {
    content: String,
    tool_calls: Vec<ToolCall>,
    finish_reason: Option<String>,
    usage: TokenUsage,
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one stream chunk. Returns the text delta contained in it, if any.
    pub fn feed(&mut self, v: &Value) -> Option<String> {
        if let Some(usage) = v.get("usageMetadata") {
            if let Some(n) = usage.get("promptTokenCount").and_then(|x| x.as_u64()) {
                self.usage.input_tokens = n as u32;
            }
            if let Some(n) = usage.get("candidatesTokenCount").and_then(|x| x.as_u64()) {
                self.usage.output_tokens = n as u32;
            }
        }

        let candidates = v.get("candidates").and_then(|c| c.as_array())?;
        let mut delta = String::new();

        for candidate in candidates {
            // Early chunks carry FINISH_REASON_UNSPECIFIED while the model
            // is still generating; treat those as "not yet known".
            if let Some(reason) = candidate.get("finishReason").and_then(|r| r.as_str()) {
                if !reason.is_empty() && reason != "FINISH_REASON_UNSPECIFIED" {
                    self.finish_reason = Some(reason.to_string());
                }
            }

            let Some(parts) = candidate.pointer("/content/parts").and_then(|p| p.as_array())
            else {
                continue;
            };
            for part in parts {
                // Thought parts have no channel in LLMChatResponse; skip
                // them (the Anthropic accumulator does the same).
                if part.get("thought").and_then(|t| t.as_bool()) == Some(true) {
                    continue;
                }
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        self.content.push_str(text);
                        delta.push_str(text);
                    }
                } else if let Some(fc) = part
                    .get("functionCall")
                    .or_else(|| part.get("function_call"))
                    .and_then(|f| f.as_object())
                {
                    let Some(name) = fc.get("name").and_then(|n| n.as_str()) else {
                        continue;
                    };
                    let index = self.tool_calls.len();
                    let entropy = fastrand::u32(..);
                    self.tool_calls.push(ToolCall {
                        id: format!("{name}_{index}_{entropy:08x}"),
                        name: name.to_string(),
                        arguments: fc.get("args").cloned().unwrap_or_else(|| json!({})),
                    });
                }
            }
        }

        if delta.is_empty() { None } else { Some(delta) }
    }

    /// Finalize the accumulated stream into a response.
    pub fn finish(mut self) -> LLMChatResponse {
        self.usage.total_tokens = self.usage.input_tokens + self.usage.output_tokens;
        LLMChatResponse {
            content: self.content,
            tool_calls: self.tool_calls,
            finish_reason: self.finish_reason,
            usage: self.usage,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_request_hoists_system_and_encodes_function_calls() {
        let messages = vec![
            WireMessage::text("system", "sys-a"),
            WireMessage::text("system", "sys-b"),
            WireMessage::text("user", "hi"),
            WireMessage::assistant_tool_calls(
                "let me look",
                vec![ToolCall {
                    id: "tc_1".into(),
                    name: "Read".into(),
                    arguments: json!({ "path": "a.txt" }),
                }],
            ),
            WireMessage::tool_result("tc_1", "file body"),
        ];
        let tools = vec![ToolInfo {
            name: "Read".into(),
            description: "read a file".into(),
            input_schema: json!({ "type": "object" }),
        }];

        let req = build_request(&messages, &tools, Some(4096), None);

        // System messages are concatenated into systemInstruction.
        assert_eq!(
            req["systemInstruction"]["parts"][0]["text"],
            "sys-a\n\nsys-b"
        );
        assert_eq!(req["generationConfig"]["maxOutputTokens"], 4096);

        let contents = req["contents"].as_array().unwrap();
        // user, model, tool-result-as-user
        assert_eq!(contents.len(), 3);
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[0]["parts"][0]["text"], "hi");

        // Assistant: text part + functionCall part with an OBJECT args.
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[1]["parts"][0]["text"], "let me look");
        let fc = &contents[1]["parts"][1]["functionCall"];
        assert_eq!(fc["name"], "Read");
        assert_eq!(fc["args"], json!({ "path": "a.txt" }));

        // Tool result: functionResponse matched by NAME, not id.
        assert_eq!(contents[2]["role"], "user");
        let fr = &contents[2]["parts"][0]["functionResponse"];
        assert_eq!(fr["name"], "Read");
        assert_eq!(fr["response"]["output"], "file body");

        // Tools use Gemini's functionDeclarations wrapper, one per tool.
        assert_eq!(req["tools"][0]["functionDeclarations"][0]["name"], "Read");
        assert_eq!(
            req["tools"][0]["functionDeclarations"][0]["parametersJsonSchema"],
            json!({ "type": "object" })
        );
    }

    #[test]
    fn build_request_without_system_tools_or_max_tokens_omits_fields() {
        let req = build_request(&[WireMessage::text("user", "x")], &[], None, None);
        assert!(req.get("systemInstruction").is_none());
        assert!(req.get("tools").is_none());
        assert!(req.get("generationConfig").is_none());
    }

    #[test]
    fn consecutive_user_turns_are_merged() {
        // user prompt directly after a tool result must merge into one user
        // turn (Gemini requires strictly alternating roles).
        let messages = vec![
            WireMessage::assistant_tool_calls(
                "",
                vec![ToolCall {
                    id: "tc_1".into(),
                    name: "Grep".into(),
                    arguments: json!({}),
                }],
            ),
            WireMessage::tool_result("tc_1", "matches"),
            WireMessage::text("user", "now summarize"),
        ];
        let req = build_request(&messages, &[], None, None);
        let contents = req["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 2);
        assert_eq!(contents[1]["role"], "user");
        let parts = contents[1]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert!(parts[0].get("functionResponse").is_some());
        assert_eq!(parts[1]["text"], "now summarize");
    }

    #[test]
    fn unknown_tool_call_id_falls_back_to_raw_id() {
        let req = build_request(&[WireMessage::tool_result("orphan_id", "out")], &[], None, None);
        let fr = &req["contents"][0]["parts"][0]["functionResponse"];
        assert_eq!(fr["name"], "orphan_id");
    }

    #[test]
    fn build_request_projects_image_blocks() {
        let msg = WireMessage::with_blocks(
            "user",
            vec![
                ContentBlock::Text { text: "look".into() },
                ContentBlock::Image { media_type: "image/jpeg".into(), data: "BBBB".into() },
                ContentBlock::ImageUrl { url: "https://x/y.png".into() },
            ],
        );
        let req = build_request(&[msg], &[], None, None);
        let parts = req["contents"][0]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0]["text"], "look");
        assert_eq!(parts[1]["inlineData"]["mimeType"], "image/jpeg");
        assert_eq!(parts[1]["inlineData"]["data"], "BBBB");
        assert_eq!(parts[2]["fileData"]["fileUri"], "https://x/y.png");
    }

    #[test]
    fn stream_accumulator_collects_text_function_calls_and_usage() {
        let mut acc = StreamAccumulator::new();

        let d1 = acc.feed(&json!({
            "candidates": [{ "content": { "parts": [{ "text": "Hi " }] } }]
        }));
        assert_eq!(d1.as_deref(), Some("Hi "));
        let d2 = acc.feed(&json!({
            "candidates": [{ "content": { "parts": [{ "text": "there" }] } }]
        }));
        assert_eq!(d2.as_deref(), Some("there"));

        let d3 = acc.feed(&json!({
            "candidates": [{
                "content": { "parts": [
                    { "functionCall": { "name": "Read", "args": { "path": "a.txt" } } }
                ] },
                "finishReason": "STOP"
            }],
            "usageMetadata": { "promptTokenCount": 25, "candidatesTokenCount": 9 }
        }));
        assert_eq!(d3, None);

        let resp = acc.finish();
        assert_eq!(resp.content, "Hi there");
        assert_eq!(resp.finish_reason.as_deref(), Some("STOP"));
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].name, "Read");
        assert!(resp.tool_calls[0].id.starts_with("Read_0_"));
        assert_eq!(resp.tool_calls[0].arguments, json!({ "path": "a.txt" }));
        assert_eq!(resp.usage.input_tokens, 25);
        assert_eq!(resp.usage.output_tokens, 9);
        assert_eq!(resp.usage.total_tokens, 34);
    }

    #[test]
    fn stream_accumulator_skips_thought_parts_and_unspecified_finish() {
        let mut acc = StreamAccumulator::new();
        let d = acc.feed(&json!({
            "candidates": [{
                "content": { "parts": [{ "thought": true, "text": "pondering" }] },
                "finishReason": "FINISH_REASON_UNSPECIFIED"
            }]
        }));
        assert_eq!(d, None);
        let resp = acc.finish();
        assert_eq!(resp.content, "");
        assert_eq!(resp.finish_reason, None);
    }

    #[test]
    fn stream_accumulator_synthesizes_unique_tool_call_ids() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({
            "candidates": [{ "content": { "parts": [
                { "functionCall": { "name": "A", "args": {} } },
                { "functionCall": { "name": "A", "args": {} } }
            ] } }]
        }));
        let resp = acc.finish();
        assert_eq!(resp.tool_calls.len(), 2);
        assert_ne!(resp.tool_calls[0].id, resp.tool_calls[1].id);
    }

    #[test]
    fn reasoning_effort_emits_thinking_config() {
        let req = build_request(
            &[WireMessage::text("user", "think")],
            &[],
            Some(8192),
            Some("high"),
        );
        let gc = &req["generationConfig"];
        assert_eq!(gc["maxOutputTokens"], 8192);
        assert_eq!(gc["thinkingConfig"]["thinkingBudget"], 16_384);
    }

    #[test]
    fn reasoning_effort_low_medium_map_correctly() {
        let low = build_request(&[WireMessage::text("user", "x")], &[], None, Some("low"));
        assert_eq!(low["generationConfig"]["thinkingConfig"]["thinkingBudget"], 1024);

        let med = build_request(&[WireMessage::text("user", "x")], &[], None, Some("medium"));
        assert_eq!(med["generationConfig"]["thinkingConfig"]["thinkingBudget"], 4096);
    }

    #[test]
    fn reasoning_effort_off_sets_zero_budget() {
        let req = build_request(&[WireMessage::text("user", "x")], &[], None, Some("off"));
        assert_eq!(req["generationConfig"]["thinkingConfig"]["thinkingBudget"], 0);
    }

    #[test]
    fn no_reasoning_effort_omits_thinking_config() {
        let req = build_request(&[WireMessage::text("user", "x")], &[], Some(4096), None);
        assert!(req["generationConfig"].get("thinkingConfig").is_none());
    }
}
