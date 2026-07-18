//! GoalEngine — stateless decision core.
//!
//! All methods are pure functions (JSON-in / JSON-out). Rust is the "brain":
//! it owns state machine transitions, budget math, continuation decisions,
//! blocked audit, and prompt selection. TypeScript is the "muscle" that
//! persists results and emits events.

use crate::goal::state::{
    validate_goal_objective, BlockedAuditDecision, BudgetLimitsPatch, BudgetUnit,
    GoalBudgetReport, GoalState, GoalStatus, GoalUpdate, GoalUpdateOutcome,
};

// ---------------------------------------------------------------------------
// validate_create_input
// ---------------------------------------------------------------------------

/// Validates and normalizes a goal creation input.
pub fn validate_create_input(objective: &str, completion_criterion: Option<&str>) -> Result<(String, Option<String>), String> {
    validate_goal_objective(objective)?;
    let trimmed = objective.trim().to_string();
    let criterion = completion_criterion.map(|c| {
        let t = c.trim();
        if t.len() > 10_000 {
            t[..10_000].to_string()
        } else {
            t.to_string()
        }
    });
    let criterion = criterion.filter(|c| !c.is_empty());
    Ok((trimmed, criterion))
}

// ---------------------------------------------------------------------------
// validate_budget_input
// ---------------------------------------------------------------------------

/// Validates a budget input into a patch. Returns the patch for TS to apply.
pub fn validate_budget_input_json(value: f64, unit: &str) -> Result<BudgetLimitsPatch, String> {
    let unit = BudgetUnit::from_str(unit)
        .ok_or_else(|| format!("invalid budget unit: {unit}"))?;
    crate::goal::state::validate_budget_input(value, unit)
}

// ---------------------------------------------------------------------------
// compute_budget_report
// ---------------------------------------------------------------------------

/// Computes the full budget report from a goal + current time.
pub fn compute_budget_report(goal: &GoalState, now_ms: i64) -> GoalBudgetReport {
    goal.compute_budget_report(now_ms)
}

// ---------------------------------------------------------------------------
// apply_usage
// ---------------------------------------------------------------------------

/// Applies token + turn deltas to a goal. Returns the new goal + overBudget flag.
pub fn apply_usage(goal: &mut GoalState, token_delta: i64, turn_delta: i64, now_ms: i64) -> bool {
    goal.tokens_used += token_delta.max(0);
    goal.turns_used += turn_delta.max(0);
    goal.is_over_budget(now_ms)
}

// ---------------------------------------------------------------------------
// decide_continuation
// ---------------------------------------------------------------------------

/// Output of the continuation decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContinuationAction {
    Continue {
        steering_prompt: String,
    },
    StopBudget {
        reason: String,
        steering_prompt: String,
    },
    StopInactive,
}

/// Decides whether the goal driver should run another continuation turn.
pub fn decide_continuation(goal: &GoalState, now_ms: i64) -> ContinuationAction {
    if goal.status != GoalStatus::Active {
        return ContinuationAction::StopInactive;
    }
    let report = goal.compute_budget_report(now_ms);
    if report.over_budget {
        let prompt = crate::goal::steering::render_budget_limit(
            &goal.objective,
            goal.tokens_used,
            goal.token_budget,
            goal.live_wall_clock_ms(now_ms) / 1000,
        );
        let reason = if report.token_budget_reached {
            "Token budget reached"
        } else if report.turn_budget_reached {
            "Turn budget reached"
        } else {
            "Time budget reached"
        };
        return ContinuationAction::StopBudget {
            reason: reason.to_string(),
            steering_prompt: prompt,
        };
    }
    let prompt = crate::goal::steering::render_continuation(
        &goal.objective,
        goal.tokens_used,
        goal.token_budget,
    );
    ContinuationAction::Continue {
        steering_prompt: prompt,
    }
}

// ---------------------------------------------------------------------------
// decide_blocked_audit
// ---------------------------------------------------------------------------

