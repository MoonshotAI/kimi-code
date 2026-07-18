//! Permission rule DSL parser — pure computation.
//!
//! Ported from `packages/agent-core/src/agent/permission/matches-rule.ts`.
use napi_derive::napi;

/// Parsed permission rule pattern.
#[napi(object)]
pub struct ParsedPattern {
    pub tool_name: String,
    pub arg_pattern: Option<String>,
}

/// Parse a permission rule DSL pattern.
///
/// Grammar: `toolName` or `toolName(argPattern)`.
/// Returns JSON `{"toolName":"...","argPattern":...}` or `"ERROR: ..."` on failure.
#[napi]
pub fn native_parse_permission_pattern(pattern: String) -> String {
    match parse_pattern(&pattern) {
        Ok(p) => serde_json::json!({
            "toolName": p.tool_name,
            "argPattern": p.arg_pattern,
        })
        .to_string(),
        Err(e) => format!("ERROR: {e}"),
    }
}

fn parse_pattern(pattern: &str) -> Result<ParsedPattern, String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err("permission pattern: empty string".to_string());
    }

    let Some(open_idx) = trimmed.find('(') else {
        return Ok(ParsedPattern {
            tool_name: trimmed.to_string(),
            arg_pattern: None,
        });
    };

    if !trimmed.ends_with(')') {
        return Err(format!(
            "permission pattern: missing closing paren in \"{pattern}\""
        ));
    }

    let tool_name = trimmed[..open_idx].to_string();
    let arg = &trimmed[open_idx + 1..trimmed.len() - 1];

    if tool_name.is_empty() {
        return Err(format!(
            "permission pattern: empty tool name in \"{pattern}\""
        ));
    }

    if arg.is_empty() {
        return Ok(ParsedPattern {
            tool_name,
            arg_pattern: None,
        });
    }

    Ok(ParsedPattern {
        tool_name,
        arg_pattern: Some(arg.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_tool_name() {
        let result = parse_pattern("Write").unwrap();
        assert_eq!(result.tool_name, "Write");
        assert_eq!(result.arg_pattern, None);
    }

    #[test]
    fn test_parse_with_args() {
        let result = parse_pattern("Read(/etc/**)").unwrap();
        assert_eq!(result.tool_name, "Read");
        assert_eq!(result.arg_pattern, Some("/etc/**".to_string()));
    }

    #[test]
    fn test_parse_with_complex_args() {
        let result = parse_pattern("Bash(!rm *)").unwrap();
        assert_eq!(result.tool_name, "Bash");
        assert_eq!(result.arg_pattern, Some("!rm *".to_string()));
    }

    #[test]
    fn test_parse_mcp_tool() {
        let result = parse_pattern("mcp__github__*").unwrap();
        assert_eq!(result.tool_name, "mcp__github__*");
        assert_eq!(result.arg_pattern, None);
    }

    #[test]
    fn test_parse_empty_args_absorbed() {
        let result = parse_pattern("Tool()").unwrap();
        assert_eq!(result.tool_name, "Tool");
        assert_eq!(result.arg_pattern, None);
    }

    #[test]
    fn test_parse_empty_pattern_fails() {
        assert!(parse_pattern("").is_err());
        assert!(parse_pattern("   ").is_err());
    }

    #[test]
    fn test_parse_missing_paren_fails() {
        assert!(parse_pattern("Read(/etc").is_err());
    }

    #[test]
    fn test_parse_empty_tool_name_fails() {
        assert!(parse_pattern("(/etc/**)").is_err());
    }

    #[test]
    fn test_native_returns_json() {
        let json_str = native_parse_permission_pattern("Read(/etc/**)".into());
        assert!(json_str.contains("\"toolName\":\"Read\""));
        assert!(json_str.contains("\"argPattern\":\"/etc/**\""));
    }

    #[test]
    fn test_native_returns_error() {
        let result = native_parse_permission_pattern("".into());
        assert!(result.starts_with("ERROR:"));
    }
}
