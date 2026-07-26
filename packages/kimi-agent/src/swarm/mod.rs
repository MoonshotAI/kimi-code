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

// ── Service semantics (agent-core-v2 swarmService.ts) ──────────────────────

/// The enter reminder, verbatim from `swarm/enter-reminder.md`.
pub const SWARM_MODE_ENTER_REMINDER: &str = include_str!("enter_reminder.md");

/// The exit reminder, verbatim from `swarm/exit-reminder.md`.
pub const SWARM_MODE_EXIT_REMINDER: &str = include_str!("exit_reminder.md");

/// Injection variant of the enter reminder (popped on exit).
pub const SWARM_MODE_INJECTION_VARIANT: &str = "swarm_mode";

/// Injection variant of the exit reminder (never popped).
pub const SWARM_MODE_EXIT_INJECTION_VARIANT: &str = "swarm_mode_exit";

/// What entering swarm mode asks of the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwarmEnterEffect {
    /// Already active, or the `tool` trigger — nothing to inject.
    None,
    /// Append [`SWARM_MODE_ENTER_REMINDER`] as a `swarm_mode` injection.
    AppendEnterReminder,
}

/// What exiting swarm mode asks of the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwarmExitEffect {
    /// Was not active, or the `tool` trigger — nothing context-visible.
    None,
    /// The trailing enter reminder was removed; publish the splice.
    PoppedReminder,
    /// No trailing reminder to pop; append [`SWARM_MODE_EXIT_REMINDER`]
    /// as a `swarm_mode_exit` injection.
    AppendExitReminder,
}

impl SwarmMode {
    /// Enter swarm mode and report the reminder side effect.
    ///
    /// The `tool` trigger enters silently: the AgentSwarm tool call itself is
    /// the model's context, so no reminder is injected for it — and none is
    /// popped on exit.
    pub fn enter_with_effect(&mut self, trigger: SwarmModeTrigger) -> SwarmEnterEffect {
        if self.active.is_some() {
            return SwarmEnterEffect::None;
        }
        self.active = Some(trigger);
        if trigger == SwarmModeTrigger::Tool {
            return SwarmEnterEffect::None;
        }
        SwarmEnterEffect::AppendEnterReminder
    }

    /// Enter swarm mode, applying the reminder to the context directly.
    pub fn enter_with_context(
        &mut self,
        trigger: SwarmModeTrigger,
        context: &mut crate::context::context_memory::ContextMemory,
    ) -> SwarmEnterEffect {
        let effect = self.enter_with_effect(trigger);
        if effect == SwarmEnterEffect::AppendEnterReminder {
            context.append_system_reminder(
                SWARM_MODE_ENTER_REMINDER,
                crate::context::types::MessageOrigin::Injection {
                    variant: SWARM_MODE_INJECTION_VARIANT.to_string(),
                },
            );
        }
        effect
    }

    /// Exit swarm mode, popping the enter reminder when it is still the last
    /// message and appending the exit reminder otherwise.
    ///
    /// Mirrors `AgentSwarmService.exit`: the pop keeps a still-trailing enter
    /// reminder from surviving into a context that is no longer in swarm mode,
    /// while an enter reminder buried under later conversation is left alone
    /// and the exit reminder states the mode change instead.
    pub fn exit_with_context(
        &mut self,
        context: &mut crate::context::context_memory::ContextMemory,
    ) -> SwarmExitEffect {
        let Some(trigger) = self.active.take() else {
            return SwarmExitEffect::None;
        };
        if trigger == SwarmModeTrigger::Tool {
            return SwarmExitEffect::None;
        }
        if context.pop_swarm_mode_reminder().is_some() {
            return SwarmExitEffect::PoppedReminder;
        }
        context.append_system_reminder(
            SWARM_MODE_EXIT_REMINDER,
            crate::context::types::MessageOrigin::Injection {
                variant: SWARM_MODE_EXIT_INJECTION_VARIANT.to_string(),
            },
        );
        SwarmExitEffect::AppendExitReminder
    }
}

// ── Batch exclusivity vetoes ───────────────────────────────────────────────

/// Why an AgentSwarm batch is denied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentSwarmBatchVeto {
    /// More than one AgentSwarm call, nothing else in the batch.
    MultipleDenied,
    /// More than one AgentSwarm call mixed with other tools.
    MultipleDeniedMixed,
    /// One AgentSwarm call mixed with other tools.
    MixedDenied,
}

/// Model-facing veto strings. TS resolves these through i18n (`t(...)`), so
/// the host may substitute its locale's rendering; the defaults are the
/// English locale verbatim.
#[derive(Debug, Clone)]
pub struct SwarmVetoMessages {
    pub multiple_denied: String,
    pub multiple_denied_mixed: String,
    pub mixed_denied: String,
    pub agent_denied_in_swarm_mode: String,
}

