/// Character-based token-count estimates.
///
/// Corresponds to `kosong/contract/tokens.rs`.
use super::message::{ContentPart, Message};
use super::tool::Tool;

/// JSON/structured content multiplier to compensate for heuristic under-counting.
const JSON_TOKEN_MULTIPLIER: f64 = 1.3;

/// Flat token estimate for media parts (images, audio, video).
pub const MEDIA_TOKEN_ESTIMATE: u32 = 2000;

/// Estimate tokens for a text string using a simple heuristic.
/// ASCII ≈ 4 chars/token, non-ASCII ≈ 1 token/char.
pub fn estimate_tokens(text: &str) -> u32 {
    let mut ascii_count = 0u32;
    let mut non_ascii_count = 0u32;
    for ch in text.chars() {
        if ch as u32 <= 127 {
            ascii_count += 1;
        } else {
            non_ascii_count += 1;
        }
    }
    ((ascii_count as f64) / 4.0).ceil() as u32 + non_ascii_count
}

/// Estimate tokens for JSON-serialized content (with multiplier).
fn estimate_tokens_for_json(text: &str) -> u32 {
    ((estimate_tokens(text) as f64) * JSON_TOKEN_MULTIPLIER).ceil() as u32
}

/// Estimate tokens for a single content part.
pub fn estimate_tokens_for_content_part(part: &ContentPart) -> u32 {
    match part {
        ContentPart::Text { text } => estimate_tokens(text),
        ContentPart::Think { think, .. } => estimate_tokens(think),
        ContentPart::ImageUrl { .. } | ContentPart::AudioUrl { .. } | ContentPart::VideoUrl { .. } => {
            MEDIA_TOKEN_ESTIMATE
        }
    }
}

/// Estimate tokens for a collection of content parts.
pub fn estimate_tokens_for_content_parts(parts: &[ContentPart]) -> u32 {
    parts.iter().map(|p| estimate_tokens_for_content_part(p)).sum()
}

/// Estimate tokens for a tool definition.
pub fn estimate_tokens_for_tool(tool: &Tool) -> u32 {
    estimate_tokens(&tool.name)
        + estimate_tokens(&tool.description)
        + estimate_tokens_for_json(&serde_json::to_string(&tool.parameters).unwrap_or_default())
}

/// Estimate tokens for a collection of tools.
pub fn estimate_tokens_for_tools(tools: &[Tool]) -> u32 {
    tools.iter().map(|t| estimate_tokens_for_tool(t)).sum()
}

/// Estimate tokens for a single message.
pub fn estimate_tokens_for_message(message: &Message) -> u32 {
    let mut total = estimate_tokens(message.role.as_str());
    total += estimate_tokens_for_content_parts(&message.content);
    for call in &message.tool_calls {
        total += estimate_tokens(&call.name);
        if let Some(ref args) = call.arguments {
            total += estimate_tokens_for_json(args);
        }
    }
    // Dynamic tool schema messages carry full tool definitions
    if let Some(ref tools) = message.tools {
        total += estimate_tokens_for_tools(tools);
    }
    total
}

/// Estimate tokens for a collection of messages.
pub fn estimate_tokens_for_messages(messages: &[Message]) -> u32 {
    messages.iter().map(|m| estimate_tokens_for_message(m)).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kosong::contract::message::*;

    #[test]
    fn test_estimate_ascii() {
        // "hello" = 5 chars, 5/4 = 1.25 -> ceil = 2
        assert_eq!(estimate_tokens("hello"), 2);
    }

    #[test]
    fn test_estimate_non_ascii() {
        // Each CJK char is 1 token
        let cjk = "你好世界";
        assert_eq!(estimate_tokens(cjk), 4);
    }

    #[test]
    fn test_estimate_mixed() {
        // "hello世界" = 5 ascii + 2 non-ascii = ceil(5/4) + 2 = 2 + 2 = 4
        assert_eq!(estimate_tokens("hello世界"), 4);
    }

    #[test]
    fn test_estimate_text_part() {
        let part = ContentPart::Text {
            text: "hello".to_string(),
        };
        assert_eq!(estimate_tokens_for_content_part(&part), 2);
    }

    #[test]
    fn test_estimate_media_part() {
        let part = ContentPart::ImageUrl {
            image_url: super::super::message::ImageUrlValue {
                url: "https://example.com/img.png".to_string(),
                id: None,
            },
        };
        assert_eq!(estimate_tokens_for_content_part(&part), MEDIA_TOKEN_ESTIMATE);
    }

    #[test]
    fn test_estimate_message() {
        let msg = create_user_message("hello");
        assert!(estimate_tokens_for_message(&msg) > 0);
    }

    #[test]
    fn test_estimate_tool() {
        let tool = Tool::new("read", "Read a file", serde_json::json!({"type": "object"}));
        assert!(estimate_tokens_for_tool(&tool) > 0);
    }
}