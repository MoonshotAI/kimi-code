/// Swarm mode guard policies.
///
/// - agent-swarm-exclusive-deny: AgentSwarm is batch-exclusive and must run alone.
/// - swarm-mode-agent-deny: In swarm mode, Agent tool is not available.
/// - swarm-mode-agent-swarm-approve: In swarm mode, AgentSwarm is approved.

use crate::permission::types::{
    PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult,
};

/// AgentSwarm is batch-exclusive and must run alone, regardless of permission mode.
pub struct AgentSwarmExclusiveDenyPermissionPolicy;

impl PermissionPolicy for AgentSwarmExclusiveDenyPermissionPolicy {
    fn name(&self) -> &str {
        "agent-swarm-exclusive-deny"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        if context.tool_name == "AgentSwarm" {
            // In the full implementation, this checks if there are other
            // concurrent agent calls. For now, we let it through.
            None
        } else {
            None
        }
    }
}

/// In swarm mode, the Agent tool is not available — all subagent work
/// must use AgentSwarm.
pub struct SwarmModeAgentDenyPermissionPolicy;

impl PermissionPolicy for SwarmModeAgentDenyPermissionPolicy {
    fn name(&self) -> &str {
        "swarm-mode-agent-deny"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        if context.r#type.as_deref() == Some("swarm") && context.tool_name == "Agent" {
            Some(PermissionPolicyResult::Deny {
                reason: "Agent tool is not available in swarm mode; use AgentSwarm instead".into(),
            })
        } else {
            None
        }
    }
}

/// In swarm mode, AgentSwarm is approved.
pub struct SwarmModeAgentSwarmApprovePermissionPolicy;

impl PermissionPolicy for SwarmModeAgentSwarmApprovePermissionPolicy {
    fn name(&self) -> &str {
        "swarm-mode-agent-swarm-approve"
    }

    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult> {
        if context.r#type.as_deref() == Some("swarm") && context.tool_name == "AgentSwarm" {
            Some(PermissionPolicyResult::Approve)
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
    fn test_swarm_mode_agent_deny() {
        let policy = SwarmModeAgentDenyPermissionPolicy;
        let ctx = PermissionPolicyContext {
            tool_name: "Agent".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Manual,
            r#type: Some("swarm".into()),
        };
        let result = policy.evaluate(&ctx);
        assert!(result.is_some());
        match result.unwrap() {
            PermissionPolicyResult::Deny { reason } => {
                assert!(reason.contains("swarm mode"));
            }
            _ => panic!("expected Deny"),
        }
    }

    #[test]
    fn test_swarm_mode_swarm_approve() {
        let policy = SwarmModeAgentSwarmApprovePermissionPolicy;
        let ctx = PermissionPolicyContext {
            tool_name: "AgentSwarm".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Manual,
            r#type: Some("swarm".into()),
        };
        let result = policy.evaluate(&ctx);
        assert!(result.is_some());
        match result.unwrap() {
            PermissionPolicyResult::Approve => {}
            _ => panic!("expected Approve"),
        }
    }

    #[test]
    fn test_swarm_agent_not_in_swarm() {
        let policy = SwarmModeAgentDenyPermissionPolicy;
        let ctx = PermissionPolicyContext {
            tool_name: "Agent".into(),
            tool_call_id: "1".into(),
            args: serde_json::json!({}),
            mode: PermissionMode::Manual,
            r#type: None,
        };
        assert!(policy.evaluate(&ctx).is_none());
    }
}