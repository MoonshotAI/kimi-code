/// Goal injection — the v2 per-status goal reminders.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/goal/injection/goalInjection.ts`.
///
/// At each new-turn boundary the injector renders one reminder for the current
/// goal status: the full driving reminder while `active`, lighter notes for
/// `blocked` / `paused`, and the wind-down note for `budget_limited`.
/// Objective and criterion are user data — they are XML-escaped and wrapped in
/// `<untrusted_*>` tags so they cannot impersonate instructions.
use crate::goal::{GoalSnapshot, GoalStatus};

pub const GOAL_ACTIVE_REMINDER: &str = include_str!("reminders/goal-active-reminder.md");
pub const GOAL_BLOCKED_REMINDER: &str = include_str!("reminders/goal-blocked-reminder.md");
pub const GOAL_PAUSED_REMINDER: &str = include_str!("reminders/goal-paused-reminder.md");
pub const GOAL_BUDGET_LIMITED_REMINDER: &str =
    include_str!("reminders/goal-budget-limited-reminder.md");

const BUDGET_GUIDANCE_NEARING: &str = "Budget guidance: you are nearing a budget. Converge on the objective and avoid starting new discretionary work.";
const BUDGET_GUIDANCE_WITHIN: &str = "Budget guidance: you are within budget. Make steady, focused progress toward the objective.";

/// Share of any budget at which the guidance flips to "nearing".
const NEARING_BUDGET_FRACTION: f64 = 0.75;

/// The reminder for the goal's current status, if its status has one.
///
/// `complete` (and any future terminal status) renders nothing — a completed
/// goal is cleared, not re-announced.
pub fn goal_reminder(goal: &GoalSnapshot) -> Option<String> {
    match goal.status {
        GoalStatus::Active => Some(build_goal_reminder(goal)),
        GoalStatus::Blocked => Some(build_blocked_note(goal)),
        GoalStatus::Paused => Some(build_paused_note(goal)),
        GoalStatus::BudgetLimited => Some(build_budget_limited_note(goal)),
        _ => None,
    }
}

/// The full active-goal reminder, with progress, budgets, and guidance.
pub fn build_goal_reminder(goal: &GoalSnapshot) -> String {
    let budgets = format_budgets(goal);
    render_prompt(
        GOAL_ACTIVE_REMINDER,
        &[
            ("objective", escape_untrusted_text(&goal.objective)),
            ("completion_criterion_block", completion_criterion_block(goal)),
            ("status", goal_status_label(goal.status).to_string()),
            ("progress", progress_line(goal)),
            (
                "budgets_block",
                if budgets.is_empty() { String::new() } else { format!("Budgets: {budgets}.\n") },
            ),
            (
                "budget_guidance",
                if is_nearing_budget(goal) {
                    BUDGET_GUIDANCE_NEARING.to_string()
                } else {
                    BUDGET_GUIDANCE_WITHIN.to_string()
                },
            ),
        ],
    )
}

pub fn build_blocked_note(goal: &GoalSnapshot) -> String {
    render_prompt(
        GOAL_BLOCKED_REMINDER,
        &[
            ("reason_suffix", reason_suffix(goal)),
            ("objective", escape_untrusted_text(&goal.objective)),
            ("completion_criterion_block", completion_criterion_block(goal)),
        ],
    )
}

pub fn build_paused_note(goal: &GoalSnapshot) -> String {
    render_prompt(
        GOAL_PAUSED_REMINDER,
        &[
            ("reason_suffix", reason_suffix(goal)),
            ("objective", escape_untrusted_text(&goal.objective)),
            ("completion_criterion_block", completion_criterion_block(goal)),
        ],
    )
}

pub fn build_budget_limited_note(goal: &GoalSnapshot) -> String {
    render_prompt(
        GOAL_BUDGET_LIMITED_REMINDER,
        &[
            ("objective", escape_untrusted_text(&goal.objective)),
            ("completion_criterion_block", completion_criterion_block(goal)),
            ("status", goal_status_label(goal.status).to_string()),
            ("progress", progress_line(goal)),
        ],
    )
}

/// The wire spelling of a status inside reminders.
fn goal_status_label(status: GoalStatus) -> &'static str {
    match status {
        GoalStatus::Active => "active",
        GoalStatus::Paused => "paused",
        GoalStatus::Blocked => "blocked",
        GoalStatus::Complete => "complete",
        GoalStatus::BudgetLimited => "budget_limited",
        GoalStatus::UsageLimited => "usage_limited",
    }
}

fn progress_line(goal: &GoalSnapshot) -> String {
    format!(
        "{} continuation turns, {} tokens, {} elapsed",
        goal.turns_used,
        goal.tokens_used,
        format_elapsed(goal.wall_clock_ms)
    )
}

fn reason_suffix(goal: &GoalSnapshot) -> String {
    match &goal.terminal_reason {
        Some(reason) => format!(" ({})", escape_untrusted_text(reason)),
        None => String::new(),
    }
}

fn completion_criterion_block(goal: &GoalSnapshot) -> String {
    match &goal.completion_criterion {
        Some(criterion) => format!(
            "<untrusted_completion_criterion>\n{}\n</untrusted_completion_criterion>\n",
            escape_untrusted_text(criterion)
        ),
        None => String::new(),
    }
}

