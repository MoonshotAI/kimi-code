//! Goal accounting — token and wall-clock time tracking.
//!
//! Based on Codex `ext/goal/src/accounting.rs`.
//!
//! Tracks per-turn token baselines and wall-clock intervals so that each
//! accounting call only charges the delta since the previous accounting point.
//! This is critical for correctly billing tool-call interleaving: multiple
//! tool calls in the same turn each contribute their delta.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

// ---------------------------------------------------------------------------
// Token usage snapshot (matches TS TokenUsage shape)
// ---------------------------------------------------------------------------

/// Token usage counters, mirroring the TS `TokenUsage` type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
}

impl TokenUsage {
    pub fn zero() -> Self {
        Self {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 0,
        }
    }
}

/// The delta in goal-chargeable tokens between two usage snapshots.
/// Input tokens are charged at full rate minus cached portion; output tokens
/// are charged at full rate. This matches Codex's `goal_token_delta_for_usage`.
pub fn goal_token_delta(prev: &TokenUsage, current: &TokenUsage) -> i64 {
    let input_delta = current
        .input_tokens
        .saturating_sub(prev.input_tokens)
        .saturating_sub(
            current
                .cached_input_tokens
                .saturating_sub(prev.cached_input_tokens),
        );
    let output_delta = current.output_tokens.saturating_sub(prev.output_tokens);
    input_delta.max(0).saturating_add(output_delta.max(0))
}

// ---------------------------------------------------------------------------
// Per-turn accounting
// ---------------------------------------------------------------------------

/// Accounting state for a single turn.
struct TurnAccounting {
    /// Token usage at the start of the turn (or last accounting point).
    last_accounted_usage: TokenUsage,
    /// Current token usage (updated as new usage arrives).
    current_usage: TokenUsage,
    /// Goal ID this turn is currently associated with, if any.
    active_goal_id: Option<String>,
}

impl TurnAccounting {
    fn new(usage_at_start: TokenUsage) -> Self {
        Self {
            last_accounted_usage: usage_at_start.clone(),
            current_usage: usage_at_start,
            active_goal_id: None,
        }
    }

    /// Returns the chargeable token delta since the last accounting point.
    fn token_delta(&self) -> i64 {
        goal_token_delta(&self.last_accounted_usage, &self.current_usage)
    }

    /// Reset the baseline to the current usage (after accounting).
    fn reset_baseline(&mut self) {
        self.last_accounted_usage = self.current_usage.clone();
    }
}

// ---------------------------------------------------------------------------
// Wall-clock accounting
// ---------------------------------------------------------------------------

struct WallClockAccounting {
    /// The instant of the last accounting point.
    last_accounted_at: Instant,
    /// Goal ID currently being actively pursued, if any.
    active_goal_id: Option<String>,
}

impl WallClockAccounting {
    fn new() -> Self {
        Self {
            last_accounted_at: Instant::now(),
            active_goal_id: None,
        }
    }

    /// Seconds elapsed since the last accounting point.
    fn elapsed_secs(&self) -> i64 {
        self.last_accounted_at.elapsed().as_secs() as i64
    }

    /// Advance the baseline by the given number of seconds.
    fn advance(&mut self, secs: i64) {
        if secs > 0 {
            self.last_accounted_at = self
                .last_accounted_at
                .checked_add(std::time::Duration::from_secs(secs as u64))
                .unwrap_or_else(Instant::now);
        }
    }

    fn reset_baseline(&mut self) {
        self.last_accounted_at = Instant::now();
    }
}

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

/// A snapshot of chargeable progress for a turn.
#[derive(Debug, Clone)]
pub struct GoalProgressSnapshot {
    pub expected_goal_id: String,
    pub time_delta_seconds: i64,
    pub token_delta: i64,
}

#[derive(Debug, Clone)]
pub struct RecordedTokenDelta {
    pub turn_delta: i64,
}

// ---------------------------------------------------------------------------
// GoalAccountingState — the main accounting coordinator
// ---------------------------------------------------------------------------

/// Per-thread accounting state. Manages per-turn token baselines and a
/// wall-clock baseline, both reset after each accounting cycle.
///
/// In the TS runtime (single-threaded) this doesn't need the Semaphore from
/// Codex, but the accounting permit pattern is preserved via the Mutex to
/// keep the mental model correct.
pub struct GoalAccountingState {
    inner: Mutex<AccountingInner>,
}

struct AccountingInner {
    current_turn_id: Option<String>,
    turns: HashMap<String, TurnAccounting>,
    wall_clock: WallClockAccounting,
}