impl Default for SwarmVetoMessages {
    fn default() -> Self {
        Self {
            multiple_denied: "AgentSwarm must be called one swarm at a time. Multiple AgentSwarm calls are not forbidden, but issue them sequentially: call one AgentSwarm, wait for its result, then call the next; or merge the work into a single AgentSwarm when one swarm can cover it.".to_string(),
            multiple_denied_mixed: "AgentSwarm must be called one swarm at a time. Multiple AgentSwarm calls are not forbidden, but issue them sequentially: call one AgentSwarm, wait for its result, then call the next; or merge the work into a single AgentSwarm when one swarm can cover it. AgentSwarm also must not be combined with other tools in the same response.".to_string(),
            mixed_denied: "AgentSwarm must be the only tool call in a model response. Retry with a single AgentSwarm call by itself, then call any other tools after it returns.".to_string(),
            agent_denied_in_swarm_mode: "The Agent tool is not available in swarm mode. Use AgentSwarm to dispatch subagents in parallel instead. If you need a single subagent, use AgentSwarm with one item or one resume_agent_ids entry.".to_string(),
        }
    }
}

impl SwarmVetoMessages {
    pub fn for_batch_veto(&self, veto: AgentSwarmBatchVeto) -> &str {
        match veto {
            AgentSwarmBatchVeto::MultipleDenied => &self.multiple_denied,
            AgentSwarmBatchVeto::MultipleDeniedMixed => &self.multiple_denied_mixed,
            AgentSwarmBatchVeto::MixedDenied => &self.mixed_denied,
        }
    }
}

pub const AGENT_SWARM_TOOL_NAME: &str = "AgentSwarm";
pub const AGENT_TOOL_NAME: &str = "Agent";

/// AgentSwarm batch exclusivity: an AgentSwarm call must be the only call in
/// its batch. Mirrors the service's `onBeforeExecuteTool` veto.
pub fn check_agent_swarm_batch(tool_names: &[&str]) -> Option<AgentSwarmBatchVeto> {
    let swarm_count = tool_names.iter().filter(|name| **name == AGENT_SWARM_TOOL_NAME).count();
    if swarm_count == 0 || (swarm_count == 1 && tool_names.len() == 1) {
        return None;
    }
    if swarm_count > 1 {
        return Some(if tool_names.len() > swarm_count {
            AgentSwarmBatchVeto::MultipleDeniedMixed
        } else {
            AgentSwarmBatchVeto::MultipleDenied
        });
    }
    Some(AgentSwarmBatchVeto::MixedDenied)
}

/// The hard enforcement behind the enter reminder: the `Agent` tool is denied
/// outright while swarm mode is active.
pub fn deny_agent_in_swarm_mode(is_active: bool, tool_name: &str) -> bool {
    is_active && tool_name == AGENT_TOOL_NAME
}

#[cfg(test)]
mod service_tests {
    use super::*;
    use crate::context::context_memory::ContextMemory;
    use crate::context::types::{ContentPart, MessageOrigin};

