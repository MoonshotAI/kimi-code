/// `plan` injection — plan-mode reminder selection.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/plan/injection/planModeInjection.ts`.
///
/// While plan mode is active the injector emits the full / sparse / re-entry
/// reminders, deduped against recent history by counting assistant turns
/// since the last injection; on the first inject after deactivation it emits
/// the exit reminder once. Whether a plan *file* exists picks between the
/// file-backed and inline template families.
use crate::context::types::ContextMessage;

pub const PLAN_MODE_INJECTION_VARIANT: &str = "plan_mode";

const PLAN_MODE_DEDUP_MIN_TURNS: usize = 2;
const PLAN_MODE_FULL_REFRESH_TURNS: usize = 5;

pub const PLAN_MODE_EXIT_REMINDER: &str = include_str!("reminders/plan-mode-exit-reminder.md");
pub const PLAN_MODE_FULL_REMINDER: &str = include_str!("reminders/plan-mode-full-reminder.md");
pub const PLAN_MODE_SPARSE_REMINDER: &str = include_str!("reminders/plan-mode-sparse-reminder.md");
pub const PLAN_MODE_REENTRY_REMINDER: &str =
    include_str!("reminders/plan-mode-reentry-reminder.md");
pub const PLAN_MODE_INLINE_FULL_REMINDER: &str =
    include_str!("reminders/plan-mode-inline-full-reminder.md");
pub const PLAN_MODE_INLINE_SPARSE_REMINDER: &str =
    include_str!("reminders/plan-mode-inline-sparse-reminder.md");
pub const PLAN_MODE_INLINE_REENTRY_REMINDER: &str =
    include_str!("reminders/plan-mode-inline-reentry-reminder.md");

/// Which reminder to emit on an active-plan inject.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanModeReminderVariant {
    Full,
    Sparse,
}

/// Decide the reminder variant from the injection position and history.
///
/// A user message after the last injection always forces a full refresh — the
/// user may have changed direction. Otherwise assistant turns since the last
/// injection pick full (≥5), sparse (≥2), or nothing (still fresh).
pub fn plan_mode_reminder_variant(
    injected_at: Option<usize>,
    history: &[ContextMessage],
) -> Option<PlanModeReminderVariant> {
    let Some(injected_at) = injected_at else {
        return Some(PlanModeReminderVariant::Full);
    };
    let mut assistant_turns_since = 0usize;
    for message in history.iter().skip(injected_at + 1) {
        if message.role == "assistant" {
            assistant_turns_since += 1;
            continue;
        }
        if message.role == "user" {
            return Some(PlanModeReminderVariant::Full);
        }
    }
    if assistant_turns_since >= PLAN_MODE_FULL_REFRESH_TURNS {
        return Some(PlanModeReminderVariant::Full);
    }
    if assistant_turns_since >= PLAN_MODE_DEDUP_MIN_TURNS {
        return Some(PlanModeReminderVariant::Sparse);
    }
    None
}

fn with_plan_file_footer(body: &str, plan_file_path: &str) -> String {
    format!("{body}\n\nPlan file: {plan_file_path}")
}

pub fn full_reminder(plan_file_path: Option<&str>) -> String {
    match plan_file_path.filter(|path| !path.is_empty()) {
        Some(path) => with_plan_file_footer(PLAN_MODE_FULL_REMINDER, path),
        None => PLAN_MODE_INLINE_FULL_REMINDER.to_string(),
    }
}

pub fn sparse_reminder(plan_file_path: Option<&str>) -> String {
    match plan_file_path.filter(|path| !path.is_empty()) {
        Some(path) => with_plan_file_footer(PLAN_MODE_SPARSE_REMINDER, path),
        None => PLAN_MODE_INLINE_SPARSE_REMINDER.to_string(),
    }
}

pub fn reentry_reminder(plan_file_path: Option<&str>) -> String {
    match plan_file_path.filter(|path| !path.is_empty()) {
        Some(path) => with_plan_file_footer(PLAN_MODE_REENTRY_REMINDER, path),
        None => PLAN_MODE_INLINE_REENTRY_REMINDER.to_string(),
    }
}

/// The injection provider's per-agent state (the TS closure's `wasActive`).
#[derive(Debug, Default)]
pub struct PlanModeInjection {
    was_active: bool,
}

/// The live plan status the provider reads (TS `PlanData`).
#[derive(Debug, Clone)]
pub struct PlanStatus {
    pub content: String,
    pub path: Option<String>,
}

impl PlanModeInjection {
    pub fn new() -> Self {
        Self::default()
    }

