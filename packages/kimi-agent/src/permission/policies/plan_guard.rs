/// Plan mode guard policies.
///
/// - plan-mode-guard-deny: In plan mode, deny Write/Edit outside the plan file.
/// - plan-mode-tool-approve: In plan mode, approve writing into the plan file.
/// - exit-plan-mode-review-ask: When exiting plan mode, ask for review.

use crate::permission::state::PermissionState;
use crate::permission::types::{
    PermissionMode, PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult,
};

/// Tools that must be denied outright while plan mode is active (they mutate
/// or schedule work outside the plan file). Mirrors the TS guard.
const PLAN_MODE_DENIED_TOOLS: &[&str] = &["TaskStop", "CronCreate", "CronDelete"];

/// Extract the write target path from a Write/Edit call.
///
/// Write carries `path`; Edit carries `file_path` (its old/new strings both
/// belong to that file). Returns `None` when the call has no path argument —
/// in that case the path constraint cannot be evaluated.
fn write_target_path(tool_name: &str, args: &serde_json::Value) -> Option<String> {
    let key = if tool_name == "Edit" { "file_path" } else { "path" };
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Whether `target` lexically equals `plan_file` (absolute-vs-relative not
/// resolved here — both sides are expected in the same normalized form the
/// caller used).
fn target_is_plan_file(target: &str, plan_file: &str) -> bool {
    let t = target.trim_end_matches(['/', '\\']);
    let p = plan_file.trim_end_matches(['/', '\\']);
    t == p
}

/// In plan mode, Write/Edit outside the plan file is denied.
///
/// Semantics (mirrors TS `plan-mode-guard-deny`): with plan mode active,
/// every Write/Edit must target the plan file itself; any deviation, or a
/// plan mode with no known plan file, is denied. While the host has not yet
/// wired `plan_file_path` (`None`) the guard stays fail-open so in-flight
/// plan-mode writes keep working — the file check activates as soon as the
/// path is registered.
pub struct PlanModeGuardDenyPermissionPolicy {
    state: PermissionState,
}

impl PlanModeGuardDenyPermissionPolicy {
    pub fn new(state: PermissionState) -> Self {
        Self { state }
    }
}

impl PermissionPolicy for PlanModeGuardDenyPermissionPolicy {
    fn name(&self) -> &str {
        "plan-mode-guard-deny"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        if context.r#type.as_deref() != Some("plan_mode") {
            return None;
        }
        match context.tool_name.as_str() {
            // TaskStop / CronCreate / CronDelete → deny in plan mode.
            _ if PLAN_MODE_DENIED_TOOLS.contains(&context.tool_name.as_str()) => Some(
                PermissionPolicyResult::Deny {
                    reason: format!(
                        "In plan mode, `{}` is not allowed — finish the plan first.",
                        context.tool_name
                    ),
                },
            ),
            "Write" | "Edit" => {
                // Fail-open until the host wires the plan file path; once
                // known, any write outside it is denied.
                let plan_file = self.state.plan_file_path();
                let Some(plan_file) = plan_file else {
                    return None;
                };
                let Some(target) = write_target_path(&context.tool_name, &context.args) else {
                    // No path to constrain — leave to the rest of the chain.
                    return None;
                };
                if target_is_plan_file(&target, &plan_file) {
                    None
                } else {
                    Some(PermissionPolicyResult::Deny {
                        reason: format!(
                            "In plan mode, `{}` is only allowed for the plan file `{plan_file}`.",
                            context.tool_name
                        ),
                    })
                }
            }
            _ => None,
        }
    }
}

/// In plan mode, writing into the plan file is approved.
///
/// Mirrors TS `plan-mode-tool-approve`: only EnterPlanMode and writes into
/// the plan file get a local approval; everything else (Bash, AskUserQuestion,
/// arbitrary Write/Edit) flows through the normal chain instead of being
/// blanket-approved while plan mode is active.
pub struct PlanModeToolApprovePermissionPolicy {
    state: PermissionState,
}

impl PlanModeToolApprovePermissionPolicy {
    pub fn new(state: PermissionState) -> Self {
        Self { state }
    }
}

impl PermissionPolicy for PlanModeToolApprovePermissionPolicy {
    fn name(&self) -> &str {
        "plan-mode-tool-approve"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        if context.r#type.as_deref() != Some("plan_mode") {
            return None;
        }
        match context.tool_name.as_str() {
            "EnterPlanMode" => Some(PermissionPolicyResult::Approve),
            "Write" | "Edit" => {
                // Only approve a write whose target is the plan file itself.
                let plan_file = self.state.plan_file_path();
                let (Some(plan_file), Some(target)) =
                    (plan_file, write_target_path(&context.tool_name, &context.args))
                else {
                    return None;
                };
                if target_is_plan_file(&target, &plan_file) {
                    Some(PermissionPolicyResult::Approve)
                } else {
                    None
                }
            }
            _ => None,
        }
    }
}

/// When exiting plan mode, ask for review.
///
/// Mirrors TS `exit-plan-mode-review-ask`: only ask in interactive modes
/// (not auto/yolo) while plan mode is actually active; otherwise the tool
/// passes through the chain.
pub struct ExitPlanModeReviewAskPermissionPolicy;