    fn text_of(message: &crate::context::types::ContextMessage) -> String {
        message
            .content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    // ── enter ─────────────────────────────────────────────────────────────

    #[test]
    fn manual_enter_appends_the_enter_reminder() {
        let mut swarm = SwarmMode::new();
        let mut context = ContextMemory::new();
        let effect = swarm.enter_with_context(SwarmModeTrigger::Manual, &mut context);
        assert_eq!(effect, SwarmEnterEffect::AppendEnterReminder);
        assert_eq!(context.len(), 1);
        let message = &context.history()[0];
        assert!(matches!(
            &message.origin,
            Some(MessageOrigin::Injection { variant }) if variant == SWARM_MODE_INJECTION_VARIANT
        ));
        assert!(text_of(message).contains("agent swarm"));
    }

    #[test]
    fn tool_enter_is_silent() {
        let mut swarm = SwarmMode::new();
        let mut context = ContextMemory::new();
        let effect = swarm.enter_with_context(SwarmModeTrigger::Tool, &mut context);
        assert_eq!(effect, SwarmEnterEffect::None);
        assert!(context.is_empty());
        assert!(swarm.is_active());
    }

    #[test]
    fn re_entry_does_not_duplicate_the_reminder() {
        let mut swarm = SwarmMode::new();
        let mut context = ContextMemory::new();
        swarm.enter_with_context(SwarmModeTrigger::Manual, &mut context);
        let effect = swarm.enter_with_context(SwarmModeTrigger::Task, &mut context);
        assert_eq!(effect, SwarmEnterEffect::None);
        assert_eq!(context.len(), 1);
        assert_eq!(swarm.trigger(), Some(SwarmModeTrigger::Manual), "first trigger wins");
    }

    // ── exit ──────────────────────────────────────────────────────────────

    #[test]
    fn exit_pops_a_still_trailing_enter_reminder() {
        let mut swarm = SwarmMode::new();
        let mut context = ContextMemory::new();
        swarm.enter_with_context(SwarmModeTrigger::Manual, &mut context);
        let effect = swarm.exit_with_context(&mut context);
        assert_eq!(effect, SwarmExitEffect::PoppedReminder);
        assert!(context.is_empty(), "the reminder is gone, no exit note added");
        assert!(!swarm.is_active());
    }

    #[test]
    fn exit_appends_the_exit_reminder_when_conversation_intervened() {
        let mut swarm = SwarmMode::new();
        let mut context = ContextMemory::new();
        swarm.enter_with_context(SwarmModeTrigger::Manual, &mut context);
        context.append_user_message(
            &[ContentPart::Text { text: "do the work".to_string() }],
            MessageOrigin::User,
        );
        let effect = swarm.exit_with_context(&mut context);
        assert_eq!(effect, SwarmExitEffect::AppendExitReminder);
        assert_eq!(context.len(), 3);
        let last = context.history().last().unwrap();
        assert!(matches!(
            &last.origin,
            Some(MessageOrigin::Injection { variant })
                if variant == SWARM_MODE_EXIT_INJECTION_VARIANT
        ));
        assert!(text_of(last).contains("Swarm Mode has ended"));
    }

    #[test]
    fn tool_exit_touches_nothing() {
        let mut swarm = SwarmMode::new();
        let mut context = ContextMemory::new();
        swarm.enter_with_context(SwarmModeTrigger::Tool, &mut context);
        let effect = swarm.exit_with_context(&mut context);
        assert_eq!(effect, SwarmExitEffect::None);
        assert!(context.is_empty());
        assert!(!swarm.is_active());
    }

    #[test]
    fn exit_when_inactive_is_a_no_op() {
        let mut swarm = SwarmMode::new();
        let mut context = ContextMemory::new();
        assert_eq!(swarm.exit_with_context(&mut context), SwarmExitEffect::None);
    }

    #[test]
    fn the_full_manual_cycle_leaves_a_clean_context() {
        // enter → work → exit → the exit note is the only swarm trace left.
        let mut swarm = SwarmMode::new();
        let mut context = ContextMemory::new();
        swarm.enter_with_context(SwarmModeTrigger::Task, &mut context);
        context.append_user_message(
            &[ContentPart::Text { text: "go".to_string() }],
            MessageOrigin::User,
        );
        assert!(swarm.should_auto_exit(), "task trigger auto-exits at turn end");
        swarm.exit_with_context(&mut context);
        let variants: Vec<String> = context
            .history()
            .iter()
            .filter_map(|m| match &m.origin {
                Some(MessageOrigin::Injection { variant }) => Some(variant.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            variants,
            vec![
                SWARM_MODE_INJECTION_VARIANT.to_string(),
                SWARM_MODE_EXIT_INJECTION_VARIANT.to_string(),
            ]
        );
    }

    // ── batch vetoes ──────────────────────────────────────────────────────

    #[test]
    fn a_lone_agent_swarm_call_passes() {
        assert_eq!(check_agent_swarm_batch(&["AgentSwarm"]), None);
    }

    #[test]
    fn a_batch_without_agent_swarm_passes() {
        assert_eq!(check_agent_swarm_batch(&["Read", "Grep"]), None);
        assert_eq!(check_agent_swarm_batch(&[]), None);
    }

    #[test]
    fn agent_swarm_mixed_with_other_tools_is_vetoed() {
        assert_eq!(
            check_agent_swarm_batch(&["AgentSwarm", "Read"]),
            Some(AgentSwarmBatchVeto::MixedDenied)
        );
    }

    #[test]
    fn multiple_agent_swarm_calls_are_vetoed() {
        assert_eq!(
            check_agent_swarm_batch(&["AgentSwarm", "AgentSwarm"]),
            Some(AgentSwarmBatchVeto::MultipleDenied)
        );
    }

    #[test]
    fn multiple_agent_swarm_calls_plus_other_tools_use_the_mixed_wording() {
        assert_eq!(
            check_agent_swarm_batch(&["AgentSwarm", "AgentSwarm", "Read"]),
            Some(AgentSwarmBatchVeto::MultipleDeniedMixed)
        );
    }

    #[test]
    fn veto_messages_resolve_by_kind() {
        let messages = SwarmVetoMessages::default();
        assert!(messages
            .for_batch_veto(AgentSwarmBatchVeto::MixedDenied)
            .contains("must be the only tool call"));
        assert!(messages
            .for_batch_veto(AgentSwarmBatchVeto::MultipleDenied)
            .contains("one swarm at a time"));
        assert!(messages
            .for_batch_veto(AgentSwarmBatchVeto::MultipleDeniedMixed)
            .contains("must not be combined"));
    }

    // ── agent-in-swarm veto ───────────────────────────────────────────────

    #[test]
    fn the_agent_tool_is_denied_only_while_swarm_is_active() {
        assert!(deny_agent_in_swarm_mode(true, "Agent"));
        assert!(!deny_agent_in_swarm_mode(false, "Agent"));
        assert!(!deny_agent_in_swarm_mode(true, "AgentSwarm"));
        assert!(!deny_agent_in_swarm_mode(true, "Read"));
    }

    #[test]
    fn the_agent_denied_message_names_the_alternative() {
        let messages = SwarmVetoMessages::default();
        assert!(messages.agent_denied_in_swarm_mode.contains("Use AgentSwarm"));
        assert!(messages.agent_denied_in_swarm_mode.contains("resume_agent_ids"));
    }
}