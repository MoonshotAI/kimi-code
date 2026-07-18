//! Goal state machine — 6-state design based on Codex `ext/goal/`.
//!
//! States:
//! - `Active`: 正在被 goal driver 推进，自动续跑
//! - `Paused`: 暂停，可恢复
//! - `Blocked`: 真实阻塞，可恢复
//! - `Complete`: 完成（瞬态，发出事件后清除）
//! - `BudgetLimited`: token 预算耗尽，仍可收尾
//! - `UsageLimited`: API usage limit 耗尽，仍可收尾
//!
//! JSON schema (camelCase): matches TS `GoalState` one-to-one.
//! All engine methods consume/produce this schema.
//!
//! | Field | Type | TS name |
//! |---|---|---|
//! | `goal_id` | String | `goalId` |
//! | `objective` | String | `objective` |
//! | `completion_criterion` | Option<String> | `completionCriterion` |
//! | `status` | GoalStatus | `status` |
//! | `token_budget` | Option<i64> | `tokenBudget` |
//! | `turn_budget` | Option<i64> | `turnBudget` |
//! | `wall_clock_budget_ms` | Option<i64> | `wallClockBudgetMs` |
//! | `tokens_used` | i64 | `tokensUsed` |
//! | `turns_used` | i64 | `turnsUsed` |
//! | `wall_clock_ms` | i64 | `wallClockMs` |
//! | `blocked_streak` | u32 | `blockedStreak` |
//! | `wall_clock_resumed_at` | Option<i64> | `wallClockResumedAt` |
//! | `terminal_reason` | Option<String> | `terminalReason` |
//! | `created_at` | i64 | `createdAt` |
//! | `updated_at` | i64 | `updatedAt` |

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
    /// Optional completion criterion (user-provided proof of done).
    pub completion_criterion: Option<String>,
    /// Current lifecycle status.
    pub status: GoalStatus,
    /// Optional token budget for the goal (total tokens allowed).
    pub token_budget: Option<i64>,
    /// Optional turn budget (max continuation turns).
    pub turn_budget: Option<i64>,
    /// Optional wall-clock budget in milliseconds.
    pub wall_clock_budget_ms: Option<i64>,
    /// Cumulative tokens consumed toward this goal (input + output, excl. cache).
    pub tokens_used: i64,
    /// Cumulative continuation turns run toward this goal.
    pub turns_used: i64,
    /// Cumulative wall-clock milliseconds spent actively pursuing this goal.
    pub wall_clock_ms: i64,
    /// Consecutive turns that encountered a blocking condition (reset on resume).
    pub blocked_streak: u32,
    /// Timestamp when the current active interval started (epoch ms), if active.
    pub wall_clock_resumed_at: Option<i64>,
    /// Reason for the terminal/blocked/paused state (model-readable).
    pub terminal_reason: Option<String>,
    /// Epoch milliseconds when the goal was created.
    pub created_at: i64,
    /// Epoch milliseconds when the goal was last updated.
    pub updated_at: i64,
}

