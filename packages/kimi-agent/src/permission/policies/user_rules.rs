/// User-configured rule policies.
///
/// - user-configured-deny: User-configured deny rules.
/// - user-configured-allow: User-configured allow rules.
/// - user-configured-ask: User-configured ask rules.

use crate::permission::matches_rule::{is_user_configured_scope, match_permission_rule, RuleMatchInput};
use crate::permission::types::{
    PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult, PermissionRule,
    PermissionRuleDecision, PermissionRuleScope,
};

/// Abstract base for user-configured permission policies.
struct UserConfiguredPermissionPolicy;

impl UserConfiguredPermissionPolicy {
    fn first_matching_rule(
        rules: &[PermissionRule],
        context: &PermissionPolicyContext,
        decision: PermissionRuleDecision,
    ) -> Option<PermissionRule> {
        for rule in rules {
            if !is_user_configured_scope(match rule.scope {
                PermissionRuleScope::TurnOverride => "turn-override",
                PermissionRuleScope::Project => "project",
                PermissionRuleScope::User => "user",
                _ => "session-runtime",
            }) {
                continue;
            }
            if rule.decision != decision {
                continue;
            }
            let input = RuleMatchInput {
                rule: rule.clone(),
                tool_name: context.tool_name.clone(),
                has_matches_rule: false,
            };
            if match_permission_rule(&input).is_some() {
                return Some(rule.clone());
            }
        }
        None
    }
}

/// User-configured deny rules.
pub struct UserConfiguredDenyPermissionPolicy;

impl PermissionPolicy for UserConfiguredDenyPermissionPolicy {
    fn name(&self) -> &str {
        "user-configured-deny"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        let rules: Vec<PermissionRule> = vec![]; // In production, gets from manager
        if UserConfiguredPermissionPolicy::first_matching_rule(
            &rules,
            context,
            PermissionRuleDecision::Deny,
        )
        .is_some()
        {
            Some(PermissionPolicyResult::Deny {
                reason: "Blocked by user-configured deny rule".into(),
            })
        } else {
            None
        }
    }
}

/// User-configured allow rules.
pub struct UserConfiguredAllowPermissionPolicy;

impl PermissionPolicy for UserConfiguredAllowPermissionPolicy {
    fn name(&self) -> &str {
        "user-configured-allow"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        let rules: Vec<PermissionRule> = vec![]; // In production, gets from manager
        if UserConfiguredPermissionPolicy::first_matching_rule(
            &rules,
            context,
            PermissionRuleDecision::Allow,
        )
        .is_some()
        {
            Some(PermissionPolicyResult::Approve)
        } else {
            None
        }
    }
}

/// User-configured ask rules.
pub struct UserConfiguredAskPermissionPolicy;

impl PermissionPolicy for UserConfiguredAskPermissionPolicy {
    fn name(&self) -> &str {
        "user-configured-ask"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        let rules: Vec<PermissionRule> = vec![]; // In production, gets from manager
        if UserConfiguredPermissionPolicy::first_matching_rule(
            &rules,
            context,
            PermissionRuleDecision::Ask,
        )
        .is_some()
        {
            Some(PermissionPolicyResult::Ask { resolve: None })
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_user_scope() {
        assert!(is_user_configured_scope("turn-override"));
        assert!(is_user_configured_scope("user"));
        assert!(is_user_configured_scope("project"));
    }
}