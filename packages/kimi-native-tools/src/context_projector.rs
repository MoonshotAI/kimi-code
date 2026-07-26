/// Context projection — pure projection functions for v2 migration.
///
/// Pure transforms over message histories. The TS side retains
/// DI registration, logging, telemetry, and error reporting.
///
/// Corresponds to `packages/agent-core-v2/src/agent/contextProjector/contextProjectorService.ts`.
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Constants (must match TS) ───────────────────────────────────────────

const TOOL_INTERRUPTED_TEXT: &str =
    "Tool result is not available in the current context. Do not assume the tool completed successfully.";

const MEDIA_DEGRADED_PLACEHOLDERS: &[(&str, &str)] = &[
    ("image_url", "[image omitted: dropped to fit the provider request size limit; re-read the file to view it]"),
    ("audio_url", "[audio omitted: dropped to fit the provider request size limit; re-read the file to hear it]"),
    ("video_url", "[video omitted: dropped to fit the provider request size limit; re-read the file to view it]"),
];

const MEDIA_STRIPPED_PLACEHOLDERS: &[(&str, &str)] = &[
    ("image_url", "[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]"),
    ("audio_url", "[audio omitted for provider compatibility; re-read the file to hear it]"),
    ("video_url", "[video omitted for provider compatibility; re-read the file to view it]"),
];

// ── Result types ────────────────────────────────────────────────────────

/// Result of projection with anomaly tracking.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectionResult {
    messages: Vec<serde_json::Value>,
}

// ── Pure helpers ────────────────────────────────────────────────────────

/// Check if a content part is blank (text with only whitespace).
#[napi]
pub fn native_is_blank_text(part_json: String) -> bool {
    let part: serde_json::Value =
        serde_json::from_str(&part_json).unwrap_or(serde_json::Value::Null);
    match part.get("type").and_then(|t| t.as_str()) {
        Some("text") => part
            .get("text")
            .and_then(|t| t.as_str())
            .map(|s| s.trim().is_empty())
            .unwrap_or(false),
        _ => false,
    }
}

/// Check if a message is the interrupted tool result sentinel.
#[napi]
pub fn native_is_interrupted_tool_result(message_json: String) -> bool {
    let msg: serde_json::Value =
        serde_json::from_str(&message_json).unwrap_or(serde_json::Value::Null);
    if msg.get("role").and_then(|r| r.as_str()) != Some("tool") {
        return false;
    }
    msg.get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|part| part.get("type").and_then(|t| t.as_str()))
        .map(|t| t == "text")
        .unwrap_or(false)
        && msg
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|part| part.get("text").and_then(|t| t.as_str()))
            .map(|s| s == TOOL_INTERRUPTED_TEXT)
            .unwrap_or(false)
}

/// Check if a message is a user message that can be merged.
#[napi]
pub fn native_can_merge_user_message(message_json: String) -> bool {
    let msg: serde_json::Value =
        serde_json::from_str(&message_json).unwrap_or(serde_json::Value::Null);
    let role = msg.get("role").and_then(|r| r.as_str());
    if role != Some("user") {
        return false;
    }
    msg.get("origin")
        .and_then(|o| o.get("kind"))
        .and_then(|k| k.as_str())
        == Some("user")
}

/// Check if a message has declared tools.
#[napi]
pub fn native_has_declared_tools(message_json: String) -> bool {
    let msg: serde_json::Value =
        serde_json::from_str(&message_json).unwrap_or(serde_json::Value::Null);
    msg.get("tools")
        .and_then(|t| t.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false)
}

