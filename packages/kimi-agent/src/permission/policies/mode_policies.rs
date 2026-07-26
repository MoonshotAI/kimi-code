/// Mode-based permission policies.
///
/// - auto-mode-approve: auto mode automatically approves all tool calls.
/// - yolo-mode-approve: yolo mode approves all tool calls.
/// - auto-mode-ask-user-question-deny: in auto mode, AskUserQuestion is denied.

use crate::permission::types::{
    PermissionMode, PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult,
};

/// In auto mode, all tool calls are automatically approved.
pub struct AutoModeApprovePermissionPolicy;

impl PermissionPolicy for AutoModeApprovePermissionPolicy {
    fn name(&self) -> &str {
        "auto-mode-approve"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        if context.mode == PermissionMode::Auto {
            Some(PermissionPolicyResult::Approve)
        } else {
            None
        }
    }
}

/// In yolo mode, all tool calls are automatically approved.
/// Only deny rules can block; everything else is allowed.
pub struct YoloModeApprovePermissionPolicy;

impl PermissionPolicy for YoloModeApprovePermissionPolicy {
    fn name(&self) -> &str {
        "yolo-mode-approve"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        if context.mode == PermissionMode::Yolo {
            Some(PermissionPolicyResult::Approve)
        } else {
            None
        }
    }
}

/// In auto mode, AskUserQuestion tool is denied (auto mode should not ask questions).
pub struct AutoModeAskUserQuestionDenyPermissionPolicy;

impl PermissionPolicy for AutoModeAskUserQuestionDenyPermissionPolicy {
    fn name(&self) -> &str {
        "auto-mode-ask-user-question-deny"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        if context.mode == PermissionMode::Auto && context.tool_name == "AskUserQuestion" {
            Some(PermissionPolicyResult::Deny {
                reason: "AskUserQuestion is not available in auto mode".into(),
            })
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auto_mode_approve() {
        let policy = AutoModeApprovePermissionPolicy;
        let ctx = PermissionPolicyContext {
            tool_name: "Read".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Auto,
            r#type: None,
        };
        let result = policy.evaluate(&ctx);
        assert!(result.is_some());
        match result.unwrap() {
            PermissionPolicyResult::Approve => {}
            _ => panic!("expected Approve"),
        }
    }

    #[test]
    fn test_auto_mode_no_match_in_manual() {
        let policy = AutoModeApprovePermissionPolicy;
        let ctx = PermissionPolicyContext {
            tool_name: "Read".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Manual,
            r#type: None,
        };
        assert!(policy.evaluate(&ctx).is_none());
    }

    #[test]
    fn test_yolo_mode_approve() {
        let policy = YoloModeApprovePermissionPolicy;
        let ctx = PermissionPolicyContext {
            tool_name: "Write".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Yolo,
            r#type: None,
        };
        let result = policy.evaluate(&ctx);
        assert!(result.is_some());
    }

    #[test]
    fn test_auto_ask_user_question_deny() {
        let policy = AutoModeAskUserQuestionDenyPermissionPolicy;
        let ctx = PermissionPolicyContext {
            tool_name: "AskUserQuestion".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Auto,
            r#type: None,
        };
        let result = policy.evaluate(&ctx);
        assert!(result.is_some());
        match result.unwrap() {
            PermissionPolicyResult::Deny { reason } => {
                assert!(reason.contains("auto mode"));
            }
            _ => panic!("expected Deny"),
        }
    }
}