impl GoalState {
    /// Create a new active goal.
    pub fn new(goal_id: String, objective: String, token_budget: Option<i64>) -> Self {
        let now = chrono_now_ms();
        Self {
            goal_id,
            objective,
            completion_criterion: None,
            status: GoalStatus::Active,
            token_budget,
            turn_budget: None,
            wall_clock_budget_ms: None,
            tokens_used: 0,
            turns_used: 0,
            wall_clock_ms: 0,
            blocked_streak: 0,
            wall_clock_resumed_at: None,
            terminal_reason: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Live wall-clock: accumulated total + in-flight active interval.
    pub fn live_wall_clock_ms(&self, now_ms: i64) -> i64 {
        let base = self.wall_clock_ms;
        if self.status == GoalStatus::Active {
            if let Some(resumed_at) = self.wall_clock_resumed_at {
                return base + (now_ms - resumed_at).max(0);
            }
        }
        base
    }

    /// Returns true if any configured budget dimension is reached.
    pub fn is_over_budget(&self, now_ms: i64) -> bool {
        let token_reached = self
            .token_budget
            .is_some_and(|b| self.tokens_used >= b);
        let turn_reached = self.turn_budget.is_some_and(|b| self.turns_used >= b);
        let wall_clock_reached = self
            .wall_clock_budget_ms
            .is_some_and(|b| self.live_wall_clock_ms(now_ms) >= b);
        token_reached || turn_reached || wall_clock_reached
    }

    /// Returns remaining tokens (MAX if no budget).
    pub fn remaining_tokens(&self) -> i64 {
        self.token_budget
            .map(|b| (b - self.tokens_used).max(0))
            .unwrap_or(i64::MAX)
    }
}

// ---------------------------------------------------------------------------
// GoalBudgetReport — computed budget view (9 fields, matches TS)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalBudgetReport {
    pub token_budget: Option<i64>,
    pub turn_budget: Option<i64>,
    pub wall_clock_budget_ms: Option<i64>,
    pub remaining_tokens: Option<i64>,
    pub remaining_turns: Option<i64>,
    pub remaining_wall_clock_ms: Option<i64>,
    pub token_budget_reached: bool,
    pub turn_budget_reached: bool,
    pub wall_clock_budget_reached: bool,
    pub over_budget: bool,
}

impl GoalState {
    /// Compute the full budget report.
    pub fn compute_budget_report(&self, now_ms: i64) -> GoalBudgetReport {
        let live_wc = self.live_wall_clock_ms(now_ms);
        let token_remaining = self.token_budget.map(|b| (b - self.tokens_used).max(0));
        let turn_remaining = self.turn_budget.map(|b| (b - self.turns_used).max(0));
        let wc_remaining = self.wall_clock_budget_ms.map(|b| (b - live_wc).max(0));
        let token_reached = self.token_budget.is_some_and(|b| self.tokens_used >= b);
        let turn_reached = self.turn_budget.is_some_and(|b| self.turns_used >= b);
        let wc_reached = self.wall_clock_budget_ms.is_some_and(|b| live_wc >= b);
        GoalBudgetReport {
            token_budget: self.token_budget,
            turn_budget: self.turn_budget,
            wall_clock_budget_ms: self.wall_clock_budget_ms,
            remaining_tokens: token_remaining,
            remaining_turns: turn_remaining,
            remaining_wall_clock_ms: wc_remaining,
            token_budget_reached: token_reached,
            turn_budget_reached: turn_reached,
            wall_clock_budget_reached: wc_reached,
            over_budget: token_reached || turn_reached || wc_reached,
        }
    }
}

// ---------------------------------------------------------------------------
// BlockedAuditDecision — result of the 3-turn blocked audit
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockedAuditDecision {
    RecordAttempt {
        streak: u32,
        attempts_needed: u32,
        message: String,
    },
    MarkBlocked {
        streak: u32,
    },
}

impl GoalState {
    /// Apply the 3-turn blocked audit.
    pub fn decide_blocked_audit(&self) -> BlockedAuditDecision {
        const MAX_STREAK: u32 = 2; // 0-indexed: 0, 1, 2 = 3 turns
        if self.blocked_streak < MAX_STREAK {
            let attempts_needed = MAX_STREAK - self.blocked_streak;
            BlockedAuditDecision::RecordAttempt {
                streak: self.blocked_streak,
                attempts_needed,
                message: format!(
                    "Blocking condition noted (attempt {}/3). The goal remains active. \
                     Only mark blocked after the same condition persists for 3 consecutive goal turns.",
                    self.blocked_streak + 1
                ),
            }
        } else {
            BlockedAuditDecision::MarkBlocked {
                streak: self.blocked_streak + 1,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/// Validate a goal objective. Returns an error message if invalid.
pub fn validate_goal_objective(objective: &str) -> Result<(), String> {
    let trimmed = objective.trim();
    if trimmed.is_empty() {
        return Err("Goal objective cannot be empty".to_string());
    }
    if trimmed.len() > 10_000 {
        return Err("Goal objective too long (max 10,000 characters)".to_string());
    }
    Ok(())
}

/// Validate a goal budget value. Returns an error message if invalid.
pub fn validate_goal_budget(value: Option<i64>) -> Result<(), String> {
    if let Some(v) = value {
        if v <= 0 {
            return Err("Goal budget must be positive".to_string());
        }
    }
    Ok(())
}

/// Budget unit for `validate_budget_input`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetUnit {
    Turns,
    Tokens,
    Milliseconds,
    Seconds,
    Minutes,
    Hours,
}

impl BudgetUnit {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "turns" => Some(Self::Turns),
            "tokens" => Some(Self::Tokens),
            "milliseconds" => Some(Self::Milliseconds),
            "seconds" => Some(Self::Seconds),
            "minutes" => Some(Self::Minutes),
            "hours" => Some(Self::Hours),
            _ => None,
        }
    }
}

/// Output of `validate_budget_input`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BudgetLimitsPatch {
    pub token_budget: Option<Option<i64>>,
    pub turn_budget: Option<Option<i64>>,
    pub wall_clock_budget_ms: Option<Option<i64>>,
}

const MIN_REASONABLE_TIME_MS: i64 = 1_000;
const MAX_REASONABLE_TIME_MS: i64 = 86_400_000; // 24h

/// Validate and normalize a budget input into a patch.
pub fn validate_budget_input(value: f64, unit: BudgetUnit) -> Result<BudgetLimitsPatch, String> {
    match unit {
        BudgetUnit::Turns => {
            let rounded = (value.round() as i64).max(1);
            Ok(BudgetLimitsPatch {
                turn_budget: Some(Some(rounded)),
                ..Default::default()
            })
        }
        BudgetUnit::Tokens => {
            let rounded = (value.round() as i64).max(1);
            Ok(BudgetLimitsPatch {
                token_budget: Some(Some(rounded)),
                ..Default::default()
            })
        }
        unit => {
            let ms = match unit {
                BudgetUnit::Milliseconds => value as i64,
                BudgetUnit::Seconds => (value * 1000.0) as i64,
                BudgetUnit::Minutes => (value * 60.0 * 1000.0) as i64,
                BudgetUnit::Hours => (value * 60.0 * 60.0 * 1000.0) as i64,
                _ => unreachable!(),
            };
            if ms < MIN_REASONABLE_TIME_MS {
                return Err(format!(
                    "Time budget too short (min {} second)",
                    MIN_REASONABLE_TIME_MS / 1000
                ));
            }
            if ms > MAX_REASONABLE_TIME_MS {
                return Err(format!(
                    "Time budget too long (max {} hours)",
                    MAX_REASONABLE_TIME_MS / 3_600_000
                ));
            }
            Ok(BudgetLimitsPatch {
                wall_clock_budget_ms: Some(Some(ms)),
                ..Default::default()
            })
        }
    }
}

// ---------------------------------------------------------------------------
// GoalUpdate – partial update applied via apply_update.
// ---------------------------------------------------------------------------

/// A partial update to a goal. All fields are optional; `None` means "keep".
#[derive(Debug, Clone, Default)]
pub struct GoalUpdate {
    pub objective: Option<String>,
    pub completion_criterion: Option<Option<String>>,
    pub status: Option<GoalStatus>,
    pub token_budget: Option<Option<i64>>,
    pub turn_budget: Option<Option<i64>>,
    pub wall_clock_budget_ms: Option<Option<i64>>,
    pub tokens_used: Option<i64>,
    pub turns_used: Option<i64>,
    pub wall_clock_ms: Option<i64>,
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
    /// The requested status transition is not allowed.
    InvalidTransition { current: GoalStatus, target: GoalStatus },
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
        if let Some(criterion) = update.completion_criterion {
            if criterion != self.completion_criterion {
                self.completion_criterion = criterion;
                changed = true;
            }
        }
        if let Some(status) = update.status {
            if status != self.status {
                // Validate transition
                if !is_valid_transition(self.status, status) {
                    return GoalUpdateOutcome::InvalidTransition {
                        current: self.status,
                        target: status,
                    };
                }
                // On resume: reset blocked_streak and start wall clock
                if status == GoalStatus::Active {
                    self.blocked_streak = 0;
                    self.wall_clock_resumed_at = Some(chrono_now_ms());
                    self.terminal_reason = None;
                }
                // On leaving active: fold elapsed wall-clock into wall_clock_ms
                if self.status == GoalStatus::Active
                    && status != GoalStatus::Active
                {
                    if let Some(resumed_at) = self.wall_clock_resumed_at {
                        let elapsed = (chrono_now_ms() - resumed_at).max(0);
                        self.wall_clock_ms += elapsed;
                    }
                    self.wall_clock_resumed_at = None;
                }
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
        if let Some(turn_budget) = update.turn_budget {
            if turn_budget != self.turn_budget {
                self.turn_budget = turn_budget;
                changed = true;
            }
        }
        if let Some(wc_budget) = update.wall_clock_budget_ms {
            if wc_budget != self.wall_clock_budget_ms {
                self.wall_clock_budget_ms = wc_budget;
                changed = true;
            }
        }
        if let Some(tokens_used) = update.tokens_used {
            if tokens_used != self.tokens_used {
                self.tokens_used = tokens_used;
                changed = true;
            }
        }
        if let Some(turns_used) = update.turns_used {
            if turns_used != self.turns_used {
                self.turns_used = turns_used;
                changed = true;
            }
        }
        if let Some(wall_clock_ms) = update.wall_clock_ms {
            if wall_clock_ms != self.wall_clock_ms {
                self.wall_clock_ms = wall_clock_ms;
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
            self.updated_at = chrono_now_ms();
            GoalUpdateOutcome::Updated(self)
        } else {
            GoalUpdateOutcome::Unchanged
        }
    }
}

/// Returns true if the transition from `current` to `target` is valid.
pub fn is_valid_transition(current: GoalStatus, target: GoalStatus) -> bool {
    use GoalStatus::*;
    matches!(
        (current, target),
        // No-op (identical status)
        (Active, Active)
            | (Paused, Paused)
            | (Blocked, Blocked)
            | (Complete, Complete)
            | (BudgetLimited, BudgetLimited)
            | (UsageLimited, UsageLimited)
            // Resume: paused or blocked -> active
            | (Paused, Active)
            | (Blocked, Active)
            // Pause: active, budget_limited, usage_limited -> paused
            | (Active, Paused)
            | (BudgetLimited, Paused)
            | (UsageLimited, Paused)
            // Block: active -> blocked
            | (Active, Blocked)
            // Complete: active -> complete
            | (Active, Complete)
            // Budget limit: active, usage_limited -> budget_limited
            | (Active, BudgetLimited)
            | (UsageLimited, BudgetLimited)
            // Usage limit: active, budget_limited -> usage_limited
            | (Active, UsageLimited)
            | (BudgetLimited, UsageLimited)
    )
}

/// Returns the current time in epoch milliseconds.
fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
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
        assert_eq!(g.turns_used, 0);
        assert_eq!(g.wall_clock_ms, 0);
        assert!(g.completion_criterion.is_none());
        assert!(g.turn_budget.is_none());
        assert!(g.wall_clock_budget_ms.is_none());
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
        assert!(g.is_over_budget(0));
        assert_eq!(g.remaining_tokens(), 0);
    }

