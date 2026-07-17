//! Goal state machine — 6-state design based on Codex `ext/goal/`.
//!
//! States:
//! - `Active`: 正在被 goal driver 推进，自动续跑
//! - `Paused`: 暂停，可恢复
//! - `Blocked`: 真实阻塞，可恢复
//! - `Complete`: 完成（瞬态，发出事件后清除）
//! - `BudgetLimited`: token 预算耗尽，仍可收尾
//! - `UsageLimited`: API usage limit 耗尽，仍可收尾

use std::fmt;

/// The six lifecycle states of a thread goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalStatus {
    Active,
    Paused,
    Blocked,
    Complete,
    BudgetLimited,
    UsageLimited,
}

impl GoalStatus {
    /// Returns true if the goal can be autonomously continued.
    pub fn is_active(self) -> bool {
        matches!(self, GoalStatus::Active)
    }

    /// Returns true if the goal can be resumed (by user or system).
    pub fn is_resumable(self) -> bool {
        matches!(self, GoalStatus::Paused | GoalStatus::Blocked)
    }

    /// Returns true if the goal is in a terminal-ish state (not running, not resumable).
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            GoalStatus::Complete | GoalStatus::BudgetLimited | GoalStatus::UsageLimited
        )
    }

    /// Serialize to a JSON-safe string (camelCase for napi compat).
    pub fn as_str(self) -> &'static str {
        match self {
            GoalStatus::Active => "active",
            GoalStatus::Paused => "paused",
            GoalStatus::Blocked => "blocked",
            GoalStatus::Complete => "complete",
            GoalStatus::BudgetLimited => "budgetLimited",
            GoalStatus::UsageLimited => "usageLimited",
        }
    }

    /// Deserialize from the JSON-safe string.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "active" => Some(GoalStatus::Active),
            "paused" => Some(GoalStatus::Paused),
            "blocked" => Some(GoalStatus::Blocked),
            "complete" => Some(GoalStatus::Complete),
            "budgetLimited" | "budget_limited" => Some(GoalStatus::BudgetLimited),
            "usageLimited" | "usage_limited" => Some(GoalStatus::UsageLimited),
            _ => None,
        }
    }
}

impl fmt::Display for GoalStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// ---------------------------------------------------------------------------
// GoalState – the durable, serialisable state of one thread's goal.
// ---------------------------------------------------------------------------

/// Core goal state, persisted via TS wire.jsonl (native is stateless w.r.t storage).
#[derive(Debug, Clone)]
pub struct GoalState {
    /// Opaque identifier (UUID v4), assigned by TS on creation.
    pub goal_id: String,
    /// User-provided objective text.
    pub objective: String,
    /// Current lifecycle status.
    pub status: GoalStatus,
    /// Optional token budget for the goal (total tokens allowed).
    pub token_budget: Option<i64>,
    /// Cumulative tokens consumed toward this goal (input + output, excl. cache).
    pub tokens_used: i64,
    /// Cumulative wall-clock seconds spent actively pursuing this goal.
    pub time_used_seconds: i64,
    /// Consecutive turns that encountered a blocking condition (reset on resume).
    pub blocked_streak: u32,
    /// Timestamp when the current active interval started (epoch ms), if active.
    pub wall_clock_resumed_at: Option<i64>,
    /// Reason for the terminal/blocked/paused state (model-readable).
    pub terminal_reason: Option<String>,
}

impl GoalState {
    /// Create a new active goal.
    pub fn new(goal_id: String, objective: String, token_budget: Option<i64>) -> Self {
        Self {
            goal_id,
            objective,
            status: GoalStatus::Active,
            token_budget,
            tokens_used: 0,
            time_used_seconds: 0,
            blocked_streak: 0,
            wall_clock_resumed_at: None,
            terminal_reason: None,
        }
    }

    /// Returns true if the goal is over its token budget.
    pub fn is_over_token_budget(&self) -> bool {
        self.token_budget
            .is_some_and(|budget| self.tokens_used >= budget)
    }

