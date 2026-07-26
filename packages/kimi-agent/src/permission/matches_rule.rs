/// DSL parser for PermissionRule `pattern` strings and rule matching.
///
/// Mirrors the TS `packages/agent-core/src/agent/permission/matches-rule.ts`.
///
/// Grammar:
///   pattern    := toolName ( "(" argPattern ")" )?
///   toolName   := identifier characters (e.g. `Bash`, `mcp__github__*`)
///   argPattern := any string interpreted only by a tool-provided matcher

use crate::permission::types::{
    GlobPattern, ParsedPattern, PermissionRule, RuleMatch, RuleMatchStrategy,
};

/// Parse a DSL pattern. Returns an error on malformed input.
pub fn parse_pattern(pattern: &str) -> Result<ParsedPattern, String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err("permission pattern: empty string".into());
    }

    let open_idx = match trimmed.find('(') {
        Some(idx) => idx,
        None => {
            return Ok(ParsedPattern {
                tool_name: trimmed.to_string(),
                arg_pattern: None,
            });
        }
    };

    if !trimmed.ends_with(')') {
        return Err(format!(
            "permission pattern: missing closing paren in \"{}\"",
            pattern
        ));
    }

    let tool_name = trimmed[..open_idx].to_string();
    let arg_pattern = trimmed[open_idx + 1..trimmed.len() - 1].to_string();

    if tool_name.is_empty() {
        return Err(format!(
            "permission pattern: empty tool name in \"{}\"",
            pattern
        ));
    }

    if arg_pattern.is_empty() {
        return Ok(ParsedPattern {
            tool_name,
            arg_pattern: None,
        });
    }

    Ok(ParsedPattern {
        tool_name,
        arg_pattern: Some(arg_pattern),
    })
}

/// Input for matching a permission rule.
pub struct RuleMatchInput {
    pub rule: PermissionRule,
    pub tool_name: String,
    /// Whether the tool has a `matches_rule` callback that can match arg patterns.
    pub has_matches_rule: bool,
}

/// Match a permission rule against a tool call.
pub fn match_permission_rule(input: &RuleMatchInput) -> Option<RuleMatch> {
    let parsed = parse_pattern(&input.rule.pattern).ok()?;

    // Match tool name (support wildcard `*` and glob patterns)
    if parsed.tool_name != "*" {
        let glob = GlobPattern::new(&parsed.tool_name);
        if !glob.matches(&input.tool_name) {
            return None;
        }
    }

    let has_rule_args = parsed.arg_pattern.is_some();

    if !has_rule_args {
        return Some(RuleMatch {
            rule: input.rule.clone(),
            strategy: RuleMatchStrategy::ToolNameOnly,
            has_rule_args: false,
        });
    }

    // If the rule has args, we need the tool's matches_rule callback to match.
    // Since we can't call a JS callback from Rust, we check if the tool
    // provides a matches_rule. If not, we match by name only.
    if input.has_matches_rule {
        // For now, we match by name+arg presence. The actual arg matching
        // is delegated to the JS host via the permission callback.
        Some(RuleMatch {
            rule: input.rule.clone(),
            strategy: RuleMatchStrategy::MatchesRule,
            has_rule_args: true,
        })
    } else {
        // No matches_rule available — match by name only
        Some(RuleMatch {
            rule: input.rule.clone(),
            strategy: RuleMatchStrategy::ToolNameOnly,
            has_rule_args: true,
        })
    }
}

/// Check if a scope is a user-configured scope.
pub fn is_user_configured_scope(scope: &str) -> bool {
    matches!(scope, "turn-override" | "project" | "user")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::types::*;

    #[test]
    fn test_parse_pattern_bare_tool() {
        let parsed = parse_pattern("Write").unwrap();
        assert_eq!(parsed.tool_name, "Write");
        assert!(parsed.arg_pattern.is_none());
    }

    #[test]
    fn test_parse_pattern_with_args() {
        let parsed = parse_pattern("Read(/etc/**)").unwrap();
        assert_eq!(parsed.tool_name, "Read");
        assert_eq!(parsed.arg_pattern.unwrap(), "/etc/**");
    }

    #[test]
    fn test_parse_pattern_wildcard_tool() {
        let parsed = parse_pattern("mcp__github__*").unwrap();
        assert_eq!(parsed.tool_name, "mcp__github__*");
        assert!(parsed.arg_pattern.is_none());
    }

    #[test]
    fn test_parse_pattern_bash_exclude() {
        let parsed = parse_pattern("Bash(!rm *)").unwrap();
        assert_eq!(parsed.tool_name, "Bash");
        assert_eq!(parsed.arg_pattern.unwrap(), "!rm *");
    }

    #[test]
    fn test_parse_pattern_empty() {
        assert!(parse_pattern("").is_err());
    }

    #[test]
    fn test_parse_pattern_missing_paren() {
        assert!(parse_pattern("Read(/etc").is_err());
    }

    #[test]
    fn test_parse_pattern_empty_tool_name() {
        assert!(parse_pattern("(/etc/**)").is_err());
    }

    #[test]
    fn test_parse_pattern_empty_args() {
        let parsed = parse_pattern("Write()").unwrap();
        assert_eq!(parsed.tool_name, "Write");
        assert!(parsed.arg_pattern.is_none());
    }

    #[test]
    fn test_match_rule_exact_name() {
        let rule = PermissionRule {
            decision: PermissionRuleDecision::Allow,
            scope: PermissionRuleScope::User,
            pattern: "Read".into(),
            reason: None,
        };
        let input = RuleMatchInput {
            rule,
            tool_name: "Read".into(),
            has_matches_rule: false,
        };
        let result = match_permission_rule(&input);
        assert!(result.is_some());
        let m = result.unwrap();
        assert_eq!(m.strategy, RuleMatchStrategy::ToolNameOnly);
    }

    #[test]
    fn test_match_rule_wildcard() {
        let rule = PermissionRule {
            decision: PermissionRuleDecision::Deny,
            scope: PermissionRuleScope::User,
            pattern: "mcp__*".into(),
            reason: None,
        };
        let input = RuleMatchInput {
            rule,
            tool_name: "mcp__github__list".into(),
            has_matches_rule: false,
        };
        let result = match_permission_rule(&input);
        assert!(result.is_some());
    }

    #[test]
    fn test_match_rule_no_match() {
        let rule = PermissionRule {
            decision: PermissionRuleDecision::Allow,
            scope: PermissionRuleScope::User,
            pattern: "Write".into(),
            reason: None,
        };
        let input = RuleMatchInput {
            rule,
            tool_name: "Read".into(),
            has_matches_rule: false,
        };
        let result = match_permission_rule(&input);
        assert!(result.is_none());
    }

    #[test]
    fn test_match_rule_star_wildcard() {
        let rule = PermissionRule {
            decision: PermissionRuleDecision::Allow,
            scope: PermissionRuleScope::User,
            pattern: "*".into(),
            reason: None,
        };
        let input = RuleMatchInput {
            rule,
            tool_name: "Anything".into(),
            has_matches_rule: false,
        };
        let result = match_permission_rule(&input);
        assert!(result.is_some());
    }

    #[test]
    fn test_is_user_configured_scope() {
        assert!(is_user_configured_scope("turn-override"));
        assert!(is_user_configured_scope("project"));
        assert!(is_user_configured_scope("user"));
        assert!(!is_user_configured_scope("session-runtime"));
    }
}