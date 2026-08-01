/// Token estimation utilities.
///
/// Faithful port of `packages/agent-core-v2/src/kosong/contract/tokens.ts`.
///
/// The heuristic is ASCII ≈ 4 chars/token, non-ASCII ≈ 1 token/char, media
/// parts a flat `MEDIA_TOKEN_ESTIMATE`. Estimates size context windows and
/// compaction budgets, never billing.
///
/// Counting is over Unicode scalar values (TS iterates `for (const char of
/// text)`, which walks code points), NOT bytes — a byte-length approximation
/// diverges on any non-ASCII input and would desync the compaction budgets in
/// `compaction_handoff`, whose truncation helpers reimplement this same
/// formula inline.
use crate::context::types::{ContentPart, ContextMessage, ToolDefinition};

/// Flat estimate charged for any media (image/audio/video) content part.
pub const MEDIA_TOKEN_ESTIMATE: u64 = 2000;

/// JSON/structured content tends to have more tokens per character than
/// natural language — short identifiers, brackets, colons, and commas each
/// tokenize into individual tokens. The raw heuristic (ascii/4) under-counts
/// these. A 1.3x multiplier on JSON-stringified content closes most of the
/// gap without paying for a real tokenizer.
const JSON_TOKEN_MULTIPLIER_NUM: u64 = 13;
const JSON_TOKEN_MULTIPLIER_DEN: u64 = 10;

/// Estimate the number of tokens in a text string.
///
/// `ceil(ascii_count / 4) + non_ascii_count`, matching `tsEstimateTokens`.
/// Shared implementation lives in `kimi-shared` (`tokens.rs`) — the single
/// source for both the napi toolset and the engine.
pub use kimi_shared::tokens::estimate_tokens;

/// Estimate tokens for JSON-serialized content. The multiplier compensates
/// for the heuristic's under-counting of JSON's dense punctuation.
pub fn estimate_tokens_for_json(text: &str) -> u64 {
    (estimate_tokens(text) * JSON_TOKEN_MULTIPLIER_NUM).div_ceil(JSON_TOKEN_MULTIPLIER_DEN)
}

/// Estimate the number of tokens in a single content part.
///
/// TS only models `text` / `think` / `image_url` / `audio_url` / `video_url`
/// and returns 0 from the exhaustive default arm; the extra `tool_use` /
/// `tool_result` variants this crate carries take that same 0 path.
pub fn estimate_content_part_tokens(part: &ContentPart) -> u64 {
    match part {
        ContentPart::Text { text } => estimate_tokens(text),
        // TS reads `part.think` unconditionally; an absent think block
        // contributes nothing.
        ContentPart::Think { think, .. } => think.as_deref().map_or(0, estimate_tokens),
        ContentPart::ImageUrl { .. } | ContentPart::AudioUrl { .. } | ContentPart::VideoUrl { .. } => {
            MEDIA_TOKEN_ESTIMATE
        }
        ContentPart::ToolUse { .. } | ContentPart::ToolResult { .. } => 0,
    }
}

/// Estimate the number of tokens across a slice of content parts.
pub fn estimate_content_parts_tokens(parts: &[ContentPart]) -> u64 {
    parts.iter().map(estimate_content_part_tokens).sum()
}

/// Estimate the number of tokens for a set of tool definitions.
pub fn estimate_tokens_for_tools(tools: &[ToolDefinition]) -> u64 {
    let mut total = 0u64;
    for tool in tools {
        total += estimate_tokens(&tool.name);
        total += estimate_tokens(&tool.description);
        let params = tool
            .input_schema
            .as_ref()
            .and_then(|v| serde_json::to_string(v).ok())
            .unwrap_or_else(|| "undefined".to_string());
        total += estimate_tokens_for_json(&params);
    }
    total
}

/// Estimate the number of tokens in a single context message.
///
/// Mirrors `estimateTokensForMessage`: role + content parts + per-tool-call
/// (name + JSON-weighted arguments) + dynamic tool schemas. Note TS charges
/// nothing for `toolCallId` / `note` / `id`, so neither does this.
pub fn estimate_message_tokens(message: &ContextMessage) -> u64 {
    let mut total = estimate_tokens(&message.role);
    total += estimate_content_parts_tokens(&message.content);
    for call in &message.tool_calls {
        total += estimate_tokens(&call.name);
        let args = serde_json::to_string(&call.arguments).unwrap_or_else(|_| "null".to_string());
        total += estimate_tokens_for_json(&args);
    }
    // Dynamic tool schema messages carry full tool definitions; without this the
    // injected schemas are invisible to every compaction budget and the context
    // overflows before compaction ever triggers.
    if let Some(tools) = &message.tools {
        total += estimate_tokens_for_tools(tools);
    }
    total
}