/// Degrade older media parts, keeping only the `keep_recent` most recent ones.
/// Input: JSON array of Message objects.
/// Returns: JSON array of Message objects.
#[napi]
pub fn native_degrade_older_media_parts(messages_json: String, keep_recent: i32) -> String {
    let messages: Vec<serde_json::Value> =
        serde_json::from_str(&messages_json).unwrap_or_default();

    let media_count: usize = messages
        .iter()
        .flat_map(|msg| msg["content"].as_array().into_iter().flatten())
        .filter(|part| is_degradable_media_part(part))
        .count();

    let to_degrade = media_count.saturating_sub(keep_recent as usize);
    if to_degrade == 0 {
        return messages_json;
    }

    let mut remaining = to_degrade as i32;
    let result: Vec<serde_json::Value> = messages
        .into_iter()
        .map(|msg| {
            if remaining <= 0 || !msg["content"]
                .as_array()
                .map_or(false, |c| c.iter().any(|p| is_degradable_media_part(p)))
            {
                return msg;
            }
            let content: Vec<serde_json::Value> = msg["content"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .map(|part| {
                            if remaining > 0 && is_degradable_media_part(part) {
                                remaining -= 1;
                                let placeholder = degraded_placeholder(part);
                                serde_json::json!({"type": "text", "text": placeholder})
                            } else {
                                part.clone()
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            serde_json::json!({
                "role": msg["role"],
                "name": msg.get("name"),
                "content": content,
                "toolCalls": msg["toolCalls"],
                "toolCallId": msg.get("toolCallId"),
                "partial": msg.get("partial"),
            })
        })
        .collect();

    serde_json::to_string(&result).unwrap_or(messages_json)
}

/// Check if a degradable media part matches a snapshot key.
fn is_degradable_media_part(part: &serde_json::Value) -> bool {
    part.get("type")
        .and_then(|t| t.as_str())
        .map(|t| {
            MEDIA_DEGRADED_PLACEHOLDERS
                .iter()
                .any(|(key, _)| *key == t)
        })
        .unwrap_or(false)
}

fn degraded_placeholder(part: &serde_json::Value) -> &'static str {
    let type_str = part["type"].as_str().unwrap_or("");
    MEDIA_DEGRADED_PLACEHOLDERS
        .iter()
        .find(|(key, _)| *key == type_str)
        .map(|(_, val)| *val)
        .unwrap_or("[media omitted]")
}

fn stripped_placeholder(part: &serde_json::Value) -> &'static str {
    let type_str = part["type"].as_str().unwrap_or("");
    MEDIA_STRIPPED_PLACEHOLDERS
        .iter()
        .find(|(key, _)| *key == type_str)
        .map(|(_, val)| *val)
        .unwrap_or("[media omitted]")
}

/// Capture a media strip snapshot: returns a set of media keys.
/// Input: JSON array of Message objects.
/// Returns: JSON array of media key strings.
#[napi]
pub fn native_capture_media_strip_snapshot(messages_json: String) -> String {
    let messages: Vec<serde_json::Value> =
        serde_json::from_str(&messages_json).unwrap_or_default();

    let mut keys: Vec<String> = Vec::new();
    for msg in &messages {
        if let Some(content) = msg["content"].as_array() {
            for part in content {
                if is_degradable_media_part(part) {
                    keys.push(media_strip_key(part));
                }
            }
        }
    }
    keys.sort();
    keys.dedup();
    serde_json::to_string(&keys).unwrap_or_default()
}

/// Compute a deterministic media strip key (SHA256 hash).
fn media_strip_key(part: &serde_json::Value) -> String {
    let type_str = part["type"].as_str().unwrap_or("");
    let container = media_container(part);
    let id = container
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let url = container
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(type_str.as_bytes());
    hasher.update(b"\0");
    hasher.update(id.as_bytes());
    hasher.update(b"\0");
    hasher.update(url.as_bytes());
    let hash = hasher.finalize();
    format!("{:02x}{:02x}{:02x}{:02x}", hash[0], hash[1], hash[2], hash[3])
}

fn media_container(part: &serde_json::Value) -> serde_json::Value {
    match part["type"].as_str() {
        Some("image_url") => part["imageUrl"].clone(),
        Some("audio_url") => part["audioUrl"].clone(),
        Some("video_url") => part["videoUrl"].clone(),
        _ => serde_json::Value::Null,
    }
}

/// Strip media parts by snapshot keys.
/// Input: messages_json (array), snapshot_keys_json (array of key strings).
/// Returns: JSON array of Message objects.
#[napi]
pub fn native_strip_media_parts_by_snapshot(
    messages_json: String,
    snapshot_keys_json: String,
) -> String {
    let messages: Vec<serde_json::Value> =
        serde_json::from_str(&messages_json).unwrap_or_default();
    let keys: Vec<String> =
        serde_json::from_str(&snapshot_keys_json).unwrap_or_default();

    let mut changed = false;
    let result: Vec<serde_json::Value> = messages
        .into_iter()
        .map(|msg| {
            if let Some(content) = msg["content"].as_array() {
                let mut msg_changed = false;
                let new_content: Vec<serde_json::Value> = content
                    .iter()
                    .map(|part| {
                        if is_degradable_media_part(part)
                            && keys.contains(&media_strip_key(part))
                        {
                            msg_changed = true;
                            changed = true;
                            serde_json::json!({
                                "type": "text",
                                "text": stripped_placeholder(part)
                            })
                        } else {
                            part.clone()
                        }
                    })
                    .collect();
                if msg_changed {
                    let mut m = msg.clone();
                    m["content"] = serde_json::json!(new_content);
                    return m;
                }
            }
            msg
        })
        .collect();

    if changed {
        serde_json::to_string(&result).unwrap_or(messages_json)
    } else {
        messages_json
    }
}

/// Drop leading non-user messages from a message array.
/// Returns JSON: { messages: Message[], dropped: i32 }
#[napi]
pub fn native_drop_leading_non_user_messages(messages_json: String) -> String {
    let messages: Vec<serde_json::Value> =
        serde_json::from_str(&messages_json).unwrap_or_default();

    let mut start = 0usize;
    let mut dropped = 0i32;
    while start < messages.len() {
        let role = messages[start]
            .get("role")
            .and_then(|r| r.as_str())
            .unwrap_or("");
        if role == "user" {
            break;
        }
        dropped += 1;
        start += 1;
    }

    let result = if start == 0 {
        messages
    } else {
        messages[start..].to_vec()
    };

    serde_json::json!({
        "messages": result,
        "dropped": dropped,
    })
    .to_string()
}

/// Merge consecutive assistant messages.
/// Returns JSON: { messages: Message[], merged: i32 }
#[napi]
pub fn native_merge_consecutive_assistant_messages(messages_json: String) -> String {
    let messages: Vec<serde_json::Value> =
        serde_json::from_str(&messages_json).unwrap_or_default();

    let mut merged = 0i32;
    let mut out: Vec<serde_json::Value> = Vec::with_capacity(messages.len());

    for msg in messages {
        let is_assistant = msg["role"].as_str() == Some("assistant");
        if is_assistant {
            if let Some(prev) = out.last_mut() {
                if prev["role"].as_str() == Some("assistant") {
                    // Merge: combine content and toolCalls
                    let mut new_content = prev["content"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    if let Some(content) = msg["content"].as_array() {
                        new_content.extend(content.iter().cloned());
                    }
                    let mut new_calls = prev["toolCalls"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    if let Some(calls) = msg["toolCalls"].as_array() {
                        new_calls.extend(calls.iter().cloned());
                    }
                    prev["content"] = serde_json::json!(new_content);
                    prev["toolCalls"] = serde_json::json!(new_calls);
                    merged += 1;
                    continue;
                }
            }
        }
        out.push(msg);
    }

    serde_json::json!({
        "messages": out,
        "merged": merged,
    })
    .to_string()
}

/// Deduplicate duplicate tool calls and tool results.
/// Returns JSON: { messages: Message[], anomalies: string[] }
#[napi]
pub fn native_dedupe_duplicate_tool_calls(messages_json: String) -> String {
    let messages: Vec<serde_json::Value> =
        serde_json::from_str(&messages_json).unwrap_or_default();

    let mut seen_tool_call_ids: Vec<String> = Vec::new();
    let mut kept_tool_result_indexes: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut out: Vec<serde_json::Value> = Vec::with_capacity(messages.len());
    let mut anomalies: Vec<String> = Vec::new();

    for msg in &messages {
        let role = msg["role"].as_str().unwrap_or("");
        if role == "assistant" {
            if let Some(calls) = msg["toolCalls"].as_array() {
                let kept: Vec<serde_json::Value> = calls
                    .iter()
                    .filter(|call| {
                        let id = call["id"].as_str().unwrap_or("");
                        if seen_tool_call_ids.contains(&id.to_string()) {
                            anomalies.push(format!("duplicate_tool_call_dropped:{}", id));
                            false
                        } else {
                            seen_tool_call_ids.push(id.to_string());
                            true
                        }
                    })
                    .cloned()
                    .collect();

                if kept.len() == calls.len() {
                    out.push(msg.clone());
                } else if !kept.is_empty()
                    || msg["content"]
                        .as_array()
                        .map_or(false, |c| c.iter().any(|p| !is_vacuous(p)))
                {
                    let mut m = msg.clone();
                    m["toolCalls"] = serde_json::json!(kept);
                    out.push(m);
                } else if msg["content"]
                    .as_array()
                    .map_or(false, |c| !c.is_empty())
                {
                    anomalies.push(format!("vacuous_message_dropped:{}", role));
                }
            }
            continue;
        }

        if role == "tool" {
            if let Some(call_id) = msg["toolCallId"].as_str() {
                if let Some(&prev_idx) = kept_tool_result_indexes.get(call_id) {
                    if !is_interrupted(&out[prev_idx]) || is_interrupted(msg) {
                        // skip duplicate
                        anomalies.push(format!("duplicate_tool_result_dropped:{}", call_id));
                        continue;
                    }
                    // Replace the interrupted result with the real one
                    out[prev_idx] = msg.clone();
                    continue;
                }
                kept_tool_result_indexes.insert(call_id.to_string(), out.len());
            }
        }

        out.push(msg.clone());
    }

    serde_json::json!({
        "messages": out,
        "anomalies": anomalies,
    })
    .to_string()
}

fn is_vacuous(part: &serde_json::Value) -> bool {
    part.get("type")
        .and_then(|t| t.as_str())
        .map(|t| t == "thinking")
        .unwrap_or(false)
}

fn is_interrupted(msg: &serde_json::Value) -> bool {
    msg["content"]
        .as_array()
        .and_then(|c| c.first())
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .map(|s| s == TOOL_INTERRUPTED_TEXT)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_part(text: &str) -> serde_json::Value {
        serde_json::json!({"type": "text", "text": text})
    }

    fn image_part(url: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "image_url",
            "imageUrl": {"url": url, "id": "img1"}
        })
    }

    fn user_msg(content: Vec<serde_json::Value>, origin_kind: &str) -> serde_json::Value {
        serde_json::json!({
            "role": "user",
            "content": content,
            "toolCalls": [],
            "origin": {"kind": origin_kind}
        })
    }

    fn assistant_msg(content: Vec<serde_json::Value>, tool_calls: Vec<serde_json::Value>) -> serde_json::Value {
        serde_json::json!({
            "role": "assistant",
            "content": content,
            "toolCalls": tool_calls,
        })
    }

    fn tool_msg(call_id: &str, text: &str) -> serde_json::Value {
        serde_json::json!({
            "role": "tool",
            "toolCallId": call_id,
            "content": [text_part(text)],
            "toolCalls": [],
        })
    }

    #[test]
    fn test_is_blank_text() {
        assert!(native_is_blank_text(r#"{"type":"text","text":"   "}"#.to_string()));
        assert!(!native_is_blank_text(r#"{"type":"text","text":"hello"}"#.to_string()));
        assert!(!native_is_blank_text(r#"{"type":"image_url"}"#.to_string()));
    }

    #[test]
    fn test_degrade_older_media_parts() {
        let msgs = serde_json::json!([
            user_msg(vec![text_part("hello"), image_part("img1.jpg")], "user"),
            user_msg(vec![image_part("img2.jpg")], "user"),
        ]);
        let result = native_degrade_older_media_parts(msgs.to_string(), 1);
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&result).unwrap();
        // First image should be degraded (only keep 1)
        let first_content = parsed[0]["content"].as_array().unwrap();
        assert_eq!(first_content[1]["type"], "text");
        assert!(first_content[1]["text"]
            .as_str()
            .unwrap()
            .contains("image omitted"));
        // Second message's image should remain
        let second_content = parsed[1]["content"].as_array().unwrap();
        assert_eq!(second_content[0]["type"], "image_url");
    }

    #[test]
    fn test_drop_leading_non_user() {
        let msgs = serde_json::json!([
            assistant_msg(vec![text_part("hi")], vec![]),
            user_msg(vec![text_part("hello")], "user"),
        ]);
        let result = native_drop_leading_non_user_messages(msgs.to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["dropped"], 1);
        assert_eq!(parsed["messages"].as_array().unwrap().len(), 1);
        assert_eq!(
            parsed["messages"][0]["content"][0]["text"],
            "hello"
        );
    }

    #[test]
    fn test_merge_consecutive_assistant() {
        let msgs = serde_json::json!([
            assistant_msg(vec![text_part("first")], vec![]),
            assistant_msg(vec![text_part("second")], vec![]),
            user_msg(vec![text_part("user")], "user"),
        ]);
        let result = native_merge_consecutive_assistant_messages(msgs.to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["merged"], 1);
        let msgs = parsed["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        // Combined content should have both texts
        let content = msgs[0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
    }

    #[test]
    fn test_dedupe_duplicate_tool_calls() {
        let msgs = serde_json::json!([
            assistant_msg(
                vec![],
                vec![serde_json::json!({"id": "call-1", "name": "read", "args": {}})],
            ),
            tool_msg("call-1", "result"),
            assistant_msg(
                vec![],
                vec![
                    serde_json::json!({"id": "call-1", "name": "read", "args": {}}),
                    serde_json::json!({"id": "call-2", "name": "write", "args": {}}),
                ],
            ),
            tool_msg("call-2", "written"),
        ]);
        let result = native_dedupe_duplicate_tool_calls(msgs.to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        // Second assistant should have only call-2 (call-1 was deduped)
        let msgs = parsed["messages"].as_array().unwrap();
        let second_assistant = &msgs[2];
        let calls = second_assistant["toolCalls"].as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "call-2");
        // Anomalies should contain the duplicate
        let anomalies = parsed["anomalies"].as_array().unwrap();
        assert!(anomalies.iter().any(|a| a.as_str().unwrap().contains("duplicate_tool_call")));
    }

    #[test]
    fn test_capture_and_strip_media() {
        let msgs = serde_json::json!([
            user_msg(vec![image_part("img1.jpg")], "user"),
        ]);
        let keys_json = native_capture_media_strip_snapshot(msgs.to_string());
        let keys: Vec<String> = serde_json::from_str(&keys_json).unwrap();
        assert!(!keys.is_empty());

        let stripped = native_strip_media_parts_by_snapshot(msgs.to_string(), keys_json);
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&stripped).unwrap();
        let content = parsed[0]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "text");
        assert!(content[0]["text"]
            .as_str()
            .unwrap()
            .contains("provider compatibility"));
    }
}