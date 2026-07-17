//! Google GenAI (Gemini) API adapter.
//! Mirrors `packages/kosong/src/providers/google-genai.ts`.
//!
//! Gemini uses a different API format from OpenAI/Anthropic:
//! - Request: POST /v1beta/models/{model}:streamGenerateContent
//! - Auth: `?key={apiKey}` query param (Gemini) or Bearer token (Vertex AI)
//! - Response: NDJSON (newline-delimited JSON), each line is a complete JSON object
//! - No SSE event: prefixes, just raw JSON lines

use crate::errors::ProviderError;
use crate::http::HttpClient;
use crate::message::*;
use napi_derive::napi;
use std::collections::HashMap;

const DEFAULT_GEMINI_URL: &str =
    "https://generativelanguage.googleapis.com/v1beta/models";

/// Build a Gemini API request body from the standardized Message format.
fn build_gemini_request(
    _model: &str,
    messages: &[Message],
    system_prompt: Option<&str>,
    tools: Option<&[crate::tool::Tool]>,
    max_tokens: Option<i32>,
) -> Result<String, ProviderError> {
    let mut body = serde_json::Map::new();

    // Convert messages to Gemini contents format
    let contents = messages_to_gemini_contents(messages);
    body.insert(
        "contents".to_string(),
        serde_json::Value::Array(contents),
    );

    // System instruction
    if let Some(sys) = system_prompt {
        if !sys.is_empty() {
            body.insert(
                "systemInstruction".to_string(),
                serde_json::json!({
                    "parts": [{"text": sys}]
                }),
            );
        }
    }

    // Tools
    if let Some(tools_list) = tools {
        if !tools_list.is_empty() {
            let func_decls: Vec<serde_json::Value> = tools_list
                .iter()
                .map(|t| {
                    let params: serde_json::Value = t
                        .parameters
                        .as_deref()
                        .and_then(|p| serde_json::from_str(p).ok())
                        .unwrap_or(serde_json::json!({}));
                    serde_json::json!({
                        "name": t.name,
                        "description": t.description,
                        "parameters": params
                    })
                })
                .collect();
            body.insert(
                "tools".to_string(),
                serde_json::json!([{ "functionDeclarations": func_decls }]),
            );
        }
    }

    // Generation config
    let mut config = serde_json::Map::new();
    if let Some(mt) = max_tokens {
        config.insert(
            "maxOutputTokens".to_string(),
            serde_json::Value::Number(serde_json::Number::from(mt as i64)),
        );
    }
    if !config.is_empty() {
        body.insert(
            "generationConfig".to_string(),
            serde_json::Value::Object(config),
        );
    }

    serde_json::to_string(&serde_json::Value::Object(body))
        .map_err(|e| ProviderError::Serialization(e.to_string()))
}

