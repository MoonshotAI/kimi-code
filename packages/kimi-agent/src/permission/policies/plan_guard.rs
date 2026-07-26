/// Plan mode guard policies.
///
/// - plan-mode-guard-deny: In plan mode, deny Write/Edit outside the plan file.
/// - plan-mode-tool-approve: In plan mode, approve specific planning tools.
/// - exit-plan-mode-review-ask: When exiting plan mode, ask for review.

use crate::permission::types::{
    PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult,
};

const PLAN_TOOLS: &[&str] = &[
    "Read",
    "Glob",
    "Grep",
    "Write",
    "Edit",
    "Bash",
    "AskUserQuestion",
];

/// In plan mode, Write/Edit outside the plan file is denied.
/// This is a simplified version — in production, path checking is also needed.
pub struct PlanModeGuardDenyPermissionPolicy;

impl PermissionPolicy for PlanModeGuardDenyPermissionPolicy {
    fn name(&self) -> &str {
        "plan-mode-guard-deny"
    }

    fn evaluate(&self, _context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        // Note: Full implementation would check if the file path is within the plan file.
        // For now, this is a placeholder that matches the TS structure.
        None
    }
}

/// In plan mode, specific planning tools are approved.
pub struct PlanModeToolApprovePermissionPolicy;

impl PermissionPolicy for PlanModeToolApprovePermissionPolicy {
    fn name(&self) -> &str {
        "plan-mode-tool-approve"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        // In plan mode, the task-stop and plan-mode-readonly tools are approved.
        // For the full implementation, we check if the specific tool is allowed.
        if context.r#type.as_deref() == Some("plan_mode") {
            if PLAN_TOOLS.contains(&context.tool_name.as_str()) {
                return Some(PermissionPolicyResult::Approve);
            }
        }
        None
    }
}

/// When exiting plan mode, ask for review.
pub struct ExitPlanModeReviewAskPermissionPolicy;

impl PermissionPolicy for ExitPlanModeReviewAskPermissionPolicy {
    fn name(&self) -> &str {
        "exit-plan-mode-review-ask"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        if context.tool_name == "ExitPlanMode" {
            Some(PermissionPolicyResult::Ask { resolve: None })
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::types::PermissionMode;

    #[test]
    fn test_plan_guard_returns_none() {
        // Currently the guard is a placeholder — always returns None
        let policy = PlanModeGuardDenyPermissionPolicy;
        let ctx = PermissionPolicyContext {
            tool_name: "Write".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Manual,
            r#type: None,
        };
        assert!(policy.evaluate(&ctx).is_none());
    }

    #[test]
    fn test_exit_plan_mode_asks() {
        let policy = ExitPlanModeReviewAskPermissionPolicy;
        let ctx = PermissionPolicyContext {
            tool_name: "ExitPlanMode".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Manual,
            r#type: None,
        };
        let result = policy.evaluate(&ctx);
        assert!(result.is_some());
        match result.unwrap() {
            PermissionPolicyResult::Ask { .. } => {}
            _ => panic!("expected Ask"),
        }
    }
}