    /// Returns remaining tokens (0 if no budget).
    pub fn remaining_tokens(&self) -> i64 {
        self.token_budget
            .map(|b| (b - self.tokens_used).max(0))
            .unwrap_or(i64::MAX)
    }
}

// ---------------------------------------------------------------------------
// GoalUpdate – partial update applied via apply_update.
// ---------------------------------------------------------------------------

/// A partial update to a goal. All fields are optional; `None` means "keep".
#[derive(Debug, Clone, Default)]
pub struct GoalUpdate {
    pub objective: Option<String>,
    pub status: Option<GoalStatus>,
    pub token_budget: Option<Option<i64>>,
    pub tokens_used: Option<i64>,
    pub time_used_seconds: Option<i64>,
    pub blocked_streak: Option<u32>,
    pub wall_clock_resumed_at: Option<Option<i64>>,
    pub terminal_reason: Option<Option<String>>,
    /// If set, the caller's expected goal_id must match the current goal_id.
    /// This provides optimistic concurrency control.
    pub expected_goal_id: Option<String>,
}

/// Outcome of applying an update.
#[derive(Debug)]
pub enum GoalUpdateOutcome {
    /// Goal was updated successfully.
    Updated(GoalState),
    /// No change (all fields were None or identical).
    Unchanged,
    /// expected_goal_id did not match.
    GoalIdMismatch { current: String, expected: String },
}

impl GoalState {
    /// Apply a partial update. Returns the new state on success.
    ///
    /// If `expected_goal_id` is set and does not match `self.goal_id`,
    /// returns `GoalIdMismatch`.
    pub fn apply_update(mut self, update: GoalUpdate) -> GoalUpdateOutcome {
        // Check expected_goal_id
        if let Some(expected) = &update.expected_goal_id {
            if expected != &self.goal_id {
                return GoalUpdateOutcome::GoalIdMismatch {
                    current: self.goal_id,
                    expected: expected.clone(),
                };
            }
        }

        let mut changed = false;

        if let Some(objective) = update.objective {
            if objective != self.objective {
                self.objective = objective;
                changed = true;
            }
        }
        if let Some(status) = update.status {
            if status != self.status {
                // On resume: reset blocked_streak and start wall clock
                if status == GoalStatus::Active {
                    self.blocked_streak = 0;
                    self.wall_clock_resumed_at = Some(chrono_now_ms());
                    self.terminal_reason = None;
                }
                // On pause/block/complete: clear wall clock
                if self.status == GoalStatus::Active
                    && status != GoalStatus::Active
                {
                    // Fold elapsed wall-clock into time_used_seconds before clearing
                    if let Some(resumed_at) = self.wall_clock_resumed_at {
                        let elapsed = (chrono_now_ms() - resumed_at).max(0) / 1000;
                        self.time_used_seconds += elapsed;
                    }
                    self.wall_clock_resumed_at = None;
                }
                // On terminal states: keep the reason
                self.status = status;
                changed = true;
            }
        }
        if let Some(token_budget) = update.token_budget {
            if token_budget != self.token_budget {
                self.token_budget = token_budget;
                changed = true;
            }
        }
        if let Some(tokens_used) = update.tokens_used {
            if tokens_used != self.tokens_used {
                self.tokens_used = tokens_used;
                changed = true;
            }
        }
        if let Some(time) = update.time_used_seconds {
            if time != self.time_used_seconds {
                self.time_used_seconds = time;
                changed = true;
            }
        }
        if let Some(streak) = update.blocked_streak {
            if streak != self.blocked_streak {
                self.blocked_streak = streak;
                changed = true;
            }
        }
        if let Some(wall_clock) = update.wall_clock_resumed_at {
            if wall_clock != self.wall_clock_resumed_at {
                self.wall_clock_resumed_at = wall_clock;
                changed = true;
            }
        }
        if let Some(reason) = update.terminal_reason {
            if reason != self.terminal_reason {
                self.terminal_reason = reason;
                changed = true;
            }
        }

        if changed {
            GoalUpdateOutcome::Updated(self)
        } else {
            GoalUpdateOutcome::Unchanged
        }
    }
}

