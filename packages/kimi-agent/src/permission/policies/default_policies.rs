/// Default permission policies.
///
/// These include the less complex policies that don't warrant their own file:
/// pre-tool-call-hook, default-tool-approve, session-approval-history,
/// fallback-ask, deny-all, file-access-ask, git-cwd-write-approve,
/// goal-start-review-ask.

use crate::permission::types::{
    PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult,
};

/// PreToolUse hook returned a block → deny.
pub struct PreToolCallHookPermissionPolicy;

impl PermissionPolicy for PreToolCallHookPermissionPolicy {
    fn name(&self) -> &str {
        "pre-tool-call-hook"
    }

    fn evaluate(&self, _context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        // This is handled on the JS side via hooks.
        // In the Rust engine, this is a no-op — the hook runs on the JS side.
        None
    }
}

/// Default tool approval — if no other policy matched, approve the tool.
pub struct DefaultToolApprovePermissionPolicy;

impl PermissionPolicy for DefaultToolApprovePermissionPolicy {
    fn name(&self) -> &str {
        "default-tool-approve"
    }

    fn evaluate(&self, _context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        None // Let the manager's fallback logic handle this
    }
}

/// Session approval history — approve if a session-level approval exists.
pub struct SessionApprovalHistoryPermissionPolicy;

impl PermissionPolicy for SessionApprovalHistoryPermissionPolicy {
    fn name(&self) -> &str {
        "session-approval-history"
    }

    fn evaluate(&self, _context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        // In production, this checks the session's approval history cache.
        // For the Rust implementation, this is a placeholder.
        None
    }
}

/// Fallback ask — if nothing else matched, ask the user.
pub struct FallbackAskPermissionPolicy;

impl PermissionPolicy for FallbackAskPermissionPolicy {
    fn name(&self) -> &str {
        "fallback-ask"
    }

    fn evaluate(&self, _context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        // Let the manager handle the fallback based on permission mode.
        None
    }
}

/// Deny all — last resort policy that denies everything.
pub struct DenyAllPermissionPolicy;

impl PermissionPolicy for DenyAllPermissionPolicy {
    fn name(&self) -> &str {
        "deny-all"
    }

    fn evaluate(&self, _context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        Some(PermissionPolicyResult::Deny {
            reason: "Denied by deny-all policy".into(),
        })
    }
}

/// Sensitive file access — ask for approval when accessing sensitive paths.
pub struct FileAccessAskPermissionPolicy;

impl PermissionPolicy for FileAccessAskPermissionPolicy {
    fn name(&self) -> &str {
        "file-access-ask"
    }

    fn evaluate(&self, _context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        // In production, this checks if the file path matches sensitive patterns.
        // kimi-native-tools has path_access.rs for this.
        None
    }
}

/// Git working directory write — approve writes within the git working tree.
pub struct GitCwdWriteApprovePermissionPolicy;

impl PermissionPolicy for GitCwdWriteApprovePermissionPolicy {
    fn name(&self) -> &str {
        "git-cwd-write-approve"
    }

    fn evaluate(&self, _context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        // In production, this checks if the path is within the git working directory.
        None
    }
}

/// Goal start review — ask for review when starting a new goal.
pub struct GoalStartReviewAskPermissionPolicy;

impl PermissionPolicy for GoalStartReviewAskPermissionPolicy {
    fn name(&self) -> &str {
        "goal-start-review-ask"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        if context.tool_name == "CreateGoal" {
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
    fn test_deny_all() {
        let policy = DenyAllPermissionPolicy;
        let ctx = PermissionPolicyContext {
            tool_name: "Anything".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Manual,
            r#type: None,
        };
        let result = policy.evaluate(&ctx);
        assert!(result.is_some());
        match result.unwrap() {
            PermissionPolicyResult::Deny { .. } => {}
            _ => panic!("expected Deny"),
        }
    }

    #[test]
    fn test_goal_start_ask() {
        let policy = GoalStartReviewAskPermissionPolicy;
        let ctx = PermissionPolicyContext {
            tool_name: "CreateGoal".into(),
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