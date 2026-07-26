/// PermissionManager — the permission decision engine.
///
/// Evaluates tool calls against a chain of permission policies.
/// The first policy that returns a result wins.

use crate::permission::policies::{
    default_policies::{
        DefaultToolApprovePermissionPolicy, DenyAllPermissionPolicy,
        FileAccessAskPermissionPolicy, GitCwdWriteApprovePermissionPolicy,
        GoalStartReviewAskPermissionPolicy, PreToolCallHookPermissionPolicy,
        SessionApprovalHistoryPermissionPolicy,
    },
    mode_policies::{
        AutoModeApprovePermissionPolicy, AutoModeAskUserQuestionDenyPermissionPolicy,
        YoloModeApprovePermissionPolicy,
    },
    plan_guard::{
        ExitPlanModeReviewAskPermissionPolicy, PlanModeGuardDenyPermissionPolicy,
        PlanModeToolApprovePermissionPolicy,
    },
    swarm_guard::{
        AgentSwarmExclusiveDenyPermissionPolicy, SwarmModeAgentDenyPermissionPolicy,
        SwarmModeAgentSwarmApprovePermissionPolicy,
    },
    user_rules::{
        UserConfiguredAllowPermissionPolicy, UserConfiguredAskPermissionPolicy,
        UserConfiguredDenyPermissionPolicy,
    },
};
use crate::permission::types::*;

/// The PermissionManager.
pub struct PermissionManager {
    /// Ordered list of permission policies.
    policies: Vec<Box<dyn PermissionPolicy>>,
    /// Current permission rules.
    rules: Vec<PermissionRule>,
    /// Current permission mode.
    mode: PermissionMode,
}

impl PermissionManager {
    /// Create a new PermissionManager with the default policy chain.
    pub fn new() -> Self {
        let policies: Vec<Box<dyn PermissionPolicy>> = vec![
            // 1. PreToolUse hook returned a block → deny
            Box::new(PreToolCallHookPermissionPolicy),
            // 2. AgentSwarm is batch-exclusive
            Box::new(AgentSwarmExclusiveDenyPermissionPolicy),
            // 3. Auto mode + AskUserQuestion → deny
            Box::new(AutoModeAskUserQuestionDenyPermissionPolicy),
            // 4. Plan mode: Write/Edit outside the plan file → deny
            Box::new(PlanModeGuardDenyPermissionPolicy),
            // 5. Swarm mode: Agent tool is not available
            Box::new(SwarmModeAgentDenyPermissionPolicy),
            // 6. User-configured deny rules
            Box::new(UserConfiguredDenyPermissionPolicy),
            // 7. Plan mode: specific tools are approved
            Box::new(PlanModeToolApprovePermissionPolicy),
            // 8. Swarm mode: AgentSwarm is approved
            Box::new(SwarmModeAgentSwarmApprovePermissionPolicy),
            // 9. User-configured allow rules
            Box::new(UserConfiguredAllowPermissionPolicy),
            // 10. Auto mode: approve all
            Box::new(AutoModeApprovePermissionPolicy),
            // 11. Yolo mode: approve all
            Box::new(YoloModeApprovePermissionPolicy),
            // 12. Session approval history
            Box::new(SessionApprovalHistoryPermissionPolicy),
            // 13. Sensitive file access → ask
            Box::new(FileAccessAskPermissionPolicy),
            // 14. Git working directory write → approve
            Box::new(GitCwdWriteApprovePermissionPolicy),
            // 15. Exit plan mode → ask for review
            Box::new(ExitPlanModeReviewAskPermissionPolicy),
            // 16. Goal start → ask for review
            Box::new(GoalStartReviewAskPermissionPolicy),
            // 17. User-configured ask rules
            Box::new(UserConfiguredAskPermissionPolicy),
            // 18. Default tool approval (let the manager's mode handle it)
            Box::new(DefaultToolApprovePermissionPolicy),
            // 19. Fallback ask
            // 20. Deny all (last resort)
            Box::new(DenyAllPermissionPolicy),
        ];

        Self {
            policies,
            rules: Vec::new(),
            mode: PermissionMode::Manual,
        }
    }

    /// Get the current permission mode.
    pub fn mode(&self) -> PermissionMode {
        #[allow(clippy::needless_return)]
        return self.mode;
    }

    /// Set the permission mode.
    pub fn set_mode(&mut self, mode: PermissionMode) {
        self.mode = mode;
    }

    /// Get the current rules.
    pub fn rules(&self) -> &[PermissionRule] {
        &self.rules
    }