fn format_budgets(goal: &GoalSnapshot) -> String {
    let mut budget_lines: Vec<String> = Vec::new();
    if let Some(turn_budget) = goal.budget.turn_budget {
        budget_lines.push(format!(
            "turns {}/{} (remaining {})",
            goal.turns_used,
            turn_budget,
            goal.budget.remaining_turns.unwrap_or(0)
        ));
    }
    if let Some(token_budget) = goal.budget.token_budget {
        budget_lines.push(format!(
            "tokens {}/{} (remaining {})",
            goal.tokens_used,
            token_budget,
            goal.budget.remaining_tokens.unwrap_or(0)
        ));
    }
    if let Some(wall_clock_budget_ms) = goal.budget.wall_clock_budget_ms {
        budget_lines.push(format!(
            "time {}/{} (remaining {})",
            format_elapsed(goal.wall_clock_ms),
            format_elapsed(wall_clock_budget_ms),
            format_elapsed(goal.budget.remaining_wall_clock_ms.unwrap_or(0))
        ));
    }
    budget_lines.join("; ")
}

fn is_nearing_budget(goal: &GoalSnapshot) -> bool {
    max_budget_fraction(goal) >= NEARING_BUDGET_FRACTION
}

fn max_budget_fraction(goal: &GoalSnapshot) -> f64 {
    let mut fractions: Vec<f64> = Vec::new();
    if let Some(turn_budget) = goal.budget.turn_budget.filter(|budget| *budget > 0) {
        fractions.push(goal.turns_used as f64 / turn_budget as f64);
    }
    if let Some(token_budget) = goal.budget.token_budget.filter(|budget| *budget > 0) {
        fractions.push(goal.tokens_used as f64 / token_budget as f64);
    }
    if let Some(wall_budget) = goal.budget.wall_clock_budget_ms.filter(|budget| *budget > 0) {
        fractions.push(goal.wall_clock_ms as f64 / wall_budget as f64);
    }
    fractions.into_iter().fold(0.0, f64::max)
}

