/// Compaction handoff — pure functions for context compaction.
///
/// Pure computation functions. TS side retains wire integration.
///
/// Corresponds to `packages/agent-core-v2/src/agent/contextMemory/compactionHandoff.ts`.
use napi_derive::napi;

const COMPACTION_SUMMARY_PREFIX: &str =
    "The following is a summary of earlier parts of this conversation that have been compacted:";
const COMPACT_USER_MESSAGE_MAX_TOKENS: i32 = 20_000;
const COMPACT_USER_MESSAGE_HEAD_TOKENS: i32 = 2_000;

/// Build a compaction summary text from the input summary string.
#[napi]
pub fn native_build_compaction_summary_text(summary: String) -> String {
    let suffix = summary.trim().to_string();
    let content = if suffix.is_empty() {
        "(no summary available)"
    } else {
        &suffix
    };
    format!("{}\n{}", COMPACTION_SUMMARY_PREFIX, content)
}

/// Build a compaction elision text.
#[napi]
pub fn native_build_compaction_elision_text(omitted_tokens: i32) -> String {
    format!(
        "<system-reminder>\n\
         Some of this conversation's user messages were omitted here during compaction: \
         the messages above this note are the oldest user input, the messages below are \
         the most recent, and roughly {} tokens in between were dropped. The omitted \
         content is covered by the compaction summary at the end of the conversation.\n\
         </system-reminder>",
        omitted_tokens
    )
}

/// Check if a message is a compaction summary.
#[napi]
pub fn native_is_compaction_summary_message(message_json: String) -> bool {
    let msg: serde_json::Value =
        serde_json::from_str(&message_json).unwrap_or(serde_json::Value::Null);
    msg.get("origin")
        .and_then(|o| o.get("kind"))
        .and_then(|k| k.as_str())
        == Some("compaction_summary")
}

/// Determine compaction disposition of a message origin.
/// Returns "keep" or "drop".
#[napi]
pub fn native_compaction_user_message_disposition(message_json: String) -> String {
    let msg: serde_json::Value =
        serde_json::from_str(&message_json).unwrap_or(serde_json::Value::Null);

    if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
        return "drop".to_string();
    }

    let origin = msg.get("origin");
    let kind = origin.and_then(|o| o.get("kind")).and_then(|k| k.as_str());
    match kind {
        None | Some("user") => "keep".to_string(),
        Some("skill_activation") | Some("plugin_command") => {
            let trigger = origin
                .and_then(|o| o.get("trigger"))
                .and_then(|t| t.as_str());
            if trigger == Some("user-slash") {
                "keep".to_string()
            } else {
                "drop".to_string()
            }
        }
        _ => "drop".to_string(),
    }
}

/// Estimate token count for a text string (ASCII heuristic).
/// Matches the TS `estimateTokens` approximation used in truncation.
fn estimate_tokens(text: &str) -> i32 {
    let mut ascii_count = 0i32;
    let mut non_ascii_count = 0i32;
    for ch in text.chars() {
        if ch as u32 <= 127 {
            ascii_count += 1;
        } else {
            non_ascii_count += 1;
        }
    }
    (ascii_count as f64 / 4.0).ceil() as i32 + non_ascii_count
}

/// Estimate token count for a message (sum of text content tokens).
fn estimate_tokens_for_message(msg: &serde_json::Value) -> i32 {
    let mut total = 0i32;
    if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
        for part in content {
            if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    total += estimate_tokens(text);
                }
            }
        }
    }
    total
}

/// Estimate tokens for an array of messages.
fn estimate_tokens_for_messages(messages: &[serde_json::Value]) -> i32 {
    messages.iter().map(|m| estimate_tokens_for_message(m)).sum()
}

/// Extract text from message content.
#[napi]
pub fn native_extract_text(message_json: String) -> String {
    let msg: serde_json::Value =
        serde_json::from_str(&message_json).unwrap_or(serde_json::Value::Null);
    let mut text = String::new();
    if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
        for part in content {
            if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                    text.push_str(t);
                }
            }
        }
    }
    text
}

/// Truncate text to a max token count (ASCII heuristic from front).
pub fn native_truncate_text_to_tokens(text: String, max_tokens: i32) -> String {
    if max_tokens <= 0 {
        return String::new();
    }
    let mut ascii_count = 0i32;
    let mut non_ascii_count = 0i32;
    let mut end: usize = 0;
    for ch in text.chars() {
        if ch as u32 <= 127 {
            ascii_count += 1;
        } else {
            non_ascii_count += 1;
        }
        if ((ascii_count as f64 / 4.0).ceil() as i32) + non_ascii_count > max_tokens {
            break;
        }
        end += ch.len_utf8();
    }
    text[..end].to_string()
}

