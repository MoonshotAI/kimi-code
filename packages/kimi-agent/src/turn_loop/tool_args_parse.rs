/// Tool call argument parsing.
///
/// Corresponds to `packages/agent-core/src/loop/tool-args-parse.ts`.

use serde_json::Value;

/// Result of parsing a tool call's arguments.
pub struct ParsedToolArgs {
    pub data: Value,
    pub parse_failed: bool,
    pub error: Option<String>,
}

/// Parse tool call arguments from a string into a JSON value.
pub fn parse_tool_call_arguments(arguments: &str) -> ParsedToolArgs {
    match serde_json::from_str::<Value>(arguments) {
        Ok(data) => ParsedToolArgs {
            data,
            parse_failed: false,
            error: None,
        },
        Err(e) => ParsedToolArgs {
            data: Value::Null,
            parse_failed: true,
            error: Some(e.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_valid_json() {
        let result = parse_tool_call_arguments(r#"{"path": "/a.txt"}"#);
        assert!(!result.parse_failed);
        assert!(result.error.is_none());
        assert_eq!(result.data["path"], "/a.txt");
    }

    #[test]
    fn test_parse_invalid_json() {
        let result = parse_tool_call_arguments(r#"{invalid}"#);
        assert!(result.parse_failed);
        assert!(result.error.is_some());
    }

    #[test]
    fn test_parse_empty_string() {
        let result = parse_tool_call_arguments("");
        assert!(result.parse_failed);
    }

    #[test]
    fn test_parse_null() {
        let result = parse_tool_call_arguments("null");
        assert!(!result.parse_failed);
        assert_eq!(result.data, Value::Null);
    }
}