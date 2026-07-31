/// PermissionManager — the permission decision engine.
///
/// Evaluates tool calls against a chain of permission policies.
/// The first policy that returns a result wins.
///
/// Mutable data (rules, session approvals, mode, context type) lives in a
/// shared, interior-mutable [`PermissionState`]: the manager hands clones of
/// it to the stateful policies at construction time, and `PermissionGate`
/// mutates it through shared handles at runtime.

use crate::permission::policies::{
    default_policies::{
        DefaultToolApprovePermissionPolicy, DenyAllPermissionPolicy, FallbackAskPermissionPolicy,
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
use crate::permission::state::PermissionState;
use crate::permission::types::*;

/// The PermissionManager.
pub struct PermissionManager {
    /// Ordered list of permission policies.
    policies: Vec<Box<dyn PermissionPolicy>>,
    /// Shared mutable state (rules, session approvals, mode, context type).
    state: PermissionState,
}

impl PermissionManager {
    /// Create a new PermissionManager with the default policy chain.
    pub fn new() -> Self {
        Self::with_state(PermissionState::new())
    }

    /// Create a PermissionManager over an existing shared state.
    pub fn with_state(state: PermissionState) -> Self {
        let policies: Vec<Box<dyn PermissionPolicy>> = vec![
            // 1. PreToolUse hook returned a block → deny
            Box::new(PreToolCallHookPermissionPolicy),
            // 2. AgentSwarm is batch-exclusive
            Box::new(AgentSwarmExclusiveDenyPermissionPolicy),
            // 3. Auto mode + AskUserQuestion → deny
            Box::new(AutoModeAskUserQuestionDenyPermissionPolicy),
            // 4. Plan mode: Write/Edit outside the plan file → deny
            Box::new(PlanModeGuardDenyPermissionPolicy::new(state.clone())),
            // 5. Swarm mode: Agent tool is not available
            Box::new(SwarmModeAgentDenyPermissionPolicy),
            // 6. User-configured deny rules
            Box::new(UserConfiguredDenyPermissionPolicy::new(state.clone())),
            // 7. Plan mode: writing into the plan file is approved
            Box::new(PlanModeToolApprovePermissionPolicy::new(state.clone())),
            // 8. Swarm mode: AgentSwarm is approved
            Box::new(SwarmModeAgentSwarmApprovePermissionPolicy),
            // 9. User-configured ask rules — evaluated before allow so a rule
            //    that both allows and asks resolves as ask (TS order).
            Box::new(UserConfiguredAskPermissionPolicy::new(state.clone())),
            // 10. User-configured allow rules
            Box::new(UserConfiguredAllowPermissionPolicy::new(state.clone())),
            // 11. Auto mode: approve all
            Box::new(AutoModeApprovePermissionPolicy),
            // 12. Session approval history
            Box::new(SessionApprovalHistoryPermissionPolicy::new(state.clone())),
            // 13. Sensitive file access → ask
            Box::new(FileAccessAskPermissionPolicy),
            // 14. Git working directory write → approve
            Box::new(GitCwdWriteApprovePermissionPolicy),
            // 15. Exit plan mode → ask for review
            Box::new(ExitPlanModeReviewAskPermissionPolicy),
            // 16. Goal start → ask for review
            Box::new(GoalStartReviewAskPermissionPolicy),
            // 17. Yolo mode: approve all — after the ask-class policies so
            //     sensitive-file and user-configured ask rules still fire.
            Box::new(YoloModeApprovePermissionPolicy),
            // 18. Default tool approval (let the manager's mode handle it)
            Box::new(DefaultToolApprovePermissionPolicy),
            // 19. Fallback ask (mode-based: Manual asks, Auto/Yolo approve)
            Box::new(FallbackAskPermissionPolicy),
            // 20. Deny all (unreachable defense-in-depth last resort)
            Box::new(DenyAllPermissionPolicy),
        ];

        Self { policies, state }
    }

    /// Shared handle to the mutable permission state.
    pub fn state(&self) -> &PermissionState {
        &self.state
    }

    /// Get the current permission mode.
    pub fn mode(&self) -> PermissionMode {
        self.state.mode()
    }

    /// Set the permission mode (through the shared state).
    pub fn set_mode(&self, mode: PermissionMode) {
        self.state.set_mode(mode);
    }

    /// Snapshot of the current rules.
    pub fn rules(&self) -> Vec<PermissionRule> {
        self.state.rules()
    }

    /// Set the rules.
    pub fn set_rules(&self, rules: Vec<PermissionRule>) {
        self.state.set_rules(rules);
    }

    /// Add a rule.
    pub fn add_rule(&self, rule: PermissionRule) {
        self.state.add_rule(rule);
    }

    /// Get the context type (e.g. "plan_mode").
    pub fn context_type(&self) -> Option<String> {
        self.state.context_type()
    }

    /// Set the context type (through the shared state).
    pub fn set_context_type(&self, ct: Option<String>) {
        self.state.set_context_type(ct);
    }

    /// Set the active plan file path (through the shared state). Wired by the
    /// host when a plan opens/closes; the plan-mode guard reads it.
    pub fn set_plan_file_path(&self, path: Option<String>) {
        self.state.set_plan_file_path(path);
    }

    /// The active plan file path, if any.
    pub fn plan_file_path(&self) -> Option<String> {
        self.state.plan_file_path()
    }

    /// Get the full permission data snapshot.
    pub fn data(&self) -> PermissionData {
        PermissionData {
            mode: self.state.mode(),
            rules: self.state.rules(),
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
        match self.state.mode() {
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

    /// True when a user-configured allow rule matches the call (command-level
    /// for Bash). Consulted by the Bash gating path to decide whether an
    /// explicit allow exempts a dangerous command from host approval —
    /// session approvals and mode-based approvals deliberately do not count.
    pub fn has_user_allow(&self, context: &PermissionPolicyContext) -> bool {
        matches!(
            UserConfiguredAllowPermissionPolicy::new(self.state.clone()).evaluate(context),
            Some(PermissionPolicyResult::Approve)
        )
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
        assert_eq!(mgr.policy_names().len(), 20);
    }

    #[test]
    fn test_set_mode() {
        let mgr = PermissionManager::new();
        mgr.set_mode(PermissionMode::Yolo);
        assert_eq!(mgr.mode(), PermissionMode::Yolo);
    }

    #[test]
    fn test_add_rule() {
        let mgr = PermissionManager::new();
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
        // Manual mode: the fallback-ask policy fires — the user approves
        // interactively (v1 semantics; deny-all is unreachable defense).
        match result {
            PermissionPolicyResult::Ask { .. } => {}
            other => panic!("expected Ask in manual mode, got {:?}", other),
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
        let mgr = PermissionManager::new();
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