//! OpenAI Chat Completions API adapter.
//! Mirrors `packages/kosong/src/providers/openai-legacy.ts` and `openai-common.ts`.

use crate::errors::ProviderError;
use crate::http::HttpClient;
use crate::message::*;
use napi_derive::napi;
use std::collections::HashMap;

const DEFAULT_OPENAI_URL: &str = "https://api.openai.com/v1/chat/completions";

/// Build an OpenAI Chat Completions request body.
fn build_openai_request(
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

    if let Some(mt) = max_tokens {
        body.insert(
            "max_tokens".to_string(),
            serde_json::Value::Number(serde_json::Number::from(mt as i64)),
        );
    }

    // thinking/reasoning effort
    if let Some(effort) = thinking_effort {
        let effort_lower = effort.to_lowercase();
        if effort_lower != "off" {
            let reasoning = serde_json::json!({
                "type": "reasoning",
                "effort": effort_lower
            });
            body.insert("reasoning".to_string(), reasoning);

            // Also set the reasoning_effort field for OpenAI-compatible APIs
            body.insert(
                "reasoning_effort".to_string(),
                serde_json::Value::String(effort_lower),
            );
        }
    }

    // Add stream_options for OpenAI-compatible streaming usage
    body.insert(
        "stream_options".to_string(),
        serde_json::json!({ "include_usage": true }),
    );

    // Kimi-specific: extra_body.thinking config
    if let Some(effort) = thinking_effort {
        let effort_lower = effort.to_lowercase();
        if effort_lower != "off" {
            body.insert(
                "thinking".to_string(),
                serde_json::json!({ "type": "enabled", "effort": effort_lower }),
            );
        }
    }

    // Build messages array
    let mut msgs: Vec<serde_json::Value> = Vec::new();

    // System prompt as a system message
    if let Some(sys) = system_prompt {
        if !sys.is_empty() {
            msgs.push(serde_json::json!({
                "role": "system",
                "content": sys
            }));
        }
    }

    // Convert messages
    for msg in messages {
        msgs.push(message_to_openai(msg));
    }

    body.insert("messages".to_string(), serde_json::Value::Array(msgs));

    // Tools
    if let Some(tools_list) = tools {
        if !tools_list.is_empty() {
            let openai_tools: Vec<serde_json::Value> = tools_list
                .iter()
                .map(|t| {
                    let params: serde_json::Value = t
                        .parameters
                        .as_deref()
                        .and_then(|p| serde_json::from_str(p).ok())
                        .unwrap_or(serde_json::json!({}));
                    serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": params
                        }
                    })
                })
                .collect();
            body.insert("tools".to_string(), serde_json::Value::Array(openai_tools));
        }
    }

    serde_json::to_string(&serde_json::Value::Object(body))
        .map_err(|e| ProviderError::Serialization(e.to_string()))
}

