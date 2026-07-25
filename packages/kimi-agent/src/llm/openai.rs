//! OpenAI Chat Completions request projection and response parsing.
//!
//! Pure functions only — no HTTP. The transport layer (reqwest) and credential
//! wiring are added in a later step; these functions own the provider-specific
//! JSON shape and are unit-tested against fixtures.
#![allow(dead_code)]

use serde_json::{json, Value};

use crate::llm::wire::WireMessage;
use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::{LLMChatResponse, ToolCall, ToolInfo};

/// Build an OpenAI Chat Completions request body.
///
/// - Assistant tool calls become `tool_calls[]` with `function.arguments`
///   serialized to a JSON **string** (OpenAI's encoding).
/// - Tool results become `{ role: "tool", tool_call_id, content }`.
/// - An assistant turn that only calls tools sends `content: null`.
pub fn build_request(model: &str, messages: &[WireMessage], tools: &[ToolInfo]) -> Value {
    let msgs: Vec<Value> = messages.iter().map(project_message).collect();

    let mut req = json!({
        "model": model,
        "messages": msgs,
        "stream": false,
    });

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

    // An assistant turn that only calls tools carries a null content per the
    // OpenAI schema; everything else carries its (possibly empty) text.
    if m.role == "assistant" && !m.tool_calls.is_empty() && m.content.is_empty() {
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
}