/// Estimate the number of tokens for a series of messages.
pub fn estimate_messages_tokens(messages: &[ContextMessage]) -> u64 {
    messages.iter().map(estimate_message_tokens).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::types::{ContentPart, ContextMessage, MediaContainer, ToolCall};

    fn text_part(text: &str) -> ContentPart {
        ContentPart::Text { text: text.to_string() }
    }

    #[test]
    fn test_estimate_tokens_empty() {
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn test_estimate_tokens_ascii_rounds_up() {
        // "hello world" = 11 ascii chars → ceil(11/4) = 3
        assert_eq!(estimate_tokens("hello world"), 3);
        // exactly divisible
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
    }

    #[test]
    fn test_estimate_tokens_non_ascii_is_one_per_char() {
        // 4 CJK code points → 4 tokens (not 12/4 = 3 bytes-based)
        assert_eq!(estimate_tokens("中文测试"), 4);
    }

    #[test]
    fn test_estimate_tokens_mixed() {
        // "ab中" → 2 ascii (ceil(2/4)=1) + 1 non-ascii = 2
        assert_eq!(estimate_tokens("ab中"), 2);
    }

    #[test]
    fn test_estimate_tokens_counts_code_points_not_bytes() {
        // A non-BMP emoji is a single code point in Rust's chars() and a single
        // `for..of` step in TS, so both count it once.
        assert_eq!(estimate_tokens("🙂"), 1);
    }

    #[test]
    fn test_estimate_tokens_for_json_applies_multiplier() {
        // 8 ascii → 2 tokens → ceil(2 * 1.3) = 3
        assert_eq!(estimate_tokens_for_json("abcdefgh"), 3);
        // 0 stays 0
        assert_eq!(estimate_tokens_for_json(""), 0);
    }

    #[test]
    fn test_media_part_is_flat_estimate() {
        let part = ContentPart::ImageUrl {
            image_url: MediaContainer { url: "data:image/png;base64,AAAA".to_string(), id: None },
        };
        assert_eq!(estimate_content_part_tokens(&part), MEDIA_TOKEN_ESTIMATE);
    }

    #[test]
    fn test_think_part_without_think_is_free() {
        let part = ContentPart::Think {
            think: None,
            encrypted: Some("sig".to_string()),
            signature: None,
        };
        assert_eq!(estimate_content_part_tokens(&part), 0);
    }

    #[test]
    fn test_estimate_message_tokens_role_plus_content() {
        let msg = ContextMessage {
            role: "user".to_string(),
            content: vec![text_part("hello")],
            ..Default::default()
        };
        // role "user" = ceil(4/4) = 1, "hello" = ceil(5/4) = 2
        assert_eq!(estimate_message_tokens(&msg), 3);
    }

    #[test]
    fn test_estimate_message_tokens_charges_tool_calls() {
        let msg = ContextMessage {
            role: "assistant".to_string(),
            tool_calls: vec![ToolCall {
                r#type: "function".to_string(),
                id: "call-1".to_string(),
                name: "read".to_string(),
                arguments: serde_json::json!({ "path": "/a" }),
                extras: None,
            }],
            ..Default::default()
        };
        // role "assistant" = ceil(9/4) = 3
        // name "read" = 1
        // args {"path":"/a"} = 14 chars → ceil(14/4)=4 → ceil(4*1.3)=6
        assert_eq!(estimate_message_tokens(&msg), 3 + 1 + 6);
    }

    #[test]
    fn test_estimate_message_tokens_ignores_tool_call_id_and_note() {
        // TS charges neither; a Rust-side extra would inflate every tool turn.
        let bare = ContextMessage { role: "tool".to_string(), ..Default::default() };
        let decorated = ContextMessage {
            role: "tool".to_string(),
            tool_call_id: Some("a-very-long-tool-call-identifier".to_string()),
            note: Some("a note that should not be charged".to_string()),
            ..Default::default()
        };
        assert_eq!(estimate_message_tokens(&bare), estimate_message_tokens(&decorated));
    }

    #[test]
    fn test_estimate_messages_tokens_sums() {
        let messages = vec![
            ContextMessage {
                role: "user".to_string(),
                content: vec![text_part("Hello, how are you?")],
                ..Default::default()
            },
            ContextMessage {
                role: "assistant".to_string(),
                content: vec![text_part("I'm doing well, thank you!")],
                ..Default::default()
            },
        ];
        let expected =
            estimate_message_tokens(&messages[0]) + estimate_message_tokens(&messages[1]);
        assert_eq!(estimate_messages_tokens(&messages), expected);
        assert!(expected > 0);
    }

    #[test]
    fn test_estimate_tokens_for_tools() {
        let tools = vec![ToolDefinition {
            name: "read".to_string(),
            description: "Read a file".to_string(),
            input_schema: Some(serde_json::json!({ "type": "object" })),
        }];
        // name 1 + description ceil(11/4)=3 + json {"type":"object"} 17 chars
        // → ceil(17/4)=5 → ceil(5*1.3)=7
        assert_eq!(estimate_tokens_for_tools(&tools), 1 + 3 + 7);
    }
}
