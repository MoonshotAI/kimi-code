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
use crate::turn_loop::types::{LLMChatResponse, ToolCall, ToolInfo};

/// Build an Anthropic Messages request body. `max_tokens` is required by the
/// API and must be supplied by the caller.
pub fn build_request(
    model: &str,
    max_tokens: u32,
    messages: &[WireMessage],
    tools: &[ToolInfo],
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
                // user (and any unknown role) -> a user text block.
                msgs.push(json!({
                    "role": "user",
                    "content": [{ "type": "text", "text": m.content }]
                }));
            }
        }
    }

    let mut req = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": msgs,
    });

    if !system.is_empty() {
        req["system"] = json!(system);
    }
    if !tools.is_empty() {
        let tool_defs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                })
            })
            .collect();
        req["tools"] = json!(tool_defs);
    }

    req
}

/// Parse an Anthropic Messages (non-streaming) response.
pub fn parse_response(v: &Value) -> Result<LLMChatResponse, String> {
    let content = v
        .get("content")
        .and_then(|c| c.as_array())
        .ok_or("anthropic response missing content array")?;

    let mut tool_calls = Vec::new();
    for block in content {
        if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
            let id = block.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let name = block.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let arguments = block.get("input").cloned().unwrap_or_else(|| json!({}));
            tool_calls.push(ToolCall { id, name, arguments });
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
        tool_calls,
        finish_reason,
        usage: TokenUsage {
            input_tokens,
            output_tokens,
            total_tokens: input_tokens + output_tokens,
        },
    })
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
        // System messages are concatenated into the top-level `system` field.
        assert_eq!(req["system"], "sys-a\n\nsys-b");

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
}