/// Truncate text to a max token count from the end.
pub fn native_truncate_text_to_tokens_from_end(text: String, max_tokens: i32) -> String {
    if max_tokens <= 0 {
        return String::new();
    }
    let mut ascii_count = 0i32;
    let mut non_ascii_count = 0i32;
    let mut start = text.len();
    let chars: Vec<char> = text.chars().collect();
    let mut i = chars.len();
    while i > 0 {
        i -= 1;
        let ch = chars[i];
        let is_ascii = ch as u32 <= 127;
        if is_ascii {
            ascii_count += 1;
        } else {
            non_ascii_count += 1;
        }
        if ((ascii_count as f64 / 4.0).ceil() as i32) + non_ascii_count > max_tokens {
            break;
        }
        start = text.char_indices().nth(i).map(|(idx, _)| idx).unwrap_or(0);
    }
    text[start..].to_string()
}

/// Collect compactable user messages from a history.
/// Returns JSON array of messages.
#[napi]
pub fn native_collect_compactable_user_messages(messages_json: String) -> String {
    let messages: Vec<serde_json::Value> =
        serde_json::from_str(&messages_json).unwrap_or_default();

    let result: Vec<serde_json::Value> = messages
        .into_iter()
        .filter(|msg| {
            let role = msg.get("role").and_then(|r| r.as_str());
            if role != Some("user") {
                return false;
            }
            // Check it's not a compaction summary
            let is_summary = msg
                .get("origin")
                .and_then(|o| o.get("kind"))
                .and_then(|k| k.as_str())
                == Some("compaction_summary");
            if is_summary {
                return false;
            }
            // Check disposition
            native_compaction_user_message_disposition(serde_json::to_string(msg).unwrap_or_default())
                == "keep"
        })
        .collect();

    serde_json::to_string(&result).unwrap_or(messages_json)
}

/// Select recent user messages up to max_tokens.
/// Returns JSON array of messages.
#[napi]
pub fn native_select_recent_user_messages(
    messages_json: String,
    max_tokens: Option<i32>,
) -> String {
    let messages: Vec<serde_json::Value> =
        serde_json::from_str(&messages_json).unwrap_or_default();
    let budget = max_tokens.unwrap_or(COMPACT_USER_MESSAGE_MAX_TOKENS);

    let mut selected: Vec<serde_json::Value> = Vec::new();
    let mut remaining = budget;
    let mut i = messages.len() as i32 - 1;
    while i >= 0 && remaining > 0 {
        let msg = &messages[i as usize];
        let tokens = estimate_tokens_for_message(msg);
        if tokens <= remaining {
            selected.push(msg.clone());
            remaining -= tokens;
        } else {
            let text = extract_text_from_value(msg);
            let truncated = native_truncate_text_to_tokens(text, remaining);
            let mut m = msg.clone();
            m["content"] = serde_json::json!([{"type": "text", "text": truncated}]);
            m["toolCalls"] = serde_json::json!([]);
            selected.push(m);
            break;
        }
        i -= 1;
    }
    selected.reverse();

    serde_json::to_string(&selected).unwrap_or_else(|_| "[]".to_string())
}

fn extract_text_from_value(msg: &serde_json::Value) -> String {
    let mut text = String::new();
    if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
        for part in content {
            if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                    text.push_str(t);
                }
            }
        }
    }
    text
}

