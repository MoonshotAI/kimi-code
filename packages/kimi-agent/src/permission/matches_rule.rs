/// DSL parser for PermissionRule `pattern` strings and rule matching.
///
/// Mirrors the TS `packages/agent-core/src/agent/permission/matches-rule.ts`.
///
/// Grammar:
///   pattern    := toolName ( "(" argPattern ")" )?
///   toolName   := identifier characters (e.g. `Bash`, `mcp__github__*`)
///   argPattern := any string interpreted only by a tool-provided matcher

use crate::permission::types::{
    GlobPattern, ParsedPattern, PermissionPolicyContext, PermissionRule, RuleMatch,
    RuleMatchStrategy,
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
    /// Subject for arg-pattern matching (for Bash: the command string).
    pub subject: Option<String>,
}

impl RuleMatchInput {
    /// Build a name-only match input (no command-level subject).
    pub fn new(rule: PermissionRule, tool_name: String) -> Self {
        Self {
            rule,
            tool_name,
            has_matches_rule: false,
            subject: None,
        }
    }
}

/// Build the rule-match input for a tool call from a policy context.
///
/// Bash rules carrying an argPattern get command-level matching (the tool's
/// `matchesRule` in TS terms): `Bash(ls *)` only matches commands that glob
/// `ls *`. Other tools have no native arg matcher and keep the name-only +
/// host-verification behavior.
pub fn rule_match_input(
    rule: PermissionRule,
    context: &PermissionPolicyContext,
) -> RuleMatchInput {
    let subject = bash_command_from_args(&context.args);
    RuleMatchInput {
        rule,
        tool_name: context.tool_name.clone(),
        has_matches_rule: context.tool_name == "Bash" && subject.is_some(),
        subject: subject.map(String::from),
    }
}

fn bash_command_from_args(args: &serde_json::Value) -> Option<&str> {
    crate::tools::bash::command_from_args(args)
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
    if input.has_matches_rule {
        // Command-level matching (Bash): the argPattern must actually match
        // the subject command; a miss means the rule does not apply.
        if let Some(subject) = input.subject.as_deref() {
            let arg_pattern = parsed.arg_pattern.as_deref().unwrap_or("");
            if crate::tools::bash::matches_command_rule(arg_pattern, subject) {
                return Some(RuleMatch {
                    rule: input.rule.clone(),
                    strategy: RuleMatchStrategy::MatchesRule,
                    has_rule_args: true,
                });
            }
            return None;
        }
        // No subject available — match by name, deferring arg-level
        // verification to the host (same contract as the no-matches_rule case).
        return Some(RuleMatch {
            rule: input.rule.clone(),
            strategy: RuleMatchStrategy::MatchesRule,
            has_rule_args: true,
        });
    }

    // No matches_rule available — match by name only; the host re-verifies
    // the args via the permission callback.
    Some(RuleMatch {
        rule: input.rule.clone(),
        strategy: RuleMatchStrategy::ToolNameOnly,
        has_rule_args: true,
    })
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
        let input = RuleMatchInput::new(rule, "Read".into());
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
        let input = RuleMatchInput::new(rule, "mcp__github__list".into());
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
        let input = RuleMatchInput::new(rule, "Read".into());
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
        let input = RuleMatchInput::new(rule, "Anything".into());
        let result = match_permission_rule(&input);
        assert!(result.is_some());
    }

    #[test]
    fn test_match_bash_rule_at_command_level() {
        let rule = PermissionRule {
            decision: PermissionRuleDecision::Allow,
            scope: PermissionRuleScope::User,
            pattern: "Bash(ls *)".into(),
            reason: None,
        };
        // `ls -la` globs `ls *` → matches (MatchesRule strategy).
        let input = RuleMatchInput {
            rule: rule.clone(),
            tool_name: "Bash".into(),
            has_matches_rule: true,
            subject: Some("ls -la".into()),
        };
        let m = match_permission_rule(&input).expect("ls -la must match Bash(ls *)");
        assert_eq!(m.strategy, RuleMatchStrategy::MatchesRule);
        assert!(m.has_rule_args);
        // `rm -rf /` does not glob `ls *` → the rule does not apply, so a
        // tool-name-only match can no longer slip a non-ls command through.
        let input = RuleMatchInput {
            rule,
            tool_name: "Bash".into(),
            has_matches_rule: true,
            subject: Some("rm -rf /".into()),
        };
        assert!(match_permission_rule(&input).is_none());
    }

    #[test]
    fn test_match_bash_negated_rule() {
        let rule = PermissionRule {
            decision: PermissionRuleDecision::Allow,
            scope: PermissionRuleScope::User,
            pattern: "Bash(!rm *)".into(),
            reason: None,
        };
        // `!rm *` matches everything except `rm *` commands.
        let input = RuleMatchInput {
            rule: rule.clone(),
            tool_name: "Bash".into(),
            has_matches_rule: true,
            subject: Some("ls -la".into()),
        };
        assert!(match_permission_rule(&input).is_some());
        let input = RuleMatchInput {
            rule,
            tool_name: "Bash".into(),
            has_matches_rule: true,
            subject: Some("rm -f file.txt".into()),
        };
        assert!(match_permission_rule(&input).is_none());
    }

    #[test]
    fn test_rule_match_input_wires_bash_subject() {
        use crate::permission::types::{PermissionMode, PermissionPolicyContext};
        let rule = PermissionRule {
            decision: PermissionRuleDecision::Allow,
            scope: PermissionRuleScope::User,
            pattern: "Bash(ls *)".into(),
            reason: None,
        };
        let ctx = PermissionPolicyContext {
            tool_name: "Bash".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({ "command": "ls -la" }),
            mode: PermissionMode::Manual,
            r#type: None,
        };
        let input = rule_match_input(rule, &ctx);
        assert!(input.has_matches_rule);
        assert_eq!(input.subject.as_deref(), Some("ls -la"));
        assert!(match_permission_rule(&input).is_some());

        // A Bash call without a command keeps no command-level matcher.
        let ctx = PermissionPolicyContext {
            tool_name: "Bash".into(),
            tool_call_id: "2".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Manual,
            r#type: None,
        };
        let input = rule_match_input(
            PermissionRule {
                decision: PermissionRuleDecision::Allow,
                scope: PermissionRuleScope::User,
                pattern: "Bash(ls *)".into(),
                reason: None,
            },
            &ctx,
        );
        assert!(!input.has_matches_rule);
    }

    #[test]
    fn test_is_user_configured_scope() {
        assert!(is_user_configured_scope("turn-override"));
        assert!(is_user_configured_scope("project"));
        assert!(is_user_configured_scope("user"));
        assert!(!is_user_configured_scope("session-runtime"));
    }
}