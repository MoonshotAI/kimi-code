/// A cheap, cloneable handle to the permission engine for use on the tool
/// execution path.
///
/// The turn loop and the callback decorators need to consult the
/// `PermissionManager` without owning it outright (it is shared across the
/// session). `PermissionGate` wraps the manager in an `Arc` and exposes a
/// single `evaluate` entry point that builds the policy context from a
/// prospective tool call and runs the policy chain using the manager's
/// current mode.
use std::sync::Arc;

use crate::permission::manager::PermissionManager;
use crate::permission::types::{
    PermissionMode, PermissionPolicyContext, PermissionPolicyResult, PermissionRule,
};

/// Cloneable front-end to a shared `PermissionManager`.
#[derive(Clone)]
pub struct PermissionGate {
    manager: Arc<PermissionManager>,
}

impl std::fmt::Debug for PermissionGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PermissionGate").finish_non_exhaustive()
    }
}

impl PermissionGate {
    /// Wrap an owned manager in a shared handle.
    pub fn new(manager: PermissionManager) -> Self {
        Self {
            manager: Arc::new(manager),
        }
    }

    /// Build a gate whose mode is seeded from `KIMI_PERMISSION_MODE`
    /// (`manual` | `auto` | `yolo`), defaulting to `Manual`. `auto`/`yolo`
    /// let the engine approve tool calls locally (no host round-trip);
    /// `manual` keeps interactive approval on the host.
    pub fn from_env() -> Self {
        let mode = match std::env::var("KIMI_PERMISSION_MODE")
            .ok()
            .map(|v| v.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("yolo") => PermissionMode::Yolo,
            Some("auto") => PermissionMode::Auto,
            _ => PermissionMode::Manual,
        };
        let manager = PermissionManager::new();
        manager.set_mode(mode);
        Self::new(manager)
    }

    /// Wrap an already-shared manager.
    pub fn from_shared(manager: Arc<PermissionManager>) -> Self {
        Self { manager }
    }

    /// Access the underlying shared manager.
    pub fn manager(&self) -> &Arc<PermissionManager> {
        &self.manager
    }

    /// Add a user-configured rule through the shared state. Works on a shared
    /// handle (rules live in an interior-mutable `PermissionState`).
    pub fn add_rule(&self, rule: PermissionRule) {
        self.manager.state().add_rule(rule);
    }

    /// Record a session-scoped approval through the shared state.
    pub fn record_session_approval(&self, rule: PermissionRule) {
        self.manager.state().record_session_approval(rule);
    }

    /// Current permission mode.
    pub fn mode(&self) -> PermissionMode {
        self.manager.state().mode()
    }

    /// Set the permission mode through the shared state. Works on a shared
    /// handle (mode lives in the interior-mutable `PermissionState`).
    pub fn set_mode(&self, mode: PermissionMode) {
        self.manager.state().set_mode(mode);
    }

    /// Evaluate a prospective tool call against the policy chain.
    ///
    /// Enable / disable plan mode context for all policy evaluations.
    /// When `Some("plan_mode")`, the plan guard policies activate.
    pub fn set_context_type(&self, ct: Option<String>) {
        self.manager.set_context_type(ct);
    }

    /// Returns the chain's decision: `Approve` (run it), `Deny` (block it),
    /// or `Ask` (interactive approval required).
    pub fn evaluate(
        &self,
        tool_name: &str,
        tool_call_id: &str,
        args: &serde_json::Value,
    ) -> PermissionPolicyResult {
        let ctx = PermissionPolicyContext {
            tool_name: tool_name.to_string(),
            tool_call_id: tool_call_id.to_string(),
            args: args.clone(),
            mode: self.manager.mode(),
            r#type: self.manager.context_type(),
        };
        self.manager.evaluate(&ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::types::{
        PermissionMode, PermissionRule, PermissionRuleDecision, PermissionRuleScope,
    };

    #[test]
    fn test_gate_uses_manager_mode() {
        let mgr = PermissionManager::new();
        mgr.set_mode(PermissionMode::Yolo);
        let gate = PermissionGate::new(mgr);
        // Yolo approves arbitrary tools.
        assert!(matches!(
            gate.evaluate("Bash", "c1", &serde_json::json!({})),
            PermissionPolicyResult::Approve
        ));
    }

    #[test]
    fn test_gate_enforces_deny_rule() {
        let mgr = PermissionManager::new();
        mgr.add_rule(PermissionRule {
            decision: PermissionRuleDecision::Deny,
            scope: PermissionRuleScope::User,
            pattern: "Bash".into(),
            reason: None,
        });
        let gate = PermissionGate::new(mgr);
        assert!(matches!(
            gate.evaluate("Bash", "c1", &serde_json::json!({})),
            PermissionPolicyResult::Deny { .. }
        ));
    }

    #[test]
    fn test_gate_manual_bash_asks() {
        let gate = PermissionGate::new(PermissionManager::new()); // default Manual
        assert!(matches!(
            gate.evaluate("Bash", "c1", &serde_json::json!({ "command": "ls" })),
            PermissionPolicyResult::Ask { .. }
        ));
    }

    #[test]
    fn test_gate_clones_share_manager() {
        let gate = PermissionGate::new(PermissionManager::new());
        let clone = gate.clone();
        clone.add_rule(PermissionRule {
            decision: PermissionRuleDecision::Deny,
            scope: PermissionRuleScope::User,
            pattern: "Write".into(),
            reason: None,
        });
        // The original observes the rule added through the clone.
        assert!(matches!(
            gate.evaluate("Write", "c1", &serde_json::json!({})),
            PermissionPolicyResult::Deny { .. }
        ));
    }

    #[test]
    fn test_gate_runtime_config_affects_other_clones() {
        // Mirrors the RPC config surface: one handle configures, another
        // (held by the turn loop) evaluates.
        let config_side = PermissionGate::new(PermissionManager::new()); // Manual
        let turn_side = config_side.clone();

        // Manual mode: shell execution asks.
        assert!(matches!(
            turn_side.evaluate("Bash", "c1", &serde_json::json!({ "command": "ls" })),
            PermissionPolicyResult::Ask { .. }
        ));

        // permission/set_mode → Yolo through the config handle...
        config_side.set_mode(PermissionMode::Yolo);
        // ...is observed by the turn-side handle immediately.
        assert!(matches!(
            turn_side.evaluate("Bash", "c1", &serde_json::json!({ "command": "ls" })),
            PermissionPolicyResult::Approve
        ));
    }
}