/// TS `escapeUntrustedText`: `&`, `<`, `>` only — attribute quoting is not
/// needed inside element content.
pub fn escape_untrusted_text(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// TS `formatElapsed`: `47s`, `3m05s`, `2h07m`.
pub fn format_elapsed(ms: u64) -> String {
    let total_seconds = (ms as f64 / 1000.0).round() as u64;
    if total_seconds < 60 {
        return format!("{total_seconds}s");
    }
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    if minutes < 60 {
        return format!("{minutes}m{seconds:02}s");
    }
    let hours = minutes / 60;
    format!("{hours}h{:02}m", minutes % 60)
}

/// The single-pass `${var}` substitution from `render-prompt.ts`: known
/// variables are replaced, unknown placeholders stay verbatim, a bare `$` is
/// never special.
fn render_prompt(template: &str, vars: &[(&str, String)]) -> String {
    let mut output = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("${") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find('}') {
            Some(end) => {
                let name = &after[..end];
                match vars.iter().find(|(key, _)| *key == name) {
                    Some((_, value)) => output.push_str(value),
                    None => {
                        output.push_str("${");
                        output.push_str(name);
                        output.push('}');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                output.push_str("${");
                rest = after;
            }
        }
    }
    output.push_str(rest);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::goal::GoalBudgetReport;

    fn snapshot(status: GoalStatus) -> GoalSnapshot {
        GoalSnapshot {
            goal_id: "g1".to_string(),
            objective: "ship the feature".to_string(),
            completion_criterion: Some("tests pass".to_string()),
            status,
            turns_used: 3,
            tokens_used: 12_000,
            wall_clock_ms: 125_000,
            budget: GoalBudgetReport {
                token_budget: None,
                turn_budget: None,
                wall_clock_budget_ms: None,
                remaining_tokens: None,
                remaining_turns: None,
                remaining_wall_clock_ms: None,
                token_budget_reached: false,
                turn_budget_reached: false,
                wall_clock_budget_reached: false,
                over_budget: false,
            },
            terminal_reason: None,
            blocked_streak: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    // ── status dispatch ───────────────────────────────────────────────────

    #[test]
    fn each_status_gets_its_reminder() {
        assert!(goal_reminder(&snapshot(GoalStatus::Active))
            .unwrap()
            .contains("You are working under an active goal"));
        assert!(goal_reminder(&snapshot(GoalStatus::Blocked))
            .unwrap()
            .contains("currently blocked"));
        assert!(goal_reminder(&snapshot(GoalStatus::Paused)).unwrap().contains("currently paused"));
        assert!(goal_reminder(&snapshot(GoalStatus::BudgetLimited))
            .unwrap()
            .contains("budget-limited"));
    }

    #[test]
    fn complete_and_usage_limited_render_nothing() {
        assert_eq!(goal_reminder(&snapshot(GoalStatus::Complete)), None);
        assert_eq!(goal_reminder(&snapshot(GoalStatus::UsageLimited)), None);
    }

    // ── active reminder ───────────────────────────────────────────────────

    #[test]
    fn the_active_reminder_wraps_untrusted_data() {
        let mut goal = snapshot(GoalStatus::Active);
        goal.objective = "do <script> & stuff".to_string();
        let text = build_goal_reminder(&goal);
        assert!(text.contains("<untrusted_objective>\ndo &lt;script&gt; &amp; stuff\n</untrusted_objective>"));
        assert!(text.contains("<untrusted_completion_criterion>\ntests pass\n</untrusted_completion_criterion>"));
        assert!(!text.contains("${"), "no unfilled placeholders: {text}");
    }

    #[test]
    fn the_active_reminder_reports_progress() {
        let text = build_goal_reminder(&snapshot(GoalStatus::Active));
        assert!(text.contains("Progress: 3 continuation turns, 12000 tokens, 2m05s elapsed."));
        assert!(text.contains("Status: active"));
    }

    #[test]
    fn without_budgets_there_is_no_budget_line_and_guidance_is_within() {
        let text = build_goal_reminder(&snapshot(GoalStatus::Active));
        assert!(!text.contains("Budgets:"));
        assert!(text.contains(BUDGET_GUIDANCE_WITHIN));
    }

    #[test]
    fn budgets_render_with_remaining_amounts() {
        let mut goal = snapshot(GoalStatus::Active);
        goal.budget.turn_budget = Some(10);
        goal.budget.remaining_turns = Some(7);
        goal.budget.token_budget = Some(100_000);
        goal.budget.remaining_tokens = Some(88_000);
        goal.budget.wall_clock_budget_ms = Some(600_000);
        goal.budget.remaining_wall_clock_ms = Some(475_000);
        let text = build_goal_reminder(&goal);
        assert!(text.contains(
            "Budgets: turns 3/10 (remaining 7); tokens 12000/100000 (remaining 88000); time 2m05s/10m00s (remaining 7m55s)."
        ));
    }

    #[test]
    fn nearing_any_budget_flips_the_guidance() {
        let mut goal = snapshot(GoalStatus::Active);
        goal.budget.turn_budget = Some(4); // 3/4 = 0.75 → nearing
        goal.budget.remaining_turns = Some(1);
        let text = build_goal_reminder(&goal);
        assert!(text.contains(BUDGET_GUIDANCE_NEARING));

        goal.budget.turn_budget = Some(5); // 3/5 = 0.6 → within
        let text = build_goal_reminder(&goal);
        assert!(text.contains(BUDGET_GUIDANCE_WITHIN));
    }

    // ── blocked / paused notes ────────────────────────────────────────────

    #[test]
    fn the_blocked_note_carries_the_escaped_reason() {
        let mut goal = snapshot(GoalStatus::Blocked);
        goal.terminal_reason = Some("waiting <auth>".to_string());
        let text = build_blocked_note(&goal);
        assert!(text.contains("currently blocked (waiting &lt;auth&gt;)."));
        assert!(text.contains("/goal resume"));
    }

    #[test]
    fn a_missing_reason_leaves_no_suffix() {
        let text = build_blocked_note(&snapshot(GoalStatus::Blocked));
        assert!(text.contains("currently blocked."));
    }

    #[test]
    fn the_paused_note_requires_update_goal_before_resuming() {
        let text = build_paused_note(&snapshot(GoalStatus::Paused));
        assert!(text.contains("call UpdateGoal with `active` before resuming"));
    }

    #[test]
    fn a_goal_without_a_criterion_renders_no_criterion_block() {
        let mut goal = snapshot(GoalStatus::Paused);
        goal.completion_criterion = None;
        let text = build_paused_note(&goal);
        assert!(!text.contains("untrusted_completion_criterion"));
    }

    // ── budget-limited note ───────────────────────────────────────────────

    #[test]
    fn the_budget_limited_note_offers_the_two_options() {
        let text = build_budget_limited_note(&snapshot(GoalStatus::BudgetLimited));
        assert!(text.contains("<status>budget_limited</status>"));
        assert!(text.contains("Summarize what was accomplished"));
        assert!(text.contains("SetGoalBudget"));
    }

    // ── helpers ───────────────────────────────────────────────────────────

    #[test]
    fn elapsed_formats_match_ts() {
        assert_eq!(format_elapsed(0), "0s");
        assert_eq!(format_elapsed(47_000), "47s");
        assert_eq!(format_elapsed(59_499), "59s");
        assert_eq!(format_elapsed(60_000), "1m00s");
        assert_eq!(format_elapsed(125_000), "2m05s");
        assert_eq!(format_elapsed(3_600_000), "1h00m");
        assert_eq!(format_elapsed(7_620_000), "2h07m");
    }

    #[test]
    fn the_renderer_leaves_unknown_placeholders_verbatim() {
        let rendered = render_prompt("a ${known} and ${unknown} and $bare", &[("known", "K".to_string())]);
        assert_eq!(rendered, "a K and ${unknown} and $bare");
    }

    #[test]
    fn the_renderer_survives_an_unterminated_placeholder() {
        assert_eq!(render_prompt("tail ${cut", &[]), "tail ${cut");
    }
}
