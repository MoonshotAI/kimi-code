/// User-configured rule policies.
///
/// - user-configured-deny: User-configured deny rules.
/// - user-configured-allow: User-configured allow rules.
/// - user-configured-ask: User-configured ask rules.

use crate::permission::matches_rule::{
    is_user_configured_scope, match_permission_rule, rule_match_input,
};
use crate::permission::state::PermissionState;
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
            if match_permission_rule(&rule_match_input(rule.clone(), context)).is_some() {
                return Some(rule.clone());
            }
        }
        None
    }
}

/// User-configured deny rules.
pub struct UserConfiguredDenyPermissionPolicy {
    state: PermissionState,
}

impl UserConfiguredDenyPermissionPolicy {
    pub fn new(state: PermissionState) -> Self {
        Self { state }
    }
}

impl PermissionPolicy for UserConfiguredDenyPermissionPolicy {
    fn name(&self) -> &str {
        "user-configured-deny"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        let rules = self.state.rules();
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
pub struct UserConfiguredAllowPermissionPolicy {
    state: PermissionState,
}

impl UserConfiguredAllowPermissionPolicy {
    pub fn new(state: PermissionState) -> Self {
        Self { state }
    }
}

impl PermissionPolicy for UserConfiguredAllowPermissionPolicy {
    fn name(&self) -> &str {
        "user-configured-allow"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        let rules = self.state.rules();
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
pub struct UserConfiguredAskPermissionPolicy {
    state: PermissionState,
}

impl UserConfiguredAskPermissionPolicy {
    pub fn new(state: PermissionState) -> Self {
        Self { state }
    }
}

impl PermissionPolicy for UserConfiguredAskPermissionPolicy {
    fn name(&self) -> &str {
        "user-configured-ask"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        let rules = self.state.rules();
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