    /// Set the rules.
    pub fn set_rules(&mut self, rules: Vec<PermissionRule>) {
        self.rules = rules;
    }

    /// Add a rule.
    pub fn add_rule(&mut self, rule: PermissionRule) {
        self.rules.push(rule);
    }

    /// Get the full permission data snapshot.
    pub fn data(&self) -> PermissionData {
        PermissionData {
            mode: self.mode,
            rules: self.rules.clone(),
        }
    }

    /// Evaluate a tool call against the policy chain.
    /// Returns the policy result, or the mode-based fallback if no policy matched.
    pub fn evaluate(&self, context: &PermissionPolicyContext) -> PermissionPolicyResult {
        for policy in &self.policies {
            if let Some(result) = policy.evaluate(context) {
                return result;
            }
        }

        // No policy matched — fall back based on permission mode
        match self.mode {
            PermissionMode::Auto | PermissionMode::Yolo => PermissionPolicyResult::Approve,
            PermissionMode::Manual => PermissionPolicyResult::Ask { resolve: None },
        }
    }

    /// Check if a specific tool call is allowed.
    /// Returns Ok(()) if allowed, or Err(reason) if denied.
    pub fn check(&self, context: &PermissionPolicyContext) -> Result<(), String> {
        match self.evaluate(context) {
            PermissionPolicyResult::Approve => Ok(()),
            PermissionPolicyResult::Deny { reason } => Err(reason),
            PermissionPolicyResult::Ask { .. } => Ok(()), // Ask is treated as "needs approval"
        }
    }

    /// Get the list of policy names for debugging.
    pub fn policy_names(&self) -> Vec<&str> {
        self.policies.iter().map(|p| p.name()).collect()
    }
}

impl Default for PermissionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_manager() {
        let mgr = PermissionManager::new();
        assert_eq!(mgr.mode(), PermissionMode::Manual);
        assert!(mgr.rules().is_empty());
        assert_eq!(mgr.policy_names().len(), 19);
    }

    #[test]
    fn test_set_mode() {
        let mut mgr = PermissionManager::new();
        mgr.set_mode(PermissionMode::Yolo);
        assert_eq!(mgr.mode(), PermissionMode::Yolo);
    }

    #[test]
    fn test_add_rule() {
        let mut mgr = PermissionManager::new();
        mgr.add_rule(PermissionRule {
            decision: PermissionRuleDecision::Allow,
            scope: PermissionRuleScope::User,
            pattern: "Read".into(),
            reason: None,
        });
        assert_eq!(mgr.rules().len(), 1);
    }

    #[test]
    fn test_auto_mode_approves() {
        let mgr = PermissionManager::new();
        let ctx = PermissionPolicyContext {
            tool_name: "Read".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Auto,
            r#type: None,
        };
        let result = mgr.evaluate(&ctx);
        match result {
            PermissionPolicyResult::Approve => {}
            _ => panic!("expected Approve in auto mode"),
        }
    }

    #[test]
    fn test_manual_mode_asks() {
        let mgr = PermissionManager::new();
        let ctx = PermissionPolicyContext {
            tool_name: "Read".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Manual,
            r#type: None,
        };
        let result = mgr.evaluate(&ctx);
        // In manual mode, the deny-all policy should fire since no earlier policy matched
        match result {
            PermissionPolicyResult::Deny { .. } => {}
            _ => panic!("expected Deny (from deny-all) in manual mode"),
        }
    }

    #[test]
    fn test_yolo_mode_approves() {
        let mgr = PermissionManager::new();
        let ctx = PermissionPolicyContext {
            tool_name: "Write".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Yolo,
            r#type: None,
        };
        let result = mgr.evaluate(&ctx);
        match result {
            PermissionPolicyResult::Approve => {}
            other => panic!("expected Approve in yolo mode, got {:?}", other),
        }
    }

    #[test]
    fn test_check_returns_ok() {
        let mgr = PermissionManager::new();
        let ctx = PermissionPolicyContext {
            tool_name: "Read".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Yolo,
            r#type: None,
        };
        assert!(mgr.check(&ctx).is_ok());
    }

    #[test]
    fn test_data_snapshot() {
        let mut mgr = PermissionManager::new();
        mgr.set_mode(PermissionMode::Auto);
        mgr.add_rule(PermissionRule {
            decision: PermissionRuleDecision::Allow,
            scope: PermissionRuleScope::User,
            pattern: "Read".into(),
            reason: None,
        });
        let data = mgr.data();
        assert_eq!(data.mode, PermissionMode::Auto);
        assert_eq!(data.rules.len(), 1);
    }
}