/// Returns the current time in epoch milliseconds.
fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Validate a goal objective. Returns an error message if invalid.
pub fn validate_goal_objective(objective: &str) -> Result<(), String> {
    let trimmed = objective.trim();
    if trimmed.is_empty() {
        return Err("Goal objective cannot be empty".to_string());
    }
    // Cap objective length to prevent absurdly long goals
    if trimmed.len() > 10_000 {
        return Err("Goal objective too long (max 10,000 characters)".to_string());
    }
    Ok(())
}

/// Validate a goal token budget. Returns an error message if invalid.
pub fn validate_goal_budget(value: Option<i64>) -> Result<(), String> {
    if let Some(v) = value {
        if v <= 0 {
            return Err("Goal token budget must be positive".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_goal() {
        let g = GoalState::new("g1".into(), "fix bugs".into(), Some(1000));
        assert_eq!(g.status, GoalStatus::Active);
        assert_eq!(g.tokens_used, 0);
        assert_eq!(g.remaining_tokens(), 1000);
    }

    #[test]
    fn test_update_status() {
        let g = GoalState::new("g1".into(), "fix bugs".into(), None);
        let u = GoalUpdate {
            status: Some(GoalStatus::Complete),
            expected_goal_id: Some("g1".into()),
            ..Default::default()
        };
        match g.apply_update(u) {
            GoalUpdateOutcome::Updated(state) => {
                assert_eq!(state.status, GoalStatus::Complete);
            }
            _ => panic!("expected Updated"),
        }
    }

    #[test]
    fn test_goal_id_mismatch() {
        let g = GoalState::new("g1".into(), "fix bugs".into(), None);
        let u = GoalUpdate {
            status: Some(GoalStatus::Complete),
            expected_goal_id: Some("g2".into()),
            ..Default::default()
        };
        match g.apply_update(u) {
            GoalUpdateOutcome::GoalIdMismatch { current, expected } => {
                assert_eq!(current, "g1");
                assert_eq!(expected, "g2");
            }
            _ => panic!("expected GoalIdMismatch"),
        }
    }

    #[test]
    fn test_is_over_budget() {
        let mut g = GoalState::new("g1".into(), "test".into(), Some(100));
        g.tokens_used = 150;
        assert!(g.is_over_token_budget());
        assert_eq!(g.remaining_tokens(), 0);
    }

    #[test]
    fn test_no_budget() {
        let g = GoalState::new("g1".into(), "test".into(), None);
        assert!(!g.is_over_token_budget());
        assert_eq!(g.remaining_tokens(), i64::MAX);
    }

    #[test]
    fn test_blocked_streak_reset_on_resume() {
        let g = GoalState {
            status: GoalStatus::Blocked,
            blocked_streak: 3,
            ..GoalState::new("g1".into(), "test".into(), None)
        };
        let u = GoalUpdate {
            status: Some(GoalStatus::Active),
            expected_goal_id: Some("g1".into()),
            ..Default::default()
        };
        match g.apply_update(u) {
            GoalUpdateOutcome::Updated(state) => {
                assert_eq!(state.status, GoalStatus::Active);
                assert_eq!(state.blocked_streak, 0);
            }
            other => panic!("expected Updated, got {other:?}"),
        }
    }

    #[test]
    fn test_validate_objective() {
        assert!(validate_goal_objective("").is_err());
        assert!(validate_goal_objective("  ").is_err());
        assert!(validate_goal_objective("fix bugs").is_ok());
        let long = "a".repeat(10_001);
        assert!(validate_goal_objective(&long).is_err());
    }

    #[test]
    fn test_validate_budget() {
        assert!(validate_goal_budget(Some(-1)).is_err());
        assert!(validate_goal_budget(Some(0)).is_err());
        assert!(validate_goal_budget(Some(100)).is_ok());
        assert!(validate_goal_budget(None).is_ok());
    }
}
