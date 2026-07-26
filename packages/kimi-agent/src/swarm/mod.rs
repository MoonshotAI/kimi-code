/// SwarmMode — multi-agent orchestration mode state machine.
///
/// Corresponds to `packages/agent-core/src/agent/swarm/index.ts`.
///
/// Tracks whether the agent is in swarm mode and the trigger that
/// activated it. Swarm mode enables multi-agent orchestration where
/// the model can delegate tasks to sub-agents.

use serde::{Deserialize, Serialize};

/// Trigger for entering swarm mode.
///
/// - `manual` = persistent toggle (/swarm on)
/// - `task` = one-shot /swarm prompt
/// - `tool` = AgentSwarm tool entry
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SwarmModeTrigger {
    Manual,
    Task,
    Tool,
}

/// SwarmMode state machine.
pub struct SwarmMode {
    active: Option<SwarmModeTrigger>,
}

impl SwarmMode {
    /// Create a new SwarmMode (inactive).
    pub fn new() -> Self {
        Self { active: None }
    }

    /// Enter swarm mode with the given trigger.
    /// No-op if already active.
    pub fn enter(&mut self, trigger: SwarmModeTrigger) {
        if self.active.is_some() {
            return;
        }
        self.active = Some(trigger);
    }

    /// Restore swarm mode from a persisted state (replay).
    pub fn restore_enter(&mut self, trigger: SwarmModeTrigger) {
        self.active = Some(trigger);
    }

    /// Exit swarm mode.
    /// No-op if not active.
    pub fn exit(&mut self) {
        self.active = None;
    }

    /// Whether swarm mode is currently active.
    pub fn is_active(&self) -> bool {
        self.active.is_some()
    }

    /// Whether the agent should auto-exit swarm mode after the current turn.
    /// Returns true for `Task` and `Tool` triggers (one-shot), false for `Manual`.
    pub fn should_auto_exit(&self) -> bool {
        matches!(self.active, Some(SwarmModeTrigger::Task | SwarmModeTrigger::Tool))
    }

    /// The current trigger, if any.
    pub fn trigger(&self) -> Option<SwarmModeTrigger> {
        self.active
    }
}

impl Default for SwarmMode {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_swarm_mode_inactive() {
        let sm = SwarmMode::new();
        assert!(!sm.is_active());
        assert!(!sm.should_auto_exit());
        assert!(sm.trigger().is_none());
    }

    #[test]
    fn test_enter_activates() {
        let mut sm = SwarmMode::new();
        sm.enter(SwarmModeTrigger::Manual);
        assert!(sm.is_active());
        assert_eq!(sm.trigger(), Some(SwarmModeTrigger::Manual));
    }

    #[test]
    fn test_enter_twice_noop() {
        let mut sm = SwarmMode::new();
        sm.enter(SwarmModeTrigger::Manual);
        sm.enter(SwarmModeTrigger::Task); // Should be no-op
        assert_eq!(sm.trigger(), Some(SwarmModeTrigger::Manual));
    }

    #[test]
    fn test_exit_deactivates() {
        let mut sm = SwarmMode::new();
        sm.enter(SwarmModeTrigger::Manual);
        sm.exit();
        assert!(!sm.is_active());
        assert!(sm.trigger().is_none());
    }

    #[test]
    fn test_exit_when_inactive_is_noop() {
        let mut sm = SwarmMode::new();
        sm.exit(); // Should not panic
        assert!(!sm.is_active());
    }

    #[test]
    fn test_should_auto_exit() {
        let mut sm = SwarmMode::new();
        assert!(!sm.should_auto_exit()); // Inactive = false

        sm.enter(SwarmModeTrigger::Manual);
        assert!(!sm.should_auto_exit());

        sm.exit();
        sm.enter(SwarmModeTrigger::Task);
        assert!(sm.should_auto_exit());

        sm.exit();
        sm.enter(SwarmModeTrigger::Tool);
        assert!(sm.should_auto_exit());
    }

    #[test]
    fn test_restore_enter() {
        let mut sm = SwarmMode::new();
        sm.restore_enter(SwarmModeTrigger::Tool);
        assert!(sm.is_active());
        assert_eq!(sm.trigger(), Some(SwarmModeTrigger::Tool));
    }

    #[test]
    fn test_default_is_inactive() {
        let sm: SwarmMode = Default::default();
        assert!(!sm.is_active());
    }
}