/// Convert our Message format to Gemini contents array.
fn messages_to_gemini_contents(messages: &[Message]) -> Vec<serde_json::Value> {
    let mut contents: Vec<serde_json::Value> = Vec::new();

    for msg in messages {
        let role = match msg.role.as_str() {
            "assistant" => "model",
            "tool" => "user", // Tool results become user turns
            _ => "user",      // system → user (wrapped in <system>), user → user
        };

        let mut parts: Vec<serde_json::Value> = Vec::new();

        // Content parts
        for part in &msg.content {
            match part.part_type.as_str() {
                "text" => {
                    let text = part.text.as_deref().unwrap_or("");
                    if msg.role == "system" {
                        parts.push(serde_json::json!({
                            "text": format!("<system>{}</system>", text)
                        }));
                    } else {
                        parts.push(serde_json::json!({ "text": text }));
                    }
                }
                "think" => {
                    let think_text = part.think.as_deref().unwrap_or("");
                    let mut think_part = serde_json::json!({
                        "text": think_text,
                        "thought": true
                    });
                    if let Some(encrypted) = &part.encrypted {
                        think_part["thoughtSignature"] =
                            serde_json::Value::String(encrypted.clone());
                    }
                    parts.push(think_part);
                }
                "image_url" => {
                    if let Some(img) = &part.image_url {
                        let url = &img.url;
                        if url.starts_with("data:") {
                            // Convert data URL to inline data
                            if let Some((media_type, data)) = url
                                .strip_prefix("data:")
                                .and_then(|s| s.split_once(";base64,"))
                            {
                                parts.push(serde_json::json!({
                                    "inlineData": {
                                        "mimeType": media_type,
                                        "data": data
                                    }
                                }));
                            }
                        } else {
                            parts.push(serde_json::json!({
                                "fileData": {
                                    "mimeType": "image/jpeg",
                                    "fileUri": url
                                }
                            }));
                        }
                    }
                }
                "audio_url" => {
                    if let Some(audio) = &part.audio_url {
                        let url = &audio.url;
                        if let Some((media_type, data)) = url
                            .strip_prefix("data:")
                            .and_then(|s| s.split_once(";base64,"))
                        {
                            parts.push(serde_json::json!({
                                "inlineData": {
                                    "mimeType": media_type,
                                    "data": data
                                }
                            }));
                        }
                    }
                }
                "video_url" => {
                    if let Some(video) = &part.video_url {
                        let url = &video.url;
                        if let Some((media_type, data)) = url
                            .strip_prefix("data:")
                            .and_then(|s| s.split_once(";base64,"))
                        {
                            parts.push(serde_json::json!({
                                "inlineData": {
                                    "mimeType": media_type,
                                    "data": data
                                }
                            }));
                        }
                    }
                }
                _ => {}
            }
        }

        // Tool calls (assistant → functionCall parts)
        if msg.role == "assistant" && !msg.tool_calls.is_empty() {
            for tc in &msg.tool_calls {
                let args: serde_json::Value = tc
                    .arguments
                    .as_deref()
                    .and_then(|a| serde_json::from_str(a).ok())
                    .unwrap_or(serde_json::json!({}));
                parts.push(serde_json::json!({
                    "functionCall": {
                        "name": tc.name,
                        "args": args
                    }
                }));
            }
        }

        // Tool results (tool → functionResponse parts)
        if msg.role == "tool" {
            if let Some(tool_call_id) = &msg.tool_call_id {
                let text = msg
                    .content
                    .iter()
                    .filter_map(|p| p.text.as_deref())
                    .collect::<Vec<_>>()
                    .join("\n");
                parts.push(serde_json::json!({
                    "functionResponse": {
                        "name": tool_call_id,
                        "response": {
                            "name": tool_call_id,
                            "content": text
                        }
                    }
                }));
            }
        }

        if !parts.is_empty() {
            contents.push(serde_json::json!({
                "role": role,
                "parts": parts
            }));
        }
    }

    // Merge consecutive user messages (Gemini requires alternating turns)
    let mut merged: Vec<serde_json::Value> = Vec::new();
    for content in contents {
        let role = content["role"].as_str().unwrap_or("").to_string();
        if role == "user" && !merged.is_empty() {
            let last = merged.last_mut().unwrap();
            if last["role"].as_str() == Some("user") {
                if let Some(last_parts) = last["parts"].as_array_mut() {
                    if let Some(new_parts) = content["parts"].as_array() {
                        last_parts.extend(new_parts.iter().cloned());
                    }
                }
                continue;
            }
        }
        merged.push(content);
    }

    merged
}

