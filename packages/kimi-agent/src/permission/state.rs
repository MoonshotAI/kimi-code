/// Shared, mutable permission state.
///
/// The `PermissionManager` owns this state and hands clones to the stateful
/// policies (user-configured rules, session approval history). Cloning a
/// `PermissionState` is cheap (an `Arc` bump); every clone observes the same
/// underlying rules and approvals, so a rule added through the manager is
/// immediately visible to the policies that evaluate it.
///
/// Locking is poisoning-tolerant: a panicked holder recovers the inner data
/// rather than propagating the poison (see the crate's panic-hygiene rules).
use std::sync::{Arc, RwLock};

use crate::permission::types::{PermissionMode, PermissionRule};

/// Inner state guarded by the lock.
struct PermissionStateInner {
    /// User-configured permission rules (deny / allow / ask), in priority order.
    rules: Vec<PermissionRule>,
    /// Session-scoped approvals recorded when the user chose
    /// "approve for this session" on an interactive prompt.
    session_approved: Vec<PermissionRule>,
    /// Current permission mode. Lives here (rather than on the manager) so it
    /// can be changed through a shared handle at runtime — e.g. via the RPC
    /// config surface — and observed by every policy evaluation.
    mode: PermissionMode,
    /// Optional context type tag. Set to "plan_mode" when the agent is in
    /// plan mode, so the plan guard policies can activate.
    context_type: Option<String>,
}

impl Default for PermissionStateInner {
    fn default() -> Self {
        Self {
            rules: Vec::new(),
            session_approved: Vec::new(),
            mode: PermissionMode::Manual,
            context_type: None,
        }
    }
}

/// Cheaply cloneable handle to the shared permission state.
#[derive(Clone, Default)]
pub struct PermissionState {
    inner: Arc<RwLock<PermissionStateInner>>,
}

impl PermissionState {
    /// Create an empty shared state.
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot of the user-configured rules.
    pub fn rules(&self) -> Vec<PermissionRule> {
        self.read().rules.clone()
    }

    /// Replace the user-configured rules.
    pub fn set_rules(&self, rules: Vec<PermissionRule>) {
        self.write().rules = rules;
    }

    /// Append a single user-configured rule.
    pub fn add_rule(&self, rule: PermissionRule) {
        self.write().rules.push(rule);
    }

    /// Snapshot of the session-scoped approvals.
    pub fn session_approved(&self) -> Vec<PermissionRule> {
        self.read().session_approved.clone()
    }

    /// Record a session-scoped approval (e.g. after the user approves a prompt
    /// with scope = session).
    pub fn record_session_approval(&self, rule: PermissionRule) {
        self.write().session_approved.push(rule);
    }

    /// Current permission mode.
    pub fn mode(&self) -> PermissionMode {
        self.read().mode
    }

    /// Get the context type (e.g., "plan_mode").
    pub fn context_type(&self) -> Option<String> {
        self.read().context_type.clone()
    }

    /// Set the context type.
    pub fn set_context_type(&self, ct: Option<String>) {
        self.write().context_type = ct;
    }

    /// Set the permission mode.
    pub fn set_mode(&self, mode: PermissionMode) {
        self.write().mode = mode;
    }

    // --- private helpers ---

    fn read(&self) -> std::sync::RwLockReadGuard<'_, PermissionStateInner> {
        self.inner.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, PermissionStateInner> {
        self.inner.write().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::types::{PermissionRuleDecision, PermissionRuleScope};

    fn rule(pattern: &str, decision: PermissionRuleDecision) -> PermissionRule {
        PermissionRule {
            decision,
            scope: PermissionRuleScope::User,
            pattern: pattern.into(),
            reason: None,
        }
    }

    #[test]
    fn test_rules_add_and_snapshot() {
        let state = PermissionState::new();
        assert!(state.rules().is_empty());
        state.add_rule(rule("Read", PermissionRuleDecision::Allow));
        state.add_rule(rule("Bash", PermissionRuleDecision::Deny));
        assert_eq!(state.rules().len(), 2);
    }

    #[test]
    fn test_set_rules_replaces() {
        let state = PermissionState::new();
        state.add_rule(rule("Read", PermissionRuleDecision::Allow));
        state.set_rules(vec![rule("Write", PermissionRuleDecision::Ask)]);
        let rules = state.rules();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].pattern, "Write");
    }

    #[test]
    fn test_clones_share_state() {
        let state = PermissionState::new();
        let clone = state.clone();
        state.add_rule(rule("Read", PermissionRuleDecision::Allow));
        // The clone observes the same underlying state.
        assert_eq!(clone.rules().len(), 1);
        clone.record_session_approval(rule("Bash", PermissionRuleDecision::Allow));
        assert_eq!(state.session_approved().len(), 1);
    }

    #[test]
    fn test_session_approval_isolated_from_rules() {
        let state = PermissionState::new();
        state.record_session_approval(rule("Bash", PermissionRuleDecision::Allow));
        assert!(state.rules().is_empty());
        assert_eq!(state.session_approved().len(), 1);
    }

    #[test]
    fn test_mode_defaults_manual_and_is_shared() {
        use crate::permission::types::PermissionMode;
        let state = PermissionState::new();
        assert_eq!(state.mode(), PermissionMode::Manual);
        let clone = state.clone();
        clone.set_mode(PermissionMode::Yolo);
        // The original observes the mode change made through the clone.
        assert_eq!(state.mode(), PermissionMode::Yolo);
    }
}