impl PermissionPolicy for ExitPlanModeReviewAskPermissionPolicy {
    fn name(&self) -> &str {
        "exit-plan-mode-review-ask"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        if context.tool_name == "ExitPlanMode"
            && context.r#type.as_deref() == Some("plan_mode")
            && !matches!(context.mode, PermissionMode::Auto | PermissionMode::Yolo)
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
    use crate::permission::types::PermissionMode;

    fn ctx(tool: &str, args: serde_json::Value, mode: PermissionMode) -> PermissionPolicyContext {
        PermissionPolicyContext {
            tool_name: tool.into(),
            tool_call_id: "1".into(),
            args,
            mode,
            r#type: Some("plan_mode".into()),
        }
    }

    #[test]
    fn test_guard_denies_write_outside_plan_file() {
        let state = PermissionState::new();
        state.set_plan_file_path(Some("/workspace/plan.md".into()));
        let policy = PlanModeGuardDenyPermissionPolicy::new(state);
        let result = policy.evaluate(&ctx(
            "Write",
            serde_json::json!({ "path": "/workspace/src/main.rs" }),
            PermissionMode::Manual,
        ));
        match result {
            Some(PermissionPolicyResult::Deny { .. }) => {}
            other => panic!("expected Deny outside plan file, got {other:?}"),
        }
    }

    #[test]
    fn test_guard_allows_plan_file_write() {
        let state = PermissionState::new();
        state.set_plan_file_path(Some("/workspace/plan.md".into()));
        let policy = PlanModeGuardDenyPermissionPolicy::new(state);
        assert!(
            policy
                .evaluate(&ctx(
                    "Write",
                    serde_json::json!({ "path": "/workspace/plan.md" }),
                    PermissionMode::Manual,
                ))
                .is_none(),
            "writes into the plan file must not be denied"
        );
    }

    #[test]
    fn test_guard_denies_taskstop_and_cron_in_plan_mode() {
        let state = PermissionState::new();
        let policy = PlanModeGuardDenyPermissionPolicy::new(state);
        for tool in ["TaskStop", "CronCreate", "CronDelete"] {
            match policy.evaluate(&ctx(tool, serde_json::json!({}), PermissionMode::Manual)) {
                Some(PermissionPolicyResult::Deny { .. }) => {}
                other => panic!("expected Deny for {tool}, got {other:?}"),
            }
        }
    }

    #[test]
    fn test_guard_fail_open_without_plan_file_path() {
        // Before the host wires plan_file_path, the guard stays fail-open so
        // plan-mode writes keep working (they flow through the normal chain).
        let state = PermissionState::new();
        let policy = PlanModeGuardDenyPermissionPolicy::new(state);
        assert!(
            policy
                .evaluate(&ctx(
                    "Write",
                    serde_json::json!({ "path": "/workspace/src/main.rs" }),
                    PermissionMode::Manual,
                ))
                .is_none()
        );
    }

    #[test]
    fn test_guard_inactive_outside_plan_mode() {
        let state = PermissionState::new();
        state.set_plan_file_path(Some("/workspace/plan.md".into()));
        let policy = PlanModeGuardDenyPermissionPolicy::new(state);
        let c = PermissionPolicyContext {
            tool_name: "Write".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({ "path": "/workspace/elsewhere.rs" }),
            mode: PermissionMode::Manual,
            r#type: None,
        };
        assert!(policy.evaluate(&c).is_none());
    }

    #[test]
    fn test_tool_approve_approves_plan_file_write_only() {
        let state = PermissionState::new();
        state.set_plan_file_path(Some("/workspace/plan.md".into()));
        let policy = PlanModeToolApprovePermissionPolicy::new(state);
        // Plan file write → approved locally.
        assert!(matches!(
            policy.evaluate(&ctx(
                "Write",
                serde_json::json!({ "path": "/workspace/plan.md" }),
                PermissionMode::Manual,
            )),
            Some(PermissionPolicyResult::Approve)
        ));
        // Anything else → no longer blanket-approved.
        assert!(
            policy
                .evaluate(&ctx(
                    "Write",
                    serde_json::json!({ "path": "/workspace/src/main.rs" }),
                    PermissionMode::Manual,
                ))
                .is_none()
        );
        assert!(
            policy
                .evaluate(&ctx("Bash", serde_json::json!({ "command": "ls" }), PermissionMode::Manual))
                .is_none(),
            "Bash must not be blanket-approved in plan mode"
        );
        assert!(
            policy
                .evaluate(&ctx("AskUserQuestion", serde_json::json!({}), PermissionMode::Manual))
                .is_none(),
            "AskUserQuestion must not be blanket-approved in plan mode"
        );
    }

    #[test]
    fn test_tool_approve_fail_open_without_plan_file() {
        let state = PermissionState::new();
        let policy = PlanModeToolApprovePermissionPolicy::new(state);
        assert!(
            policy
                .evaluate(&ctx("Write", serde_json::json!({ "path": "/x" }), PermissionMode::Manual))
                .is_none()
        );
    }

    #[test]
    fn test_exit_plan_mode_asks_only_interactive() {
        let policy = ExitPlanModeReviewAskPermissionPolicy;
        // Manual + plan mode → Ask.
        assert!(matches!(
            policy.evaluate(&ctx("ExitPlanMode", serde_json::json!({}), PermissionMode::Manual)),
            Some(PermissionPolicyResult::Ask { .. })
        ));
        // Auto / yolo → no ask.
        assert!(
            policy
                .evaluate(&ctx("ExitPlanMode", serde_json::json!({}), PermissionMode::Auto))
                .is_none()
        );
        assert!(
            policy
                .evaluate(&ctx("ExitPlanMode", serde_json::json!({}), PermissionMode::Yolo))
                .is_none()
        );
        // Not in plan mode → no ask.
        let c = PermissionPolicyContext {
            tool_name: "ExitPlanMode".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Manual,
            r#type: None,
        };
        assert!(policy.evaluate(&c).is_none());
    }
}
