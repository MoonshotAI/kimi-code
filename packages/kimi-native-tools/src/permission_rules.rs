/// Permission rules pattern matching — pure functions for v2 migration.
///
/// Pure pattern parsing and matching functions. The TS side retains
/// service orchestration, DI registration, and wire integration.
///
/// Corresponds to `packages/agent-core-v2/src/agent/permissionRules/matchesRule.ts`.
use napi_derive::napi;

/// Parse a permission pattern string.
/// Returns JSON: { toolName: string, argPattern?: string }
/// Throws an error (via empty string return) on invalid input.
pub fn native_parse_permission_pattern(pattern: String) -> String {
    let trimmed = pattern.trim().to_string();
    if trimmed.is_empty() {
        return String::new(); // error: empty string
    }

    let open_idx = trimmed.find('(');
    match open_idx {
        None => {
            // No parens → tool name only
            return serde_json::json!({"toolName": trimmed}).to_string();
        }
        Some(open) => {
            if !trimmed.ends_with(')') {
                return String::new(); // error: missing closing paren
            }
            let tool_name = &trimmed[..open];
            let arg_pattern = &trimmed[open + 1..trimmed.len() - 1];
            if tool_name.is_empty() {
                return String::new(); // error: empty tool name
            }
            let result = if arg_pattern.is_empty() {
                serde_json::json!({"toolName": tool_name})
            } else {
                serde_json::json!({
                    "toolName": tool_name,
                    "argPattern": arg_pattern,
                })
            };
            return result.to_string();
        }
    }
}