impl Default for AccountingInner {
    fn default() -> Self {
        Self {
            current_turn_id: None,
            turns: HashMap::new(),
            wall_clock: WallClockAccounting::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// apply_and_report — free function for the engine
// ---------------------------------------------------------------------------

/// Applies token + turn deltas and returns whether the goal is over budget.
/// This is the engine-side helper for `engine::apply_usage`.
pub fn apply_and_report(
    goal: &mut crate::goal::state::GoalState,
    token_delta: i64,
    turn_delta: i64,
    now_ms: i64,
) -> bool {
    goal.tokens_used += token_delta.max(0);
    goal.turns_used += turn_delta.max(0);
    goal.is_over_budget(now_ms)
}

impl GoalAccountingState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AccountingInner::default()),
        }
    }

    /// Begin a new turn. Call at turn start with the current token usage.
    pub fn start_turn(&self, turn_id: &str, token_usage_at_start: &TokenUsage) {
        let mut inner = self.inner.lock().unwrap();
        inner.current_turn_id = Some(turn_id.to_string());
        inner.turns.insert(
            turn_id.to_string(),
            TurnAccounting::new(token_usage_at_start.clone()),
        );
    }

    /// Returns the current turn ID, if any.
    pub fn current_turn_id(&self) -> Option<String> {
        self.inner.lock().unwrap().current_turn_id.clone()
    }

    /// Record updated token usage for a turn. Returns the delta if the turn
    /// has an active goal, or None if no goal is active on this turn.
    pub fn record_token_usage(
        &self,
        turn_id: &str,
        total_usage: &TokenUsage,
    ) -> Option<RecordedTokenDelta> {
        let mut inner = self.inner.lock().unwrap();
        let turn = inner.turns.get_mut(turn_id)?;
        turn.current_usage = total_usage.clone();
        // Only account if this turn has an active goal
        if turn.active_goal_id.is_none() {
            return None;
        }
        let delta = turn.token_delta();
        if delta <= 0 {
            return None;
        }
        Some(RecordedTokenDelta { turn_delta: delta })
    }

    /// Mark a turn as working towards a specific goal.
    pub fn mark_turn_goal_active(&self, turn_id: &str, goal_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(turn) = inner.turns.get_mut(turn_id) {
            turn.active_goal_id = Some(goal_id.to_string());
            // Reset baseline so we don't double-count tokens from before the goal
            turn.reset_baseline();
            inner.wall_clock.active_goal_id = Some(goal_id.to_string());
            inner.wall_clock.reset_baseline();
        }
    }

    /// Mark the current turn's goal as active (for create-in-turn flow).
    pub fn mark_current_turn_goal_active(&self, goal_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        let turn_id = inner.current_turn_id.clone();
        if let Some(tid) = turn_id {
            if let Some(turn) = inner.turns.get_mut(&tid) {
                turn.active_goal_id = Some(goal_id.to_string());
                turn.reset_baseline();
                inner.wall_clock.active_goal_id = Some(goal_id.to_string());
                inner.wall_clock.reset_baseline();
            }
        }
    }

    /// Mark a goal as active when no turn is running (idle goal after resume).
    pub fn mark_idle_goal_active(&self, goal_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.wall_clock.active_goal_id = Some(goal_id.to_string());
        inner.wall_clock.reset_baseline();
    }

    /// Snapshot chargeable progress for a turn (token delta + time delta).
    /// Returns None if there is nothing to charge.
    pub fn progress_snapshot(&self, turn_id: &str) -> Option<GoalProgressSnapshot> {
        let inner = self.inner.lock().unwrap();
        let turn = inner.turns.get(turn_id)?;
        let expected_goal_id = turn.active_goal_id.clone()?;
        let token_delta = turn.token_delta();
        let time_delta = if inner
            .wall_clock
            .active_goal_id
            .as_deref()
            .is_some_and(|id| id == expected_goal_id)
        {
            inner.wall_clock.elapsed_secs()
        } else {
            0
        };
        if time_delta == 0 && token_delta <= 0 {
            return None;
        }
        Some(GoalProgressSnapshot {
            expected_goal_id,
            time_delta_seconds: time_delta,
            token_delta,
        })
    }

    /// Snapshot chargeable progress when idle (wall-clock only, no tokens).
    pub fn idle_progress_snapshot(&self) -> Option<GoalProgressSnapshot> {
        let inner = self.inner.lock().unwrap();
        let expected_goal_id = inner.wall_clock.active_goal_id.clone()?;
        let time_delta = inner.wall_clock.elapsed_secs();
        if time_delta == 0 {
            return None;
        }
        Some(GoalProgressSnapshot {
            expected_goal_id,
            time_delta_seconds: time_delta,
            token_delta: 0,
        })
    }

    /// Mark the snapshot's delta as accounted (reset baselines).
    pub fn mark_progress_accounted(&self, snapshot: &GoalProgressSnapshot) {
        let mut inner = self.inner.lock().unwrap();
        // Reset turn token baseline if there's a matching turn
        let turn_id = inner.current_turn_id.clone();
        if let Some(tid) = turn_id {
            if let Some(turn) = inner.turns.get_mut(&tid) {
                turn.reset_baseline();
            }
        }
        // Advance wall-clock baseline
        inner.wall_clock.advance(snapshot.time_delta_seconds);
    }

    /// Clear the active goal from all tracking.
    pub fn clear_active_goal(&self) {
        let mut inner = self.inner.lock().unwrap();
        // Remove goal from current turn
        let turn_id = inner.current_turn_id.clone();
        if let Some(tid) = turn_id {
            if let Some(turn) = inner.turns.get_mut(&tid) {
                turn.active_goal_id = None;
            }
        }
        // Clear wall-clock
        inner.wall_clock.active_goal_id = None;
        inner.wall_clock.reset_baseline();
    }

    /// Check if a turn is the current active goal turn.
    pub fn turn_is_current_active_goal(&self, turn_id: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        if inner.current_turn_id.as_deref() != Some(turn_id) {
            return false;
        }
        inner
            .turns
            .get(turn_id)
            .and_then(|t| t.active_goal_id.as_ref())
            .is_some()
    }

    /// Finish a turn — remove its tracking state.
    pub fn finish_turn(&self, turn_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.turns.remove(turn_id);
        if inner.current_turn_id.as_deref() == Some(turn_id) {
            inner.current_turn_id = None;
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(input: i64, cached: i64, output: i64) -> TokenUsage {
        TokenUsage {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: 0,
            total_tokens: input + output,
        }
    }

    #[test]
    fn test_token_delta() {
        let prev = usage(100, 20, 50);
        let curr = usage(200, 30, 100);
        // delta: (200-100) - (30-20) + (100-50) = 100 - 10 + 50 = 140
        assert_eq!(goal_token_delta(&prev, &curr), 140);
    }

    #[test]
    fn test_no_double_count() {
        let accounting = GoalAccountingState::new();
        let start = usage(0, 0, 0);
        accounting.start_turn("t1", &start);

        // Mark goal active, resetting baseline
        accounting.mark_turn_goal_active("t1", "g1");

        // Simulate first usage update
        let u1 = usage(100, 20, 50);
        let r1 = accounting.record_token_usage("t1", &u1);
        assert!(r1.is_some());
        assert_eq!(r1.unwrap().turn_delta, 130); // 100-20+50

        // Account and reset (simulating what tool-finish hook does)
        let snap = accounting.progress_snapshot("t1");
        assert!(snap.is_some());
        if let Some(s) = snap {
            accounting.mark_progress_accounted(&s);
        }

        // Now simulate recording the same usage again (no new tokens)
        let r_same = accounting.record_token_usage("t1", &u1);
        // No new tokens → no delta → None
        assert!(r_same.is_none());

        // New usage after baseline reset
        let u2 = usage(150, 30, 80);
        let r2 = accounting.record_token_usage("t1", &u2);
        assert!(r2.is_some());
        // delta: (150-100) - (30-20) + (80-50) = 50 - 10 + 30 = 70
        assert_eq!(r2.unwrap().turn_delta, 70);
    }

    #[test]
    fn test_no_goal_no_accounting() {
        let accounting = GoalAccountingState::new();
        accounting.start_turn("t1", &TokenUsage::zero());
        let u = usage(100, 0, 50);
        let r = accounting.record_token_usage("t1", &u);
        // No goal active on this turn — should return None
        assert!(r.is_none());
    }

    #[test]
    fn test_clear_active_goal() {
        let accounting = GoalAccountingState::new();
        accounting.start_turn("t1", &TokenUsage::zero());
        accounting.mark_turn_goal_active("t1", "g1");
        assert!(accounting.turn_is_current_active_goal("t1"));

        accounting.clear_active_goal();
        assert!(!accounting.turn_is_current_active_goal("t1"));
    }

    #[test]
    fn test_finish_turn() {
        let accounting = GoalAccountingState::new();
        accounting.start_turn("t1", &TokenUsage::zero());
        assert_eq!(accounting.current_turn_id(), Some("t1".into()));
        accounting.finish_turn("t1");
        assert_eq!(accounting.current_turn_id(), None);
    }
}