/// Applies the 3-turn blocked audit. Returns the decision.
pub fn decide_blocked_audit(goal: &GoalState) -> BlockedAuditDecision {
    goal.decide_blocked_audit()
}

// ---------------------------------------------------------------------------
// decide_status_transition
// ---------------------------------------------------------------------------

/// Attempts a status transition. Returns the new goal or an error.
pub fn decide_status_transition(
    goal: GoalState,
    target_status: GoalStatus,
    expected_goal_id: Option<&str>,
) -> Result<GoalState, String> {
    let update = GoalUpdate {
        status: Some(target_status),
        expected_goal_id: expected_goal_id.map(|s| s.to_string()),
        ..Default::default()
    };
    match goal.apply_update(update) {
        GoalUpdateOutcome::Updated(g) => Ok(g),
        GoalUpdateOutcome::InvalidTransition { current, target } => {
            Err(format!(
                "invalid transition from {:?} to {:?}",
                current, target
            ))
        }
        GoalUpdateOutcome::GoalIdMismatch { current, expected } => {
            Err(format!(
                "goal ID mismatch: current={current}, expected={expected}"
            ))
        }
        GoalUpdateOutcome::Unchanged => Err(format!(
            "no change: goal is already in status {:?}",
            target_status
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_create_input() {
        let (obj, crit) = validate_create_input("fix bugs", Some("tests pass")).unwrap();
        assert_eq!(obj, "fix bugs");
        assert_eq!(crit, Some("tests pass".to_string()));
    }

    #[test]
    fn test_validate_create_input_empty() {
        assert!(validate_create_input("", None).is_err());
        assert!(validate_create_input("   ", None).is_err());
    }

    #[test]
    fn test_validate_create_input_criterion_truncation() {
        let long = "a".repeat(10_001);
        let (_, crit) = validate_create_input("test", Some(&long)).unwrap();
        assert_eq!(crit.unwrap().len(), 10_000);
    }

    #[test]
    fn test_decide_continuation_inactive() {
        let mut g = GoalState::new("g1".into(), "test".into(), None);
        g.status = GoalStatus::Paused;
        let d = decide_continuation(&g, 0);
        assert_eq!(d, ContinuationAction::StopInactive);
    }

    #[test]
    fn test_decide_continuation_over_budget() {
        let mut g = GoalState::new("g1".into(), "test".into(), Some(100));
        g.tokens_used = 150;
        let d = decide_continuation(&g, 0);
        match d {
            ContinuationAction::StopBudget { reason, .. } => {
                assert!(reason.contains("Token"));
            }
            _ => panic!("expected StopBudget"),
        }
    }

    #[test]
    fn test_decide_continuation_continue() {
        let g = GoalState::new("g1".into(), "test".into(), Some(1000));
        let d = decide_continuation(&g, 0);
        match d {
            ContinuationAction::Continue { steering_prompt } => {
                assert!(steering_prompt.contains("test"));
            }
            _ => panic!("expected Continue"),
        }
    }

    #[test]
    fn test_apply_usage() {
        let mut g = GoalState::new("g1".into(), "test".into(), Some(100));
        let over = apply_usage(&mut g, 50, 1, 0);
        assert!(!over);
        assert_eq!(g.tokens_used, 50);
        assert_eq!(g.turns_used, 1);
        let over = apply_usage(&mut g, 60, 0, 0);
        assert!(over);
        assert_eq!(g.tokens_used, 110);
    }

    #[test]
    fn test_decide_status_transition() {
        let g = GoalState::new("g1".into(), "test".into(), None);
        let result = decide_status_transition(g, GoalStatus::Complete, Some("g1"));
        assert!(result.is_ok());
        assert_eq!(result.unwrap().status, GoalStatus::Complete);
    }

    #[test]
    fn test_decide_status_transition_invalid() {
        let g = GoalState::new("g1".into(), "test".into(), None);
        let result = decide_status_transition(g, GoalStatus::Paused, Some("g2"));
        assert!(result.is_err());
    }
}