    /// The reminder to inject at this boundary, if any.
    ///
    /// `status` is `None` when plan mode is inactive; `injected_at` is the
    /// history index of this provider's previous injection.
    pub fn inject(
        &mut self,
        status: Option<&PlanStatus>,
        injected_at: Option<usize>,
        history: &[ContextMessage],
    ) -> Option<String> {
        let Some(status) = status else {
            if !self.was_active {
                return None;
            }
            self.was_active = false;
            return Some(PLAN_MODE_EXIT_REMINDER.to_string());
        };
        let plan_file_path = status.path.as_deref();
        if !self.was_active {
            self.was_active = true;
            if !status.content.trim().is_empty() {
                return Some(reentry_reminder(plan_file_path));
            }
            return Some(full_reminder(plan_file_path));
        }
        match plan_mode_reminder_variant(injected_at, history) {
            Some(PlanModeReminderVariant::Full) => Some(full_reminder(plan_file_path)),
            Some(PlanModeReminderVariant::Sparse) => Some(sparse_reminder(plan_file_path)),
            None => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::types::{ContentPart, MessageOrigin};

    fn message(role: &str) -> ContextMessage {
        ContextMessage {
            role: role.to_string(),
            content: vec![ContentPart::Text { text: "x".to_string() }],
            origin: if role == "user" { Some(MessageOrigin::User) } else { None },
            ..Default::default()
        }
    }

    fn history(roles: &[&str]) -> Vec<ContextMessage> {
        roles.iter().map(|role| message(role)).collect()
    }

    fn active(content: &str, path: Option<&str>) -> PlanStatus {
        PlanStatus { content: content.to_string(), path: path.map(str::to_string) }
    }

    // ── variant selection ─────────────────────────────────────────────────

    #[test]
    fn the_first_injection_is_always_full() {
        assert_eq!(
            plan_mode_reminder_variant(None, &[]),
            Some(PlanModeReminderVariant::Full)
        );
    }

    #[test]
    fn a_user_message_since_the_last_injection_forces_full() {
        let history = history(&["assistant", "user"]);
        assert_eq!(
            plan_mode_reminder_variant(Some(0), &history[..]),
            Some(PlanModeReminderVariant::Full)
        );
    }

    #[test]
    fn few_assistant_turns_suppress_the_reminder() {
        let history = history(&["assistant", "assistant"]);
        assert_eq!(plan_mode_reminder_variant(Some(0), &history[..1]), None);
    }

    #[test]
    fn two_assistant_turns_earn_a_sparse_reminder() {
        // injected_at = 0, two assistant messages after it.
        let history = history(&["user", "assistant", "assistant"]);
        assert_eq!(
            plan_mode_reminder_variant(Some(0), &history),
            Some(PlanModeReminderVariant::Sparse)
        );
    }

    #[test]
    fn five_assistant_turns_earn_a_full_refresh() {
        let mut roles = vec!["user"];
        roles.extend(std::iter::repeat_n("assistant", 5));
        let history = history(&roles);
        assert_eq!(
            plan_mode_reminder_variant(Some(0), &history),
            Some(PlanModeReminderVariant::Full)
        );
    }

    #[test]
    fn tool_messages_neither_count_nor_force() {
        let history = history(&["user", "tool", "tool", "tool"]);
        assert_eq!(plan_mode_reminder_variant(Some(0), &history), None);
    }

    // ── template selection ────────────────────────────────────────────────

    #[test]
    fn file_backed_reminders_carry_the_plan_file_footer() {
        let text = full_reminder(Some("plan/plan-1.md"));
        assert!(text.starts_with(PLAN_MODE_FULL_REMINDER));
        assert!(text.ends_with("Plan file: plan/plan-1.md"));
    }

    #[test]
    fn inline_reminders_are_used_without_a_file() {
        assert_eq!(full_reminder(None), PLAN_MODE_INLINE_FULL_REMINDER);
        assert_eq!(full_reminder(Some("")), PLAN_MODE_INLINE_FULL_REMINDER);
        assert_eq!(sparse_reminder(None), PLAN_MODE_INLINE_SPARSE_REMINDER);
        assert_eq!(reentry_reminder(None), PLAN_MODE_INLINE_REENTRY_REMINDER);
    }

    // ── provider state machine ────────────────────────────────────────────

    #[test]
    fn activation_with_an_empty_plan_emits_the_full_reminder() {
        let mut injection = PlanModeInjection::new();
        let text = injection.inject(Some(&active("", Some("plan/p.md"))), None, &[]).unwrap();
        assert!(text.starts_with(PLAN_MODE_FULL_REMINDER));
    }

    #[test]
    fn activation_with_existing_content_emits_the_reentry_reminder() {
        let mut injection = PlanModeInjection::new();
        let text = injection
            .inject(Some(&active("## Plan\n1. do things", Some("plan/p.md"))), None, &[])
            .unwrap();
        assert!(text.starts_with(PLAN_MODE_REENTRY_REMINDER));
    }

    #[test]
    fn deactivation_emits_the_exit_reminder_exactly_once() {
        let mut injection = PlanModeInjection::new();
        injection.inject(Some(&active("", None)), None, &[]);
        assert_eq!(injection.inject(None, None, &[]), Some(PLAN_MODE_EXIT_REMINDER.to_string()));
        assert_eq!(injection.inject(None, None, &[]), None, "only the first inject after exit");
    }

    #[test]
    fn inactive_from_the_start_emits_nothing() {
        let mut injection = PlanModeInjection::new();
        assert_eq!(injection.inject(None, None, &[]), None);
    }

    #[test]
    fn while_active_the_variant_rules_apply() {
        let mut injection = PlanModeInjection::new();
        let status = active("", None);
        injection.inject(Some(&status), None, &[]);
        // Fresh injection at index 0, nothing since → suppressed.
        let quiet = history(&["user"]);
        assert_eq!(injection.inject(Some(&status), Some(0), &quiet), None);
        // A user message after it → full again.
        let busy = history(&["user", "assistant", "user"]);
        assert_eq!(
            injection.inject(Some(&status), Some(0), &busy),
            Some(PLAN_MODE_INLINE_FULL_REMINDER.to_string())
        );
    }
}