    #[test]
    fn test_no_budget() {
        let g = GoalState::new("g1".into(), "test".into(), None);
        assert!(!g.is_over_budget(0));
        assert_eq!(g.remaining_tokens(), i64::MAX);
    }

    #[test]
    fn test_multi_budget() {
        let mut g = GoalState::new("g1".into(), "test".into(), Some(1000));
        g.turn_budget = Some(5);
        g.wall_clock_budget_ms = Some(60_000);
        g.turns_used = 5;
        assert!(g.is_over_budget(0));
        let report = g.compute_budget_report(0);
        assert!(report.turn_budget_reached);
        assert!(!report.token_budget_reached);
        assert!(report.over_budget);
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

    #[test]
    fn test_validate_budget_input_turns() {
        let patch = validate_budget_input(5.0, BudgetUnit::Turns).unwrap();
        assert_eq!(patch.turn_budget, Some(Some(5)));
        assert_eq!(patch.token_budget, None);
    }

    #[test]
    fn test_validate_budget_input_time_bounds() {
        assert!(validate_budget_input(0.5, BudgetUnit::Seconds).is_err()); // < 1s
        assert!(validate_budget_input(25.0, BudgetUnit::Hours).is_err()); // > 24h
        let patch = validate_budget_input(30.0, BudgetUnit::Minutes).unwrap();
        assert_eq!(patch.wall_clock_budget_ms, Some(Some(1_800_000)));
    }

    #[test]
    fn test_decide_blocked_audit() {
        let mut g = GoalState::new("g1".into(), "test".into(), None);
        // Streak 0 -> record_attempt
        let d = g.decide_blocked_audit();
        assert!(matches!(d, BlockedAuditDecision::RecordAttempt { streak: 0, attempts_needed: 2, .. }));
        // Streak 1 -> record_attempt
        g.blocked_streak = 1;
        let d = g.decide_blocked_audit();
        assert!(matches!(d, BlockedAuditDecision::RecordAttempt { streak: 1, attempts_needed: 1, .. }));
        // Streak 2 -> mark_blocked
        g.blocked_streak = 2;
        let d = g.decide_blocked_audit();
        assert!(matches!(d, BlockedAuditDecision::MarkBlocked { streak: 3 }));
    }

    #[test]
    fn test_live_wall_clock() {
        let mut g = GoalState::new("g1".into(), "test".into(), None);
        g.wall_clock_ms = 5000;
        g.wall_clock_resumed_at = Some(1000);
        g.status = GoalStatus::Active;
        // now_ms = 3000 -> live = 5000 + (3000 - 1000) = 7000
        assert_eq!(g.live_wall_clock_ms(3000), 7000);
        // inactive goal -> no in-flight
        g.status = GoalStatus::Paused;
        assert_eq!(g.live_wall_clock_ms(3000), 5000);
    }
}