/// Select compaction user messages (head + tail strategy).
/// Returns JSON: { head: Message[], tail: Message[], elided: bool, omittedTokens: i32 }
#[napi]
pub fn native_select_compaction_user_messages(
    messages_json: String,
    max_tokens: Option<i32>,
    head_tokens: Option<i32>,
) -> String {
    let messages: Vec<serde_json::Value> =
        serde_json::from_str(&messages_json).unwrap_or_default();
    let budget = max_tokens.unwrap_or(COMPACT_USER_MESSAGE_MAX_TOKENS);
    let head_budget_config = head_tokens.unwrap_or(COMPACT_USER_MESSAGE_HEAD_TOKENS);

    // If total fits in budget, return all as tail
    let total_tokens: i32 = messages.iter().map(estimate_tokens_for_message).sum();
    if total_tokens <= budget {
        let result = serde_json::json!({
            "head": [],
            "tail": messages,
            "elided": false,
            "omittedTokens": 0,
        });
        return serde_json::to_string(&result).unwrap_or_default();
    }

    let head_budget = std::cmp::max(head_budget_config.min(budget), 0);
    let tail_budget = budget - head_budget;

    // Select tail from end
    let mut tail: Vec<serde_json::Value> = Vec::new();
    let mut tail_remaining = tail_budget;
    let mut head_end_exclusive = messages.len() as i32;
    let mut tail_boundary_dropped_prefix: Option<String> = None;

    let mut i = messages.len() as i32 - 1;
    while i >= 0 && tail_remaining > 0 {
        let msg = &messages[i as usize];
        let tokens = estimate_tokens_for_message(msg);
        if tokens <= tail_remaining {
            tail.push(msg.clone());
            tail_remaining -= tokens;
            head_end_exclusive = i;
            i -= 1;
            continue;
        }
        let full_text = extract_text_from_value(msg);
        let kept_suffix =
            native_truncate_text_to_tokens_from_end(full_text.clone(), tail_remaining);
        let mut m = msg.clone();
        m["content"] = serde_json::json!([{"type": "text", "text": kept_suffix}]);
        m["toolCalls"] = serde_json::json!([]);
        tail.push(m);
        head_end_exclusive = i;
        let dropped_prefix = full_text[..full_text.len().saturating_sub(kept_suffix.len())].to_string();
        if !dropped_prefix.is_empty() {
            tail_boundary_dropped_prefix = Some(dropped_prefix);
        }
        break;
    }
    tail.reverse();

    // Select head from front
    let mut head_candidates: Vec<serde_json::Value> =
        messages[..head_end_exclusive as usize].to_vec();
    if let Some(ref prefix) = tail_boundary_dropped_prefix {
        let mut m = messages[head_end_exclusive as usize].clone();
        m["content"] = serde_json::json!([{"type": "text", "text": prefix}]);
        m["toolCalls"] = serde_json::json!([]);
        head_candidates.push(m);
    }

    let mut head: Vec<serde_json::Value> = Vec::new();
    let mut head_remaining = head_budget;
    for msg in &head_candidates {
        if head_remaining <= 0 {
            break;
        }
        let tokens = estimate_tokens_for_message(msg);
        if tokens <= head_remaining {
            head.push(msg.clone());
            head_remaining -= tokens;
            continue;
        }
        let text = extract_text_from_value(msg);
        let truncated = native_truncate_text_to_tokens(text, head_remaining);
        let mut m = msg.clone();
        m["content"] = serde_json::json!([{"type": "text", "text": truncated}]);
        m["toolCalls"] = serde_json::json!([]);
        head.push(m);
        break;
    }

    let kept_tokens: i32 = head.iter().map(estimate_tokens_for_message).sum::<i32>()
        + tail.iter().map(estimate_tokens_for_message).sum::<i32>();

    let result = serde_json::json!({
        "head": head,
        "tail": tail,
        "elided": true,
        "omittedTokens": std::cmp::max(0, total_tokens - kept_tokens),
    });
    serde_json::to_string(&result).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_msg(text: &str, kind: Option<&str>) -> serde_json::Value {
        let mut msg = serde_json::json!({
            "role": "user",
            "content": [{"type": "text", "text": text}],
            "toolCalls": [],
        });
        if let Some(k) = kind {
            if k == "user" || k == "compaction_summary" || k == "skill_activation" {
                msg["origin"] = serde_json::json!({"kind": k});
            }
        }
        msg
    }

    #[test]
    fn test_build_compaction_summary_text() {
        let result = native_build_compaction_summary_text("  hello world  ".to_string());
        assert!(result.contains("hello world"));
        assert!(result.contains(COMPACTION_SUMMARY_PREFIX));
    }

    #[test]
    fn test_empty_summary() {
        let result = native_build_compaction_summary_text("  ".to_string());
        assert!(result.contains("(no summary available)"));
    }

    #[test]
    fn test_is_compaction_summary() {
        let summary_msg = serde_json::json!({
            "role": "user",
            "content": [],
            "toolCalls": [],
            "origin": {"kind": "compaction_summary"},
        });
        assert!(native_is_compaction_summary_message(summary_msg.to_string()));

        let normal_msg = user_msg("hi", Some("user"));
        assert!(!native_is_compaction_summary_message(normal_msg.to_string()));
    }

    #[test]
    fn test_disposition() {
        // User message → keep
        let msg = user_msg("hi", Some("user"));
        assert_eq!(
            native_compaction_user_message_disposition(msg.to_string()),
            "keep"
        );

        // Skill activation with user-slash → keep
        let skill_msg = serde_json::json!({
            "role": "user",
            "content": [{"type": "text", "text": "/cmd"}],
            "toolCalls": [],
            "origin": {"kind": "skill_activation", "trigger": "user-slash"},
        });
        assert_eq!(
            native_compaction_user_message_disposition(skill_msg.to_string()),
            "keep"
        );

        // Assistant message → drop
        let asst_msg = serde_json::json!({
            "role": "assistant",
            "content": [],
            "toolCalls": [],
        });
        assert_eq!(
            native_compaction_user_message_disposition(asst_msg.to_string()),
            "drop"
        );
    }

    #[test]
    fn test_truncate_text() {
        let text = "hello world this is a test".to_string();
        let truncated = native_truncate_text_to_tokens(text, 5);
        assert!(truncated.len() < "hello world this is a test".len());
    }

    #[test]
    fn test_truncate_from_end() {
        let text = "hello world this is a test".to_string();
        let truncated = native_truncate_text_to_tokens_from_end(text, 3);
        assert!(!truncated.is_empty());
    }

    #[test]
    fn test_collect_compactable() {
        let msgs = serde_json::json!([
            user_msg("first", Some("user")),
            serde_json::json!({"role": "assistant", "content": [], "toolCalls": []}),
            user_msg("second", Some("user")),
        ]);
        let result = native_collect_compactable_user_messages(msgs.to_string());
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed.len(), 2);
    }

    #[test]
    fn test_select_compaction_user_messages_no_elide() {
        let msgs = serde_json::json!([
            user_msg("short", Some("user")),
        ]);
        let result = native_select_compaction_user_messages(msgs.to_string(), Some(1000), None);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["elided"], false);
        assert_eq!(parsed["tail"].as_array().unwrap().len(), 1);
    }
}