/// Parse a Gemini NDJSON chunk into streamed message parts.
fn parse_gemini_chunk(
    line: &str,
    content_parts: &mut Vec<StreamedMessagePart>,
    msg_id: &mut Option<String>,
    finish_reason: &mut Option<String>,
    usage: &mut TokenUsage,
) {
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };

    // Response ID
    if msg_id.is_none() {
        if let Some(id) = value["responseId"].as_str() {
            *msg_id = Some(id.to_string());
        }
    }

    // Usage metadata
    if let Some(um) = value["usageMetadata"].as_object() {
        let prompt_tokens = um["promptTokenCount"].as_i64().unwrap_or(0);
        let cached_tokens = um["cachedContentTokenCount"].as_i64().unwrap_or(0);
        let output_tokens = um["candidatesTokenCount"].as_i64().unwrap_or(0);
        usage.input_other = (prompt_tokens - cached_tokens).max(0);
        usage.input_cache_read = cached_tokens;
        usage.output = output_tokens;
    }

    // Candidates
    if let Some(candidates) = value["candidates"].as_array() {
        for candidate in candidates {
            // Finish reason
            if let Some(reason) = candidate["finishReason"].as_str() {
                if !reason.is_empty() && reason != "FINISH_REASON_UNSPECIFIED" {
                    *finish_reason = Some(reason.to_string());
                }
            }

            // Content parts
            if let Some(content) = candidate["content"].as_object() {
                if let Some(parts) = content["parts"].as_array() {
                    for part in parts {
                        // Thinking content (thought: true)
                        if part["thought"].as_bool() == Some(true) {
                            let think_text = part["text"].as_str().unwrap_or("");
                            let sig = part["thoughtSignature"]
                                .as_str()
                                .or_else(|| part["thought_signature"].as_str());
                            content_parts.push(StreamedMessagePart::think(
                                think_text.to_string(),
                                sig.map(|s| s.to_string()),
                            ));
                        } else if let Some(text) = part["text"].as_str() {
                            if !text.is_empty() {
                                content_parts.push(StreamedMessagePart::text(text.to_string()));
                            }
                        } else if let Some(fc) = part["functionCall"]
                            .as_object()
                            .or_else(|| part["function_call"].as_object())
                        {
                            if let Some(name) = fc["name"].as_str() {
                                let args = fc.get("args")
                                    .map(|a| a.to_string())
                                    .unwrap_or_else(|| "{}".to_string());
                                content_parts.push(StreamedMessagePart::tool_call(
                                    String::new(), // Gemini doesn't provide function call IDs
                                    name.to_string(),
                                    args,
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Send a chat request to the Google GenAI (Gemini) API.
///
/// Uses the `streamGenerateContent` endpoint for streaming responses.
#[napi]
pub async fn google_genai_chat(
    api_key: String,
    model: String,
    messages: Vec<Message>,
    system_prompt: Option<String>,
    tools: Option<Vec<crate::tool::Tool>>,
    max_tokens: Option<i32>,
    base_url: Option<String>,
) -> napi::Result<StreamedMessage> {
    let base = base_url.unwrap_or_else(|| DEFAULT_GEMINI_URL.to_string());
    // Gemini streaming endpoint: POST /v1beta/models/{model}:streamGenerateContent
    let url = format!("{}/{}:streamGenerateContent?key={}", base, model, api_key);

    let body = build_gemini_request(
        &model,
        &messages,
        system_prompt.as_deref(),
        tools.as_deref(),
        max_tokens,
    )
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let mut extra_headers = HashMap::new();
    extra_headers.insert(
        "Content-Type".to_string(),
        "application/json".to_string(),
    );

    let client = HttpClient::shared();
    let response = client
        .post_json_stream(&url, &api_key, &body, Some(&extra_headers))
        .await
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "unknown error".to_string());
        return Err(napi::Error::from_reason(format!(
            "Gemini API error ({}): {}",
            status.as_u16(),
            error_text
        )));
    }

    // Read the full response body
    let mut full_body = String::new();
    {
        use futures_util::StreamExt;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| napi::Error::from_reason(e.to_string()))?;
            full_body.push_str(&String::from_utf8_lossy(&chunk));
        }
    }

    // Parse NDJSON: each non-empty line is a complete JSON object
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
        if trimmed.is_empty() {
            continue;
        }
        parse_gemini_chunk(
            trimmed,
            &mut content_parts,
            &mut msg_id,
            &mut finish_reason,
            &mut usage,
        );
    }

    Ok(StreamedMessage {
        id: msg_id,
        content: content_parts,
        usage,
        finish_reason: finish_reason.clone(),
        raw_finish_reason: finish_reason,
        trace_id: None,
    })
}

#[cfg(test)]
mod tests {
    use crate::message::*;

    fn parse_ndjson(body: &str) -> (Vec<StreamedMessagePart>, TokenUsage, Option<String>, Option<String>) {
        let mut content_parts = vec![];
        let mut usage = TokenUsage::new();
        let mut msg_id = None;
        let mut finish_reason = None;

        for line in body.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let value: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if msg_id.is_none() {
                if let Some(id) = value["responseId"].as_str() {
                    msg_id = Some(id.to_string());
                }
            }
            if let Some(um) = value["usageMetadata"].as_object() {
                let prompt = um.get("promptTokenCount").and_then(|v| v.as_i64()).unwrap_or(0);
                let cached = um.get("cachedContentTokenCount").and_then(|v| v.as_i64()).unwrap_or(0);
                let output = um.get("candidatesTokenCount").and_then(|v| v.as_i64()).unwrap_or(0);
                usage.input_other = (prompt - cached).max(0);
                usage.input_cache_read = cached;
                usage.output = output;
            }
            if let Some(candidates) = value["candidates"].as_array() {
                for candidate in candidates {
                    if let Some(reason) = candidate["finishReason"].as_str() {
                        if !reason.is_empty() && reason != "FINISH_REASON_UNSPECIFIED" {
                            finish_reason = Some(reason.to_string());
                        }
                    }
                    if let Some(content) = candidate["content"].as_object() {
                        if let Some(parts) = content["parts"].as_array() {
                            for part in parts {
                                if part["thought"].as_bool() == Some(true) {
                                    let think_text = part["text"].as_str().unwrap_or("");
                                    let sig = part["thoughtSignature"].as_str().or_else(|| part["thought_signature"].as_str());
                                    content_parts.push(StreamedMessagePart::think(think_text.to_string(), sig.map(|s| s.to_string())));
                                } else if let Some(text) = part["text"].as_str() {
                                    if !text.is_empty() {
                                        content_parts.push(StreamedMessagePart::text(text.to_string()));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        (content_parts, usage, msg_id, finish_reason)
    }

    #[test]
    fn test_text_stream() {
        let ndjson = "\
{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hello\"}],\"role\":\"model\"},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":5,\"candidatesTokenCount\":1}}
{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\" world\"}],\"role\":\"model\"},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":5,\"candidatesTokenCount\":2}}";
        let (parts, usage, _id, fr) = parse_ndjson(ndjson);
        assert_eq!(fr, Some("STOP".into()));
        assert_eq!(usage.input_other, 5);
        assert_eq!(usage.output, 2);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].text.as_deref(), Some("Hello"));
        assert_eq!(parts[1].text.as_deref(), Some(" world"));
    }

    #[test]
    fn test_thinking() {
        let ndjson = "\
{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"reasoning\",\"thought\":true,\"thoughtSignature\":\"sig_abc\"}],\"role\":\"model\"},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":5}}
{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"answer\"}],\"role\":\"model\"},\"finishReason\":\"STOP\"}]}";
        let (parts, _usage, _id, fr) = parse_ndjson(ndjson);
        assert_eq!(fr, Some("STOP".into()));
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].part_type, "think");
        assert_eq!(parts[0].think.as_deref(), Some("reasoning"));
        assert_eq!(parts[0].encrypted.as_deref(), Some("sig_abc"));
        assert_eq!(parts[1].part_type, "text");
        assert_eq!(parts[1].text.as_deref(), Some("answer"));
    }

    #[test]
    fn test_response_id() {
        let ndjson = "{\"responseId\":\"gemini_1\",\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]}}]}";
        let (parts, _usage, msg_id, _fr) = parse_ndjson(ndjson);
        assert_eq!(msg_id, Some("gemini_1".into()));
        assert_eq!(parts.len(), 1);
    }

    #[test]
    fn test_cache_usage() {
        let ndjson = "{\"usageMetadata\":{\"promptTokenCount\":100,\"cachedContentTokenCount\":30,\"candidatesTokenCount\":20}}";
        let (_parts, usage, _id, _fr) = parse_ndjson(ndjson);
        assert_eq!(usage.input_other, 70); // 100 - 30
        assert_eq!(usage.input_cache_read, 30);
        assert_eq!(usage.output, 20);
    }

    #[test]
    fn test_empty_body() {
        let (parts, usage, msg_id, fr) = parse_ndjson("");
        assert!(parts.is_empty());
        assert!(msg_id.is_none());
        assert!(fr.is_none());
        assert_eq!(usage.input_other, 0);
    }
}