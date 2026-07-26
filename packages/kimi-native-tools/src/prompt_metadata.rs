/// Prompt metadata — pure helpers for session metadata.
///
/// Pure functions for prompt metadata extraction and sanitization.
/// The TS side retains event publishing and metadata persistence.
///
/// Corresponds to `packages/agent-core-v2/src/agent/rpc/prompt-metadata.ts`.
use napi_derive::napi;

const MAX_TITLE_LENGTH: i32 = 200;
const MAX_LAST_PROMPT_LENGTH: i32 = 4000;

/// Truncate text to title length.
#[napi]
pub fn native_title_from_prompt_metadata_text(text: String) -> String {
    let end = (text.len() as i32).min(MAX_TITLE_LENGTH);
    text[..end as usize].to_string()
}

/// Extract text from a content part for metadata.
/// Returns the text string, or None if no text.
#[napi]
pub fn native_prompt_part_text(part_json: String) -> Option<String> {
    let part: serde_json::Value =
        serde_json::from_str(&part_json).unwrap_or(serde_json::Value::Null);
    let type_str = part.get("type").and_then(|t| t.as_str());
    match type_str {
        Some("text") => {
            let text = part.get("text").and_then(|t| t.as_str()).unwrap_or("");
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        }
        Some("image_url") => Some("[image]".to_string()),
        Some("audio_url") => Some("[audio]".to_string()),
        Some("video_url") => Some("[video]".to_string()),
        Some("think") => None,
        _ => None,
    }
}

/// Extract prompt metadata text from content parts.
/// parts_json: JSON array of ContentPart
/// Returns text string, or None.
#[napi]
pub fn native_prompt_metadata_text_from_content_parts(parts_json: String) -> Option<String> {
    let parts: Vec<serde_json::Value> =
        serde_json::from_str(&parts_json).unwrap_or_default();

    let mut texts: Vec<String> = Vec::new();
    for part in &parts {
        let part_json = serde_json::to_string(part).unwrap_or_default();
        if let Some(text) = native_prompt_part_text(part_json) {
            texts.push(text);
        }
    }

    let joined = texts.join("\n");
    native_sanitize_and_truncate_prompt_text(joined, MAX_LAST_PROMPT_LENGTH)
}

/// Format prompt metadata text from a skill activation.
/// name: skill name
/// args: optional skill args
#[napi]
pub fn native_prompt_metadata_text_from_skill(name: String, args: Option<String>) -> Option<String> {
    let args_trimmed = args.as_deref().map(|s| s.trim()).unwrap_or("");
    let text = if args_trimmed.is_empty() {
        format!("/{}", name)
    } else {
        format!("/{} {}", name, args_trimmed)
    };
    native_sanitize_and_truncate_prompt_text(text, MAX_LAST_PROMPT_LENGTH)
}

/// Format prompt metadata text from a plugin command.
#[napi]
pub fn native_prompt_metadata_text_from_plugin_command(
    plugin_id: String,
    command_name: String,
    args: Option<String>,
) -> Option<String> {
    let args_trimmed = args.as_deref().map(|s| s.trim()).unwrap_or("");
    let command = format!("/{}:{}", plugin_id, command_name);
    let text = if args_trimmed.is_empty() {
        command
    } else {
        format!("{} {}", command, args_trimmed)
    };
    native_sanitize_and_truncate_prompt_text(text, MAX_LAST_PROMPT_LENGTH)
}

/// Check if a title is untitled.
#[napi]
pub fn native_is_untitled(title: Option<String>) -> bool {
    match title {
        None => true,
        Some(t) => t.trim().is_empty() || t == "New Session",
    }
}