/// Convert a Message to an OpenAI API message.
fn message_to_openai(msg: &Message) -> serde_json::Value {
    let role = &msg.role;
    match role.as_str() {
        "system" => {
            let text = msg
                .content
                .iter()
                .filter_map(|p| p.text.as_deref())
                .collect::<Vec<_>>()
                .join("\n");
            serde_json::json!({ "role": "system", "content": text })
        }
        "assistant" => {
            let mut obj = serde_json::Map::new();
            obj.insert("role".to_string(), serde_json::Value::String("assistant".to_string()));

            // Content parts
            let content_parts: Vec<serde_json::Value> = msg
                .content
                .iter()
                .map(|p| match p.part_type.as_str() {
                    "text" => serde_json::json!({ "type": "text", "text": p.text }),
                    "think" => {
                        let text = p.think.as_deref().unwrap_or("");
                        serde_json::json!({ "type": "text", "text": format!("{}", text) })
                    }
                    "image_url" => {
                        let url = p.image_url.as_ref().map(|i| &i.url).cloned().unwrap_or_default();
                        serde_json::json!({ "type": "image_url", "image_url": { "url": url } })
                    }
                    _ => serde_json::json!({ "type": "text", "text": "" }),
                })
                .collect();

            if content_parts.len() == 1 {
                if let Some(text) = content_parts[0].get("text") {
                    obj.insert("content".to_string(), text.clone());
                } else {
                    obj.insert("content".to_string(), serde_json::Value::Array(content_parts));
                }
            } else {
                obj.insert("content".to_string(), serde_json::Value::Array(content_parts));
            }

            // Tool calls
            if !msg.tool_calls.is_empty() {
                let tool_calls: Vec<serde_json::Value> = msg
                    .tool_calls
                    .iter()
                    .map(|tc| {
                        serde_json::json!({
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": tc.arguments.as_deref().unwrap_or("{}")
                            }
                        })
                    })
                    .collect();
                obj.insert("tool_calls".to_string(), serde_json::Value::Array(tool_calls));
            }

            // Reasoning content
            let think_parts: Vec<&str> = msg
                .content
                .iter()
                .filter_map(|p| {
                    if p.part_type == "think" {
                        p.think.as_deref()
                    } else {
                        None
                    }
                })
                .collect();
            if !think_parts.is_empty() {
                obj.insert(
                    "reasoning_content".to_string(),
                    serde_json::Value::String(think_parts.join("")),
                );
            }

            serde_json::Value::Object(obj)
        }
        "tool" => {
            let tool_call_id = msg.tool_call_id.as_deref().unwrap_or("");
            let text = msg
                .content
                .iter()
                .filter_map(|p| p.text.as_deref())
                .collect::<Vec<_>>()
                .join("\n");
            serde_json::json!({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": text
            })
        }
        _ => {
            // user
            let content_parts: Vec<serde_json::Value> = msg
                .content
                .iter()
                .map(|p| match p.part_type.as_str() {
                    "text" => serde_json::json!({ "type": "text", "text": p.text }),
                    "image_url" => {
                        let url = p.image_url.as_ref().map(|i| &i.url).cloned().unwrap_or_default();
                        serde_json::json!({ "type": "image_url", "image_url": { "url": url } })
                    }
                    _ => serde_json::json!({ "type": "text", "text": "" }),
                })
                .collect();

            serde_json::json!({
                "role": "user",
                "content": content_parts
            })
        }
    }
}

