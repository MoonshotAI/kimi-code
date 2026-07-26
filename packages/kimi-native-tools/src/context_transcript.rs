/// Context transcript — pure helper functions for transcript reduction.
///
/// Pure utility functions. The TS side retains the stateful reducer.
///
/// Corresponds to `packages/agent-core-v2/src/agent/contextMemory/contextTranscript.ts`.
use napi_derive::napi;

/// Check if a value is context-message-like (has role: string, content: array).
#[napi]
pub fn native_is_context_message_like(value_json: String) -> bool {
    let value: serde_json::Value =
        serde_json::from_str(&value_json).unwrap_or(serde_json::Value::Null);
    if !value.is_object() || value.as_array().is_some() {
        return false;
    }
    let role = value.get("role").and_then(|r| r.as_str());
    let content = value.get("content").and_then(|c| c.as_array());
    role.is_some() && content.is_some()
}

/// Extract text from content parts (all text parts concatenated).
#[napi]
pub fn native_text_of_parts(content_json: String) -> String {
    let content: Vec<serde_json::Value> =
        serde_json::from_str(&content_json).unwrap_or_default();
    let mut text = String::new();
    for part in &content {
        if part.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                text.push_str(t);
            }
        }
    }
    text
}

/// Read a number field from a wire record.
/// record_json: JSON wire record
/// key: field name
/// Returns the number value, or undefined (JSON null) if not found.
#[napi]
pub fn native_read_number(record_json: String, key: String) -> Option<f64> {
    let record: serde_json::Value =
        serde_json::from_str(&record_json).unwrap_or(serde_json::Value::Null);
    record.get(&key).and_then(|v| v.as_f64())
}

/// Turn raw tool result output into ContentPart[].
/// output: string or array of ContentPart
/// Returns JSON array of ContentPart.
#[napi]
pub fn native_raw_tool_result_content(output_json: String) -> String {
    let output: serde_json::Value =
        serde_json::from_str(&output_json).unwrap_or(serde_json::Value::Null);

    let result = match &output {
        serde_json::Value::String(s) => {
            serde_json::json!([{"type": "text", "text": s}])
        }
        serde_json::Value::Array(arr) => {
            serde_json::json!(arr)
        }
        _ => serde_json::json!([]),
    };

    serde_json::to_string(&result).unwrap_or_else(|_| "[]".to_string())
}

/// Read compaction summary text from a wire record.
/// Returns the summary string, or empty string if not found.
#[napi]
pub fn native_read_compaction_summary_text(record_json: String) -> String {
    let record: serde_json::Value =
        serde_json::from_str(&record_json).unwrap_or(serde_json::Value::Null);

    // Try "summary" field first
    if let Some(summary) = record.get("summary") {
        if let Some(s) = summary.as_str() {
            return s.to_string();
        }
        if is_context_message_like_value(summary) {
            return text_of_parts_from_value(summary);
        }
    }

    // Try "contextSummary" field
    if let Some(cs) = record.get("contextSummary") {
        if let Some(s) = cs.as_str() {
            return s.to_string();
        }
    }

    String::new()
}

fn is_context_message_like_value(value: &serde_json::Value) -> bool {
    if !value.is_object() {
        return false;
    }
    let role = value.get("role").and_then(|r| r.as_str());
    let content = value.get("content").and_then(|c| c.as_array());
    role.is_some() && content.is_some()
}

fn text_of_parts_from_value(msg: &serde_json::Value) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_context_message_like() {
        assert!(native_is_context_message_like(
            r#"{"role":"user","content":[]}"#.to_string()
        ));
        assert!(!native_is_context_message_like(
            r#"{"role":"user"}"#.to_string()
        ));
        assert!(!native_is_context_message_like(
            r#"not an object"#.to_string()
        ));
    }

    #[test]
    fn test_text_of_parts() {
        let parts = serde_json::json!([
            {"type": "text", "text": "Hello "},
            {"type": "text", "text": "World"},
        ]);
        assert_eq!(native_text_of_parts(parts.to_string()), "Hello World");
    }

    #[test]
    fn test_raw_tool_result_string() {
        let result = native_raw_tool_result_content(r#""file content""#.to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed[0]["type"], "text");
        assert_eq!(parsed[0]["text"], "file content");
    }

    #[test]
    fn test_raw_tool_result_array() {
        let input = serde_json::json!([{"type": "text", "text": "hello"}]);
        let result = native_raw_tool_result_content(input.to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed[0]["text"], "hello");
    }

    #[test]
    fn test_read_compaction_summary_text() {
        let record = serde_json::json!({
            "type": "context.apply_compaction",
            "summary": "compacted 10 messages",
        });
        assert_eq!(
            native_read_compaction_summary_text(record.to_string()),
            "compacted 10 messages"
        );
    }

    #[test]
    fn test_read_compaction_summary_context_summary() {
        let record = serde_json::json!({
            "type": "context.apply_compaction",
            "contextSummary": "summary text",
        });
        assert_eq!(
            native_read_compaction_summary_text(record.to_string()),
            "summary text"
        );
    }

    #[test]
    fn test_read_number() {
        let record = serde_json::json!({"count": 42});
        assert_eq!(native_read_number(record.to_string(), "count".to_string()), Some(42.0));
        assert_eq!(native_read_number(record.to_string(), "missing".to_string()), None);
    }
}