/// Match a permission rule against a tool name and execution.
/// rule_json: { pattern: string, ... }
/// tool_name: the tool name to match
/// has_matches_rule: whether the execution has a matchesRule callback
/// arg_pattern_match: whether the arg pattern matches (pre-computed by TS side)
///
/// Returns JSON: { matched: bool, strategy?: string, hasRuleArgs?: bool }
#[napi]
pub fn native_match_permission_rule(
    rule_json: String,
    tool_name: String,
    has_matches_rule: bool,
    arg_pattern_match: Option<bool>,
) -> String {
    let rule: serde_json::Value =
        serde_json::from_str(&rule_json).unwrap_or(serde_json::Value::Null);

    let pattern = match rule.get("pattern").and_then(|p| p.as_str()) {
        Some(p) => p.to_string(),
        None => {
            return serde_json::json!({"matched": false}).to_string();
        }
    };

    let parsed = native_parse_permission_pattern(pattern);
    if parsed.is_empty() {
        return serde_json::json!({"matched": false}).to_string();
    }

    let parsed_val: serde_json::Value =
        serde_json::from_str(&parsed).unwrap_or(serde_json::Value::Null);

    let parsed_tool_name = parsed_val
        .get("toolName")
        .and_then(|t| t.as_str())
        .unwrap_or("");

    // Check tool name match
    if parsed_tool_name != "*" && parsed_tool_name != tool_name {
        return serde_json::json!({"matched": false}).to_string();
    }

    let arg_pattern = parsed_val
        .get("argPattern")
        .and_then(|a| a.as_str());

    match arg_pattern {
        None => {
            // No arg pattern → tool name only match
            return serde_json::json!({
                "matched": true,
                "strategy": "tool_name_only",
                "hasRuleArgs": false,
            }).to_string();
        }
        Some(_) => {
            // Has arg pattern → check matches_rule
            let matched = arg_pattern_match == Some(true) && has_matches_rule;
            if matched {
                return serde_json::json!({
                    "matched": true,
                    "strategy": "matches_rule",
                    "hasRuleArgs": true,
                }).to_string();
            }
            return serde_json::json!({"matched": false}).to_string();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_pattern_tool_name_only() {
        let result = native_parse_permission_pattern("read".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["toolName"], "read");
        assert!(parsed.get("argPattern").is_none());
    }

    #[test]
    fn test_parse_pattern_with_args() {
        let result = native_parse_permission_pattern("read(/a.txt)".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["toolName"], "read");
        assert_eq!(parsed["argPattern"], "/a.txt");
    }

    #[test]
    fn test_parse_pattern_empty_args() {
        let result = native_parse_permission_pattern("read()".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["toolName"], "read");
        assert!(parsed.get("argPattern").is_none());
    }

    #[test]
    fn test_parse_pattern_empty_string() {
        let result = native_parse_permission_pattern("".to_string());
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_pattern_missing_paren() {
        let result = native_parse_permission_pattern("read(/a.txt".to_string());
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_pattern_whitespace() {
        let result = native_parse_permission_pattern("  read  ".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["toolName"], "read");
    }

    #[test]
    fn test_match_permission_rule_tool_name() {
        let rule = serde_json::json!({"pattern": "read"});
        let result = native_match_permission_rule(
            rule.to_string(),
            "read".to_string(),
            false,
            None,
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["matched"], true);
        assert_eq!(parsed["strategy"], "tool_name_only");
    }

    #[test]
    fn test_match_permission_rule_wildcard() {
        let rule = serde_json::json!({"pattern": "*"});
        let result = native_match_permission_rule(
            rule.to_string(),
            "anything".to_string(),
            false,
            None,
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["matched"], true);
    }

    #[test]
    fn test_match_permission_rule_no_match() {
        let rule = serde_json::json!({"pattern": "read"});
        let result = native_match_permission_rule(
            rule.to_string(),
            "write".to_string(),
            false,
            None,
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["matched"], false);
    }

    #[test]
    fn test_match_permission_rule_with_args() {
        let rule = serde_json::json!({"pattern": "read(/a.txt)"});
        let result = native_match_permission_rule(
            rule.to_string(),
            "read".to_string(),
            true,
            Some(true),
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["matched"], true);
        assert_eq!(parsed["strategy"], "matches_rule");
    }

    #[test]
    fn test_match_permission_rule_args_not_matched() {
        let rule = serde_json::json!({"pattern": "read(/a.txt)"});
        let result = native_match_permission_rule(
            rule.to_string(),
            "read".to_string(),
            true,
            Some(false),
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["matched"], false);
    }

    #[test]
    fn test_match_permission_rule_wildcard_pattern() {
        let rule = serde_json::json!({"pattern": "read(*)"});
        let result = native_match_permission_rule(
            rule.to_string(),
            "read".to_string(),
            true,
            Some(true),
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["matched"], true);
    }

    #[test]
    fn test_match_permission_rule_glob_pattern() {
        // The native implementation matches exact tool names or `*` wildcard.
        // For glob patterns like `mcp__github__*`, the TS side handles the
        // glob matching and passes the resolved result.
        let rule = serde_json::json!({"pattern": "mcp__github__*"});
        let result = native_match_permission_rule(
            rule.to_string(),
            "mcp__github__list_issues".to_string(),
            false,
            None,
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        // `mcp__github__*` is not an exact match and not `*`, so it doesn't match
        assert_eq!(parsed["matched"], false);
    }

    #[test]
    fn test_match_permission_rule_deny_always() {
        let rule = serde_json::json!({"pattern": "Bash", "allow": false});
        let result = native_match_permission_rule(
            rule.to_string(),
            "Bash".to_string(),
            false,
            None,
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["matched"], true);
        // Plain tool name match returns "tool_name_only" strategy
        assert_eq!(parsed["strategy"], "tool_name_only");
    }

    #[test]
    fn test_parse_permission_pattern_with_parens() {
        let result = native_parse_permission_pattern("Read(/etc/**)".into());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["toolName"], "Read");
        assert_eq!(parsed["argPattern"], "/etc/**");
    }

    #[test]
    fn test_parse_permission_pattern_no_args() {
        let result = native_parse_permission_pattern("Write".into());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["toolName"], "Write");
        assert!(parsed.get("argPattern").is_none());
    }
}