/// Send a chat request to an OpenAI-compatible Chat Completions API.
#[napi]
pub async fn openai_chat(
    api_key: String,
    model: String,
    messages: Vec<Message>,
    system_prompt: Option<String>,
    tools: Option<Vec<crate::tool::Tool>>,
    max_tokens: Option<i32>,
    thinking_effort: Option<String>,
    base_url: Option<String>,
) -> napi::Result<StreamedMessage> {
    let url = base_url.unwrap_or_else(|| DEFAULT_OPENAI_URL.to_string());

    let merged = crate::merge_user_messages::merge_consecutive_user_messages(messages);
    let body = build_openai_request(
        &model,
        &merged,
        system_prompt.as_deref(),
        tools.as_deref(),
        max_tokens,
        thinking_effort.as_deref(),
    )
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let mut extra_headers = HashMap::new();
    extra_headers.insert(
        "Authorization".to_string(),
        format!("Bearer {}", api_key),
    );

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
            "OpenAI API error ({}): {}",
            status.as_u16(),
            error_text
        )));
    }

    // Read the entire response as text, then parse SSE events
    let mut full_body = String::new();
    {
        use futures_util::StreamExt;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| napi::Error::from_reason(e.to_string()))?;
            full_body.push_str(&String::from_utf8_lossy(&chunk));
        }
    }

    // Parse SSE events from the full body (same approach as anthropic.rs)
    let mut content_parts: Vec<StreamedMessagePart> = vec![];
    let mut usage = TokenUsage {
        input_other: 0,
        output: 0,
        input_cache_read: 0,
        input_cache_creation: 0,
    };
    let mut msg_id: Option<String> = None;
    let mut finish_reason: Option<String> = None;

    for line in full_body.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("data: ") {
            continue;
        }
        let json_str = &trimmed[6..];
        if json_str == "[DONE]" || json_str.is_empty() {
            continue;
        }

        let value: serde_json::Value = match serde_json::from_str(json_str) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Capture response id from the first chunk
        if msg_id.is_none() {
            if let Some(id) = value["id"].as_str() {
                msg_id = Some(id.to_string());
            }
        }

        // Parse choices
        if let Some(choices) = value["choices"].as_array() {
            for choice in choices {
                let delta = &choice["delta"];

                // Content
                if let Some(content) = delta["content"].as_str() {
                    if !content.is_empty() {
                        content_parts.push(StreamedMessagePart::text(content.to_string()));
                    }
                }

                // Reasoning content (also used by Kimi)
                if let Some(reasoning) = delta["reasoning_content"].as_str() {
                    if !reasoning.is_empty() {
                        content_parts.push(StreamedMessagePart::think(reasoning.to_string(), None));
                    }
                }

                // Tool calls
                if let Some(tool_calls) = delta["tool_calls"].as_array() {
                    for tc in tool_calls {
                        let index = tc["index"].as_i64().unwrap_or(0) as i32;
                        let function = &tc["function"];

                        if let Some(name) = function["name"].as_str() {
                            if !name.is_empty() {
                                let id = tc["id"].as_str().unwrap_or("");
                                let args = function["arguments"].as_str().unwrap_or("");
                                content_parts.push(StreamedMessagePart::tool_call(
                                    id.to_string(),
                                    name.to_string(),
                                    args.to_string(),
                                ));
                            }
                        } else if let Some(args) = function["arguments"].as_str() {
                            if !args.is_empty() {
                                content_parts.push(StreamedMessagePart::tool_call_part(
                                    args.to_string(),
                                    index,
                                ));
                            }
                        }
                    }
                }

                // Finish reason
                if let Some(finish) = choice["finish_reason"].as_str() {
                    if !finish.is_empty() {
                        finish_reason = Some(finish.to_string());
                    }
                }

                // Kimi non-standard: usage inside choices in streaming chunks
                if let Some(choice_usage) = choice["usage"].as_object() {
                    if let Some(prompt) = choice_usage["prompt_tokens"].as_i64() {
                        usage.input_other = prompt;
                    }
                    if let Some(completion) = choice_usage["completion_tokens"].as_i64() {
                        usage.output = completion;
                    }
                }
            }
        }

        // Standard usage from the top-level field (final chunk)
        if let Some(u) = value["usage"].as_object() {
            if let Some(prompt) = u["prompt_tokens"].as_i64() {
                usage.input_other = prompt;
            }
            if let Some(completion) = u["completion_tokens"].as_i64() {
                usage.output = completion;
            }
            if let Some(cache_read) = u["prompt_tokens_details"].as_object()
                .and_then(|d| d["cached_tokens"].as_i64())
            {
                usage.input_cache_read = cache_read;
            }
        }
    }

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
    use crate::message::*;

    fn parse_sse(body: &str) -> (Vec<StreamedMessagePart>, TokenUsage, Option<String>, Option<String>) {
        let mut content_parts = vec![];
        let mut usage = TokenUsage::new();
        let mut msg_id = None;
        let mut finish_reason = None;

        for line in body.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with("data: ") {
                continue;
            }
            let json_str = &trimmed[6..];
            if json_str == "[DONE]" || json_str.is_empty() {
                continue;
            }
            let value: serde_json::Value = match serde_json::from_str(json_str) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if msg_id.is_none() {
                if let Some(id) = value["id"].as_str() {
                    msg_id = Some(id.to_string());
                }
            }
            if let Some(choices) = value["choices"].as_array() {
                for choice in choices {
                    let delta = &choice["delta"];
                    if let Some(content) = delta["content"].as_str() {
                        if !content.is_empty() {
                            content_parts.push(StreamedMessagePart::text(content.to_string()));
                        }
                    }
                    if let Some(reasoning) = delta["reasoning_content"].as_str() {
                        if !reasoning.is_empty() {
                            content_parts.push(StreamedMessagePart::think(reasoning.to_string(), None));
                        }
                    }
                    if let Some(tool_calls) = delta["tool_calls"].as_array() {
                        for tc in tool_calls {
                            let index = tc["index"].as_i64().unwrap_or(0) as i32;
                            let function = &tc["function"];
                            if let Some(name) = function["name"].as_str() {
                                if !name.is_empty() {
                                    content_parts.push(StreamedMessagePart::tool_call(
                                        tc["id"].as_str().unwrap_or("").to_string(),
                                        name.to_string(),
                                        function["arguments"].as_str().unwrap_or("").to_string(),
                                    ));
                                }
                            } else if let Some(args) = function["arguments"].as_str() {
                                if !args.is_empty() {
                                    content_parts.push(StreamedMessagePart::tool_call_part(args.to_string(), index));
                                }
                            }
                        }
                    }
                    if let Some(finish) = choice["finish_reason"].as_str() {
                        if !finish.is_empty() {
                            finish_reason = Some(finish.to_string());
                        }
                    }
                }
            }
            if let Some(u) = value["usage"].as_object() {
                if let Some(prompt) = u.get("prompt_tokens").and_then(|v| v.as_i64()) {
                    usage.input_other = prompt;
                }
                if let Some(completion) = u.get("completion_tokens").and_then(|v| v.as_i64()) {
                    usage.output = completion;
                }
            }
        }
        (content_parts, usage, msg_id, finish_reason)
    }

    #[test]
    fn test_text_stream() {
        let sse = "\
data: {\"id\":\"chat_1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}

data: {\"id\":\"chat_1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" world\"},\"finish_reason\":null}]}

data: {\"id\":\"chat_1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}

data: [DONE]";
        let (parts, _usage, msg_id, fr) = parse_sse(sse);
        assert_eq!(msg_id, Some("chat_1".into()));
        assert_eq!(fr, Some("stop".into()));
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].text.as_deref(), Some("Hello"));
        assert_eq!(parts[1].text.as_deref(), Some(" world"));
    }

    #[test]
    fn test_reasoning_content() {
        let sse = "\
data: {\"id\":\"chat_r\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"thinking\"}}]}

data: {\"id\":\"chat_r\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"answer\"}}]}

data: {\"id\":\"chat_r\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}";
        let (parts, _usage, _id, fr) = parse_sse(sse);
        assert_eq!(fr, Some("stop".into()));
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].part_type, "think");
        assert_eq!(parts[0].think.as_deref(), Some("thinking"));
        assert_eq!(parts[1].part_type, "text");
        assert_eq!(parts[1].text.as_deref(), Some("answer"));
    }

    #[test]
    fn test_tool_calls() {
        let sse = "\
data: {\"id\":\"chat_t\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"\"}}]}}]}

data: {\"id\":\"chat_t\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"loc\\\"}\"}}]}}]}

data: {\"id\":\"chat_t\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}";
        let (parts, _usage, _id, fr) = parse_sse(sse);
        assert_eq!(fr, Some("tool_calls".into()));
        assert_eq!(parts[0].part_type, "function");
        assert_eq!(parts[0].name.as_deref(), Some("get_weather"));
        assert_eq!(parts[1].part_type, "tool_call_part");
    }

    #[test]
    fn test_usage() {
        let sse = "\
data: {\"id\":\"chat_u\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}";
        let (parts, usage, _id, _fr) = parse_sse(sse);
        assert_eq!(usage.input_other, 10);
        assert_eq!(usage.output, 5);
        assert_eq!(parts.len(), 1);
    }

    #[test]
    fn test_done_signal() {
        let (parts, _usage, _id, _fr) = parse_sse("data: [DONE]\n");
        assert!(parts.is_empty());
    }

    #[test]
    fn test_malformed_json() {
        let (parts, _usage, _id, _fr) = parse_sse("data: {invalid}\n");
        assert!(parts.is_empty());
    }
}