/// Sanitize and truncate prompt text.
/// Removes private keys, tokens, API keys, and other secrets.
#[napi]
pub fn native_sanitize_and_truncate_prompt_text(text: String, max_length: i32) -> Option<String> {
    // Simple sanitization (Rust regex would be more thorough, but for performance
    // we do basic replacements that match the TS patterns)
    let mut result = text;

    // Remove private keys (simple heuristic)
    // This is a best-effort approximation of the TS regex patterns
    let lines: Vec<&str> = result.lines().collect();
    let mut sanitized_lines: Vec<String> = Vec::new();
    let mut in_private_key = false;
    for line in &lines {
        if line.starts_with("-----BEGIN ") && line.contains("PRIVATE KEY-----") {
            in_private_key = true;
            sanitized_lines.push("[redacted]".to_string());
            continue;
        }
        if in_private_key {
            if line.starts_with("-----END ") && line.contains("PRIVATE KEY-----") {
                in_private_key = false;
            }
            continue;
        }
        // Redact bearer tokens
        let line = regex_replace(&line, "(?i)\\b(authorization)\\s*:\\s*bearer\\s+\\S+", "$1: Bearer [redacted]");
        // Redact API keys, tokens, secrets
        let line = regex_replace(&line, "(?i)\\b(api[_-]?key|token|secret|password|passwd|pwd)\\b\\s*[:=]\\s*(\"[^\"]*\"|'[^']*'|\\S+)", "$1=[redacted]");
        // Redact sk- tokens
        let line = regex_replace(&line, "\\bsk-[A-Za-z0-9_-]{12,}\\b", "[redacted]");
        // Redact GitHub tokens
        let line = regex_replace(&line, "\\b(gh[opu]_|github_pat_)[A-Za-z0-9_]{20,}\\b", "[redacted]");
        sanitized_lines.push(line);
    }

    result = sanitized_lines.join("\n");

    // Replace control characters with space
    result = result.chars()
        .map(|c| if c.is_control() && c != '\n' { ' ' } else { c })
        .collect::<String>();

    // Collapse whitespace
    let mut collapsed = String::with_capacity(result.len());
    let mut prev_space = false;
    for c in result.chars() {
        if c.is_whitespace() {
            if !prev_space {
                collapsed.push(' ');
                prev_space = true;
            }
        } else {
            collapsed.push(c);
            prev_space = false;
        }
    }

    result = collapsed.trim().to_string();
    if result.is_empty() {
        return None;
    }

    let end = (result.len() as i32).min(max_length);
    Some(result[..end as usize].to_string())
}

/// Simple regex replacement helper.
fn regex_replace(text: &str, pattern: &str, replacement: &str) -> String {
    if let Ok(re) = regex::Regex::new(pattern) {
        re.replace_all(text, replacement).to_string()
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_title_truncation() {
        let text = "a".repeat(300);
        let title = native_title_from_prompt_metadata_text(text);
        assert_eq!(title.len(), 200);
    }

    #[test]
    fn test_prompt_part_text() {
        let part = serde_json::json!({"type": "text", "text": "hello"});
        assert_eq!(native_prompt_part_text(part.to_string()), Some("hello".to_string()));

        let part = serde_json::json!({"type": "image_url", "imageUrl": {"url": "x"}});
        assert_eq!(native_prompt_part_text(part.to_string()), Some("[image]".to_string()));

        let part = serde_json::json!({"type": "think"});
        assert_eq!(native_prompt_part_text(part.to_string()), None);
    }

    #[test]
    fn test_from_content_parts() {
        let parts = serde_json::json!([
            {"type": "text", "text": "hello"},
            {"type": "image_url", "imageUrl": {"url": "x"}},
        ]);
        let result = native_prompt_metadata_text_from_content_parts(parts.to_string());
        assert!(result.unwrap().contains("hello"));
    }

    #[test]
    fn test_from_skill() {
        let result = native_prompt_metadata_text_from_skill("test".to_string(), Some("args".to_string()));
        assert_eq!(result, Some("/test args".to_string()));
    }

    #[test]
    fn test_is_untitled() {
        assert!(native_is_untitled(None));
        assert!(native_is_untitled(Some("".to_string())));
        assert!(native_is_untitled(Some("New Session".to_string())));
        assert!(!native_is_untitled(Some("My Session".to_string())));
    }

    #[test]
    fn test_sanitize_truncate() {
        let text = "hello world".to_string();
        let result = native_sanitize_and_truncate_prompt_text(text, 100);
        assert_eq!(result, Some("hello world".to_string()));
    }

    #[test]
    fn test_sanitize_private_key() {
        let text = "-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----".to_string();
        let result = native_sanitize_and_truncate_prompt_text(text, 1000);
        let r = result.unwrap_or_default();
        assert!(r.contains("[redacted]"), "private key should be redacted: {}", r);
    }

    #[test]
    fn test_from_plugin_command() {
        let result = native_prompt_metadata_text_from_plugin_command(
            "git".to_string(), "commit".to_string(), Some("msg".to_string()),
        );
        assert_eq!(result, Some("/git:commit msg".to_string()));
    }
}