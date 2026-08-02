/// GoalMode — goal-driven autonomous mode state machine.
///
/// Corresponds to `packages/agent-core/src/agent/goal/index.ts`.
///
/// Manages a single goal's lifecycle: creation, status transitions, budget
/// tracking (tokens, turns, wall-clock), snapshot reporting, and independent
/// completion verification. The goal driver (in turn_flow) uses this to
/// decide whether to continue or stop.

pub mod completion_verifier;
pub mod injection;
pub mod judge;
pub mod steering;

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

// ── Public types ──────────────────────────────────────────────────────────

/// Lifecycle status of a goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoalStatus {
    /// The goal is live and may run continuation turns.
    Active,
    /// The user or runtime paused the goal; resumable.
    Paused,
    /// The system stopped pursuing the goal; resumable.
    Blocked,
    /// Success (transient — announced, then cleared).
    Complete,
    /// Token budget reached; not resumable without new budget.
    BudgetLimited,
    /// API usage limit reached; not resumable.
    UsageLimited,
}

/// Who performed a goal action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GoalActor {
    User,
    Model,
    Runtime,
    System,
}

/// Budget limit configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GoalBudgetLimits {
    pub token_budget: Option<u64>,
    pub turn_budget: Option<u32>,
    pub wall_clock_budget_ms: Option<u64>,
}

/// Computed budget report.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalBudgetReport {
    pub token_budget: Option<u64>,
    pub turn_budget: Option<u32>,
    pub wall_clock_budget_ms: Option<u64>,
    pub remaining_tokens: Option<u64>,
    pub remaining_turns: Option<u32>,
    pub remaining_wall_clock_ms: Option<u64>,
    pub token_budget_reached: bool,
    pub turn_budget_reached: bool,
    pub wall_clock_budget_reached: bool,
    pub over_budget: bool,
}

/// Public snapshot of the current goal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSnapshot {
    pub goal_id: String,
    pub objective: String,
    pub completion_criterion: Option<String>,
    pub status: GoalStatus,
    pub turns_used: u32,
    pub tokens_used: u64,
    pub wall_clock_ms: u64,
    pub budget: GoalBudgetReport,
    pub terminal_reason: Option<String>,
    pub blocked_streak: Option<u32>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Tool result wrapper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalToolResult {
    pub goal: Option<GoalSnapshot>,
}

/// Input for creating a goal.
#[derive(Debug, Clone)]
pub struct CreateGoalInput {
    pub objective: String,
    pub completion_criterion: Option<String>,
    pub replace: bool,
}

/// In-memory goal state.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct GoalState {
    goal_id: String,
    objective: String,
    completion_criterion: Option<String>,
    status: GoalStatus,
    turns_used: u32,
    tokens_used: u64,
    wall_clock_ms: u64,
    wall_clock_resumed_at: Option<u64>,
    budget_limits: GoalBudgetLimits,
    terminal_reason: Option<String>,
    blocked_streak: Option<u32>,
    completion_rejections: Option<u32>,
    created_at: u64,
    updated_at: u64,
}

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_GOAL_OBJECTIVE_LENGTH: usize = 4000;
const GOAL_CANCELLED_REMINDER: &str = "The user cancelled the current goal. Ignore earlier active-goal reminders for that goal. Handle the next user request normally unless the user starts or resumes a goal.";
const GOAL_FORK_CLEARED_REMINDER: &str = "This fork does not have a current goal. Ignore earlier active-goal reminders from the source session. Handle requests normally unless the user starts a new goal.";

// ── GoalMode ──────────────────────────────────────────────────────────────

/// Goal-mode state machine and budget tracker.
pub struct GoalMode {
    state: Option<GoalState>,
    delegate: Option<Box<dyn GoalDelegate + Send + Sync>>,
    verifier: Option<Box<dyn completion_verifier::GoalVerifier>>,
}

/// Delegate trait for goal side effects (record logging, events, telemetry).
///
/// The host implements this trait to receive notifications when goal state
/// changes. Each method provides the relevant snapshot at the point of change.
pub trait GoalDelegate: Send + Sync {
    /// Called when a goal is created.
    fn on_goal_created(&self, snapshot: &GoalSnapshot, actor: GoalActor);
    /// Called when goal status or budget changes (includes all mutations).
    fn on_goal_updated(&self, snapshot: &GoalSnapshot);
    /// Called when a goal is cleared (completed, cancelled, or replaced).
    fn on_goal_cleared(&self, snapshot: &GoalSnapshot);
    /// Called when usage tokens are recorded against the goal.
    fn on_usage_recorded(&self, snapshot: &GoalSnapshot, token_delta: u64);
    /// Called for telemetry/audit events during goal lifecycle.
    /// `event` is a short event name (e.g. "create", "complete", "blocked",
    /// "budget_limited", "continuation", "verification_rejected").
    fn on_goal_telemetry(&self, snapshot: &GoalSnapshot, event: &str);
}

impl GoalMode {
    /// Create a new GoalMode (no active goal).
    pub fn new() -> Self {
        Self {
            state: None,
            delegate: None,
            verifier: None,
        }
    }

    /// Attach a delegate for recording and event emission side effects.
    pub fn set_delegate(&mut self, delegate: Box<dyn GoalDelegate + Send + Sync>) {
        self.delegate = Some(delegate);
    }

    /// Attach a completion verifier.
    ///
    /// When set, `mark_complete()` will call `verify()` before accepting
    /// the completion. If verification fails, the completion is rejected.
    pub fn set_verifier(&mut self, verifier: Box<dyn completion_verifier::GoalVerifier>) {
        self.verifier = Some(verifier);
    }

    /// Explicitly verify completion of the current goal.
    ///
    /// Returns `Ok(true)` if verification passes, `Ok(false)` if it fails,
    /// or `Err` if no verifier is set.
    pub fn verify_completion(&self, claim: &str) -> Result<bool, String> {
        let state = self.state.as_ref().ok_or_else(|| "No current goal".to_string())?;
        let snapshot = make_snapshot(state);
        match &self.verifier {
            Some(verifier) => {
                let result = verifier.verify(&snapshot, claim)?;
                Ok(result.passed)
            }
            None => Err("No verifier configured".to_string()),
        }
    }

    // ── Reads ─────────────────────────────────────────────────────────────

    /// Return the current goal snapshot wrapper.
    pub fn get_goal(&self) -> GoalToolResult {
        GoalToolResult {
            goal: self.state.as_ref().map(|s| make_snapshot(s)),
        }
    }

    /// Return the active goal snapshot, or None if no active goal.
    pub fn get_active_goal(&self) -> Option<GoalSnapshot> {
        self.state.as_ref().and_then(|s| {
            if matches!(s.status, GoalStatus::Active) {
                Some(make_snapshot(s))
            } else {
                None
            }
        })
    }

    // ── Creation ──────────────────────────────────────────────────────────

    /// Create a new goal.
    pub fn create_goal(&mut self, input: CreateGoalInput, actor: GoalActor) -> Result<GoalSnapshot, String> {
        let objective = input.objective.trim().to_string();

        if objective.is_empty() {
            return Err("Goal objective cannot be empty".to_string());
        }
        if objective.len() > MAX_GOAL_OBJECTIVE_LENGTH {
            return Err(format!(
                "Goal objective cannot exceed {} characters",
                MAX_GOAL_OBJECTIVE_LENGTH
            ));
        }

        let completion_criterion = normalize_completion_criterion(input.completion_criterion);

        if self.state.is_some() {
            if !input.replace {
                return Err("A goal already exists; use replace to start a new one".to_string());
            }
            self.state = None;
        }

        let now = now_ms();
        let state = GoalState {
            goal_id: generate_goal_id(),
            objective,
            completion_criterion,
            status: GoalStatus::Active,
            turns_used: 0,
            tokens_used: 0,
            wall_clock_ms: 0,
            wall_clock_resumed_at: Some(now),
            budget_limits: GoalBudgetLimits::default(),
            terminal_reason: None,
            blocked_streak: None,
            completion_rejections: None,
            created_at: now,
            updated_at: now,
        };

        let snapshot = make_snapshot(&state);
        self.state = Some(state);
        if let Some(ref delegate) = self.delegate {
            delegate.on_goal_created(&snapshot, actor);
            delegate.on_goal_telemetry(&snapshot, "create");
        }
        Ok(snapshot)
    }

    // ── User-owned lifecycle ──────────────────────────────────────────────

    /// Pause the current goal.
    pub fn pause_goal(&mut self, reason: Option<String>, _actor: GoalActor) -> Result<GoalSnapshot, String> {
        // Clone state to avoid borrow conflict with self
        let state_clone = self.clone_state()?;
        let mut state = state_clone;
        if matches!(state.status, GoalStatus::Paused) {
            return Ok(make_snapshot(&state));
        }
        if !matches!(state.status, GoalStatus::Active) {
            return Err(format!("Cannot pause a goal in status {:?}", state.status));
        }
        transition_state(&mut state, GoalStatus::Paused);
        state.terminal_reason = reason;
        state.updated_at = now_ms();
        let snapshot = make_snapshot(&state);
        self.state = Some(state);
        Ok(snapshot)
    }

    /// Pause the current goal if it is active (no-op if not active, no error).
    pub fn pause_active_goal(&mut self, reason: Option<String>, _actor: GoalActor) -> Option<GoalSnapshot> {
        let state = self.state.as_mut()?;
        if !matches!(state.status, GoalStatus::Active) {
            return None;
        }
        transition_state(state, GoalStatus::Paused);
        state.terminal_reason = reason;
        state.updated_at = now_ms();
        Some(make_snapshot(state))
    }

    /// Resume a paused or blocked goal.
    pub fn resume_goal(&mut self, reason: Option<String>, _actor: GoalActor) -> Result<GoalSnapshot, String> {
        let state_clone = self.clone_state()?;
        let mut state = state_clone;
        if matches!(state.status, GoalStatus::Active) {
            return Ok(make_snapshot(&state));
        }
        if !matches!(state.status, GoalStatus::Paused | GoalStatus::Blocked) {
            return Err(format!("Cannot resume a goal in status {:?}", state.status));
        }
        transition_state(&mut state, GoalStatus::Active);
        state.terminal_reason = reason;
        state.updated_at = now_ms();
        let snapshot = make_snapshot(&state);
        self.state = Some(state);
        Ok(snapshot)
    }

    /// Cancel (discard) the current goal.
    pub fn cancel_goal(&mut self, _actor: GoalActor) -> Result<GoalSnapshot, String> {
        let state = self.state.take().ok_or_else(|| "No current goal".to_string())?;
        let snapshot = make_snapshot(&state);
        if let Some(ref delegate) = self.delegate {
            delegate.on_goal_telemetry(&snapshot, "cancel");
            delegate.on_goal_cleared(&snapshot);
        }
        Ok(snapshot)
    }

    /// Set budget limits on the current goal.
    pub fn set_budget_limits(&mut self, limits: GoalBudgetLimits) -> Result<GoalSnapshot, String> {
        let state = self.state.as_mut().ok_or_else(|| "No current goal".to_string())?;
        if let Some(tb) = limits.token_budget {
            state.budget_limits.token_budget = Some(tb);
        }
        if let Some(tb) = limits.turn_budget {
            state.budget_limits.turn_budget = Some(tb);
        }
        if let Some(wb) = limits.wall_clock_budget_ms {
            state.budget_limits.wall_clock_budget_ms = Some(wb);
        }
        state.updated_at = now_ms();
        Ok(make_snapshot(state))
    }

    // ── Terminal outcomes ─────────────────────────────────────────────────

    /// Mark the goal as blocked (system stopped, resumable).
    pub fn mark_blocked(&mut self, reason: Option<String>, _actor: GoalActor) -> Option<GoalSnapshot> {
        let state = self.state.as_mut()?;
        if !matches!(state.status, GoalStatus::Active) {
            return None;
        }
        transition_state(state, GoalStatus::Blocked);
        state.terminal_reason = reason;
        state.updated_at = now_ms();
        let snapshot = make_snapshot(state);
        if let Some(ref delegate) = self.delegate {
            delegate.on_goal_telemetry(&snapshot, "blocked");
        }
        Some(snapshot)
    }

    /// Mark the goal as budget-limited (not resumable without new budget).
    pub fn mark_budget_limited(&mut self, reason: Option<String>, _actor: GoalActor) -> Option<GoalSnapshot> {
        let state = self.state.as_mut()?;
        if !matches!(state.status, GoalStatus::Active) {
            return None;
        }
        transition_state(state, GoalStatus::BudgetLimited);
        state.terminal_reason = reason;
        state.updated_at = now_ms();
        let snapshot = make_snapshot(state);
        if let Some(ref delegate) = self.delegate {
            delegate.on_goal_telemetry(&snapshot, "budget_limited");
        }
        Some(snapshot)
    }

    /// Mark the goal as complete (transient — announced, then cleared).
    ///
    /// If a verifier is set, it will be called with the given `claim`
    /// to independently verify completion. If verification fails, the
    /// goal is NOT marked complete and the method returns `None` (the
    /// caller should check `record_completion_rejection()` for the
    /// rejection count).
    pub fn mark_complete(&mut self, reason: Option<String>, _actor: GoalActor) -> Option<GoalSnapshot> {
        let state = self.state.as_mut()?;
        if !matches!(state.status, GoalStatus::Active) {
            return None;
        }

        // Independent verification before accepting completion.
        if let Some(ref verifier) = self.verifier {
            let snapshot_before = make_snapshot(state);
            let claim = reason.as_deref().unwrap_or("");
            match verifier.verify(&snapshot_before, claim) {
                Ok(result) if !result.passed => {
                    // Verification failed — reject completion.
                    self.record_completion_rejection();
                    if let Some(ref delegate) = self.delegate {
                        delegate.on_goal_telemetry(&snapshot_before, "verification_rejected");
                    }
                    return None;
                }
                Err(_e) => {
                    // Verifier error — fail open so completion is not blocked.
                    if let Some(ref delegate) = self.delegate {
                        delegate.on_goal_telemetry(&snapshot_before, "verification_error");
                    }
                    // Continue to mark complete despite verifier error.
                }
                _ => { /* verification passed */ }
            }
        }

        transition_state(state, GoalStatus::Complete);
        state.terminal_reason = reason;
        let snapshot = make_snapshot(state);
        if let Some(ref delegate) = self.delegate {
            delegate.on_goal_updated(&snapshot);
            delegate.on_goal_telemetry(&snapshot, "complete");
            delegate.on_goal_cleared(&snapshot);
        }
        self.state = None;
        Some(snapshot)
    }

    // ── User-interrupt transition ─────────────────────────────────────────

    /// Park an active goal when its turn is aborted.
    pub fn pause_on_interrupt(&mut self, reason: Option<String>) -> Option<GoalSnapshot> {
        self.pause_active_goal(reason, GoalActor::User)
    }

    // ── Persistence ──

    /// The durable form of the current goal for session persistence, or
    /// `None` when no goal exists.
    pub fn persisted_state(&self) -> Option<serde_json::Value> {
        self.state.as_ref().and_then(|state| serde_json::to_value(state).ok())
    }

    /// Restore a goal saved by `persisted_state`.
    ///
    /// GOAL.md restart rule: a goal that was `active` when the process died
    /// comes back `paused` — the old process's active turn cannot still be
    /// alive, and auto-continuing after a restart would silently burn
    /// resources. Paused / blocked / budgetLimited / usageLimited restore
    /// as-is; `complete` is transient and never restored. The wall-clock
    /// interval is closed: restored goals are not actively pursuing.
    pub fn restore_persisted(&mut self, value: &serde_json::Value) -> Option<GoalSnapshot> {
        let mut state: GoalState = serde_json::from_value(value.clone()).ok()?;
        if matches!(state.status, GoalStatus::Complete) {
            return None;
        }
        state.wall_clock_resumed_at = None;
        if matches!(state.status, GoalStatus::Active) {
            state.status = GoalStatus::Paused;
            state.terminal_reason = Some(
                "Paused after restart (the previous session's active turn cannot resume)"
                    .to_string(),
            );
        }
        state.updated_at = now_ms();
        let snapshot = make_snapshot(&state);
        self.state = Some(state);
        if let Some(ref delegate) = self.delegate {
            delegate.on_goal_updated(&snapshot);
        }
        Some(snapshot)
    }

    // ── Accounting & reporting ────────────────────────────────────────────

    /// Record a blocked attempt (increments blocked streak).
    pub fn record_blocked_attempt(&mut self) -> Option<GoalSnapshot> {
        let state = self.state.as_mut()?;
        if !matches!(state.status, GoalStatus::Active) {
            return None;
        }
        state.blocked_streak = Some(state.blocked_streak.unwrap_or(0) + 1);
        state.updated_at = now_ms();
        Some(make_snapshot(state))
    }

    /// Record a completion rejection. Returns the new rejection count.
    pub fn record_completion_rejection(&mut self) -> u32 {
        let state = match self.state.as_mut() {
            Some(s) => s,
            None => return 0,
        };
        state.completion_rejections = Some(state.completion_rejections.unwrap_or(0) + 1);
        state.updated_at = now_ms();
        state.completion_rejections.unwrap_or(0)
    }

    /// Record token usage for the active goal.
    pub fn record_token_usage(&mut self, token_delta: u64) -> Option<GoalSnapshot> {
        let state = self.state.as_mut()?;
        if !matches!(state.status, GoalStatus::Active) {
            return None;
        }
        state.tokens_used = state.tokens_used.saturating_add(token_delta);
        state.updated_at = now_ms();
        let snapshot = make_snapshot(state);
        if let Some(ref delegate) = self.delegate {
            delegate.on_usage_recorded(&snapshot, token_delta);
        }
        Some(snapshot)
    }

    /// Increment the turn counter for the active goal.
    pub fn increment_turn(&mut self) -> Option<GoalSnapshot> {
        let state = self.state.as_mut()?;
        if !matches!(state.status, GoalStatus::Active) {
            return None;
        }
        state.turns_used = state.turns_used.saturating_add(1);
        state.updated_at = now_ms();
        Some(make_snapshot(state))
    }

    // ── Replay / restore ──────────────────────────────────────────────────

    /// Normalize after replay: demote active to paused, clear complete.
    pub fn normalize_after_replay(&mut self) {
        let state = match self.state.as_mut() {
            Some(s) => s,
            None => return,
        };
        state.wall_clock_resumed_at = None;

        match state.status {
            GoalStatus::Complete => {
                self.state = None;
            }
            GoalStatus::Active => {
                state.status = GoalStatus::Paused;
                state.terminal_reason = Some("Paused after agent resume".to_string());
                state.updated_at = now_ms();
            }
            _ => {}
        }
    }

    /// Restore a goal from a create record.
    pub fn restore_create(&mut self, goal_id: String, objective: String, completion_criterion: Option<String>) {
        let now = now_ms();
        self.state = Some(GoalState {
            goal_id,
            objective,
            completion_criterion,
            status: GoalStatus::Active,
            turns_used: 0,
            tokens_used: 0,
            wall_clock_ms: 0,
            wall_clock_resumed_at: None,
            budget_limits: GoalBudgetLimits::default(),
            terminal_reason: None,
            blocked_streak: None,
            completion_rejections: None,
            created_at: now,
            updated_at: now,
        });
    }

    /// Restore a goal from an update record.
    pub fn restore_update(
        &mut self,
        status: Option<GoalStatus>,
        turns_used: Option<u32>,
        tokens_used: Option<u64>,
        wall_clock_ms: Option<u64>,
        budget_limits: Option<GoalBudgetLimits>,
        completion_rejections: Option<u32>,
        reason: Option<String>,
    ) {
        let state = match self.state.as_mut() {
            Some(s) => s,
            None => return,
        };

        if let Some(st) = status {
            state.status = st;
            state.wall_clock_resumed_at = None;
            state.terminal_reason = if matches!(st, GoalStatus::Active) { None } else { reason };
        }
        if let Some(tu) = turns_used {
            state.turns_used = tu;
        }
        if let Some(tu) = tokens_used {
            state.tokens_used = tu;
        }
        if let Some(wm) = wall_clock_ms {
            state.wall_clock_ms = wm;
            state.wall_clock_resumed_at = None;
        }
        if let Some(bl) = budget_limits {
            state.budget_limits = bl;
        }
        if let Some(cr) = completion_rejections {
            state.completion_rejections = Some(cr);
        }
        state.updated_at = now_ms();
    }

    /// Restore a goal clear (remove the goal).
    pub fn restore_clear(&mut self) {
        self.state = None;
    }

    /// Restore from a fork: clear goal if one existed.
    pub fn restore_forked(&mut self) -> bool {
        let had_goal = self.state.is_some();
        self.state = None;
        had_goal
    }

    /// Get the "goal cancelled" system reminder text.
    pub fn cancelled_reminder() -> &'static str {
        GOAL_CANCELLED_REMINDER
    }

    /// Get the "fork cleared" system reminder text.
    pub fn fork_cleared_reminder() -> &'static str {
        GOAL_FORK_CLEARED_REMINDER
    }

    // ── Internals ─────────────────────────────────────────────────────────

    /// Clone the current state (for methods that need to take &self afterwards).
    fn clone_state(&self) -> Result<GoalState, String> {
        self.state.clone().ok_or_else(|| "No current goal".to_string())
    }
}

impl Default for GoalMode {
    fn default() -> Self {
        Self::new()
    }
}

// ── Free functions ────────────────────────────────────────────────────────

/// Build a GoalSnapshot from a GoalState.
fn make_snapshot(state: &GoalState) -> GoalSnapshot {
    let now = now_ms();
    let wall_clock_ms = live_wall_clock_ms(state, now);
    let budget = compute_budget_report(state, now);

    GoalSnapshot {
        goal_id: state.goal_id.clone(),
        objective: state.objective.clone(),
        completion_criterion: state.completion_criterion.clone(),
        status: state.status,
        turns_used: state.turns_used,
        tokens_used: state.tokens_used,
        wall_clock_ms,
        budget,
        terminal_reason: state.terminal_reason.clone(),
        blocked_streak: state.blocked_streak,
        created_at: state.created_at,
        updated_at: state.updated_at,
    }
}

/// Live active-pursuit time: accumulated total + in-flight Active interval.
fn live_wall_clock_ms(state: &GoalState, now: u64) -> u64 {
    if matches!(state.status, GoalStatus::Active) {
        if let Some(resumed_at) = state.wall_clock_resumed_at {
            return state.wall_clock_ms.saturating_add(now.saturating_sub(resumed_at));
        }
    }
    state.wall_clock_ms
}

/// Compute the budget report for a state.
fn compute_budget_report(state: &GoalState, now: u64) -> GoalBudgetReport {
    let limits = &state.budget_limits;
    let token_budget = limits.token_budget;
    let turn_budget = limits.turn_budget;
    let wall_clock_budget_ms = limits.wall_clock_budget_ms;
    let wall_clock_ms = live_wall_clock_ms(state, now);

    let token_budget_reached = token_budget.map_or(false, |b| state.tokens_used >= b);
    let turn_budget_reached = turn_budget.map_or(false, |b| state.turns_used >= b);
    let wall_clock_budget_reached = wall_clock_budget_ms.map_or(false, |b| wall_clock_ms >= b);

    GoalBudgetReport {
        token_budget,
        turn_budget,
        wall_clock_budget_ms,
        remaining_tokens: token_budget.map(|b| b.saturating_sub(state.tokens_used)),
        remaining_turns: turn_budget.map(|b| b.saturating_sub(state.turns_used)),
        remaining_wall_clock_ms: wall_clock_budget_ms.map(|b| b.saturating_sub(wall_clock_ms)),
        token_budget_reached,
        turn_budget_reached,
        wall_clock_budget_reached,
        over_budget: token_budget_reached || turn_budget_reached || wall_clock_budget_reached,
    }
}

/// Apply a status transition to a state (free function, no &self needed).
fn transition_state(state: &mut GoalState, new_status: GoalStatus) {
    if new_status == state.status {
        return;
    }
    let now = now_ms();

    // Fold wall-clock when leaving Active.
    if matches!(state.status, GoalStatus::Active) {
        if let Some(resumed_at) = state.wall_clock_resumed_at {
            state.wall_clock_ms = state.wall_clock_ms.saturating_add(
                now.saturating_sub(resumed_at),
            );
            state.wall_clock_resumed_at = None;
        }
    }

    // Set up wall-clock when entering Active.
    if matches!(new_status, GoalStatus::Active) {
        state.blocked_streak = Some(0);
        state.wall_clock_resumed_at = Some(now);
        state.terminal_reason = None;
    }

    state.status = new_status;
}

/// Normalize completion criterion (truncate if too long).
fn normalize_completion_criterion(criterion: Option<String>) -> Option<String> {
    criterion.map(|c| {
        let trimmed = c.trim();
        if trimmed.len() > MAX_GOAL_OBJECTIVE_LENGTH {
            let mut s: String = trimmed.chars().take(MAX_GOAL_OBJECTIVE_LENGTH).collect();
            s.push('…');
            s
        } else {
            trimmed.to_string()
        }
    })
}

/// Generate a unique goal ID.
fn generate_goal_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let now = now_ms();
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("goal-{:x}-{:x}", now, count)
}

/// Current time in milliseconds since UNIX epoch.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_goal_mode() -> GoalMode {
        GoalMode::new()
    }

    fn make_input(objective: &str) -> CreateGoalInput {
        CreateGoalInput {
            objective: objective.to_string(),
            completion_criterion: None,
            replace: false,
        }
    }

    #[test]
    fn test_new_has_no_goal() {
        let gm = make_goal_mode();
        assert!(gm.get_goal().goal.is_none());
        assert!(gm.get_active_goal().is_none());
    }

    #[test]
    fn test_create_goal() {
        let mut gm = make_goal_mode();
        let snapshot = gm.create_goal(make_input("test objective"), GoalActor::User).unwrap();
        assert_eq!(snapshot.objective, "test objective");
        assert_eq!(snapshot.status, GoalStatus::Active);
        assert_eq!(snapshot.turns_used, 0);
        assert_eq!(snapshot.tokens_used, 0);
    }

    #[test]
    fn test_create_goal_empty_fails() {
        let mut gm = make_goal_mode();
        let result = gm.create_goal(make_input(""), GoalActor::User);
        assert!(result.is_err());
    }

    #[test]
    fn test_create_goal_too_long_fails() {
        let mut gm = make_goal_mode();
        let long = "x".repeat(MAX_GOAL_OBJECTIVE_LENGTH + 1);
        let result = gm.create_goal(CreateGoalInput {
            objective: long,
            completion_criterion: None,
            replace: false,
        }, GoalActor::User);
        assert!(result.is_err());
    }

    #[test]
    fn test_create_goal_replace() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("first"), GoalActor::User).unwrap();
        let result = gm.create_goal(make_input("second"), GoalActor::User);
        assert!(result.is_err()); // replace not set

        let snapshot = gm.create_goal(CreateGoalInput {
            objective: "second".to_string(),
            completion_criterion: None,
            replace: true,
        }, GoalActor::User).unwrap();
        assert_eq!(snapshot.objective, "second");
    }

    #[test]
    fn test_pause_goal() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let snapshot = gm.pause_goal(Some("user requested pause".into()), GoalActor::User).unwrap();
        assert_eq!(snapshot.status, GoalStatus::Paused);
    }

    #[test]
    fn test_pause_non_active_fails() {
        let mut gm = make_goal_mode();
        let result = gm.pause_goal(None, GoalActor::User);
        assert!(result.is_err());
    }

    #[test]
    fn test_resume_goal() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let _ = gm.pause_goal(None, GoalActor::User).unwrap();
        let snapshot = gm.resume_goal(None, GoalActor::User).unwrap();
        assert_eq!(snapshot.status, GoalStatus::Active);
        assert_eq!(snapshot.blocked_streak, Some(0));
    }

    #[test]
    fn test_resume_twice_ok() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let _ = gm.resume_goal(None, GoalActor::User).unwrap();
        let snapshot = gm.get_goal().goal.unwrap();
        assert_eq!(snapshot.status, GoalStatus::Active);
    }

    #[test]
    fn test_cancel_goal() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let snapshot = gm.cancel_goal(GoalActor::User).unwrap();
        assert_eq!(snapshot.objective, "test");
        assert!(gm.get_goal().goal.is_none());
    }

    #[test]
    fn test_cancel_no_goal_fails() {
        let mut gm = make_goal_mode();
        let result = gm.cancel_goal(GoalActor::User);
        assert!(result.is_err());
    }

    #[test]
    fn test_mark_blocked() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let snapshot = gm.mark_blocked(Some("cannot proceed".into()), GoalActor::Model).unwrap();
        assert_eq!(snapshot.status, GoalStatus::Blocked);
        assert_eq!(snapshot.terminal_reason.as_deref(), Some("cannot proceed"));
    }

    #[test]
    fn test_mark_blocked_noop_when_inactive() {
        let mut gm = make_goal_mode();
        assert!(gm.mark_blocked(None, GoalActor::Runtime).is_none());
    }

    #[test]
    fn test_mark_budget_limited() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let snapshot = gm.mark_budget_limited(Some("token budget reached".into()), GoalActor::Runtime).unwrap();
        assert_eq!(snapshot.status, GoalStatus::BudgetLimited);
    }

    #[test]
    fn test_mark_complete() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let snapshot = gm.mark_complete(Some("objective met".into()), GoalActor::Model);
        assert!(snapshot.is_some());
        assert_eq!(snapshot.unwrap().status, GoalStatus::Complete);
        assert!(gm.get_goal().goal.is_none());
    }

    #[test]
    fn test_increment_turn() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let s = gm.increment_turn().unwrap();
        assert_eq!(s.turns_used, 1);
        let s = gm.increment_turn().unwrap();
        assert_eq!(s.turns_used, 2);
    }

    #[test]
    fn test_increment_turn_noop_when_inactive() {
        let mut gm = make_goal_mode();
        assert!(gm.increment_turn().is_none());
    }

    #[test]
    fn test_record_token_usage() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let s = gm.record_token_usage(100).unwrap();
        assert_eq!(s.tokens_used, 100);
        let s = gm.record_token_usage(50).unwrap();
        assert_eq!(s.tokens_used, 150);
    }

    #[test]
    fn test_set_budget_limits() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let limits = GoalBudgetLimits {
            token_budget: Some(1000),
            turn_budget: Some(10),
            wall_clock_budget_ms: Some(3600000),
        };
        let s = gm.set_budget_limits(limits).unwrap();
        assert_eq!(s.budget.token_budget, Some(1000));
        assert_eq!(s.budget.turn_budget, Some(10));
    }

    #[test]
    fn test_budget_report_over_budget() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let limits = GoalBudgetLimits {
            token_budget: Some(100),
            turn_budget: None,
            wall_clock_budget_ms: None,
        };
        let _ = gm.set_budget_limits(limits).unwrap();
        let _ = gm.record_token_usage(150).unwrap();
        let snapshot = gm.get_goal().goal.unwrap();
        assert!(snapshot.budget.token_budget_reached);
        assert!(snapshot.budget.over_budget);
    }

    #[test]
    fn restore_downgrades_active_to_paused() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("survive restarts"), GoalActor::User).unwrap();
        let persisted = gm.persisted_state().expect("active goal persists");

        let mut restored = GoalMode::new();
        let snapshot = restored.restore_persisted(&persisted).expect("restores");
        assert!(matches!(snapshot.status, GoalStatus::Paused), "active must downgrade");
        assert!(snapshot.terminal_reason.unwrap_or_default().contains("restart"));
        // Downgraded, not lost: the user can resume it.
        assert!(restored.resume_goal(None, GoalActor::User).is_ok());
    }

    #[test]
    fn restore_keeps_blocked_and_never_restores_complete() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let _ = gm.mark_blocked(Some("stuck".into()), GoalActor::Model).unwrap();
        let blocked = gm.persisted_state().expect("blocked goal persists");
        let mut restored = GoalMode::new();
        let snapshot = restored.restore_persisted(&blocked).expect("restores");
        assert!(matches!(snapshot.status, GoalStatus::Blocked), "blocked restores as-is");

        // Complete is transient: a (hypothetical) persisted complete record
        // must not come back.
        let mut complete = blocked.clone();
        complete["status"] = serde_json::to_value(GoalStatus::Complete).unwrap();
        let mut skipped = GoalMode::new();
        assert!(skipped.restore_persisted(&complete).is_none());
        assert!(skipped.get_goal().goal.is_none());
    }

    #[test]
    fn test_record_blocked_attempt() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let s = gm.record_blocked_attempt().unwrap();
        assert_eq!(s.blocked_streak, Some(1));
        let s = gm.record_blocked_attempt().unwrap();
        assert_eq!(s.blocked_streak, Some(2));
    }

    #[test]
    fn test_record_completion_rejection() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        assert_eq!(gm.record_completion_rejection(), 1);
        assert_eq!(gm.record_completion_rejection(), 2);
    }

    #[test]
    fn test_normalize_after_replay_active_demoted() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        assert_eq!(gm.get_goal().goal.unwrap().status, GoalStatus::Active);
        gm.normalize_after_replay();
        let snapshot = gm.get_goal().goal.unwrap();
        assert_eq!(snapshot.status, GoalStatus::Paused);
        assert_eq!(snapshot.terminal_reason.as_deref(), Some("Paused after agent resume"));
    }

    #[test]
    fn test_restore_create() {
        let mut gm = make_goal_mode();
        gm.restore_create("goal-1".into(), "restored objective".into(), None);
        let snapshot = gm.get_goal().goal.unwrap();
        assert_eq!(snapshot.goal_id, "goal-1");
        assert_eq!(snapshot.objective, "restored objective");
        assert_eq!(snapshot.status, GoalStatus::Active);
    }

    #[test]
    fn test_restore_update_status() {
        let mut gm = make_goal_mode();
        gm.restore_create("g1".into(), "obj".into(), None);
        gm.restore_update(Some(GoalStatus::Blocked), None, None, None, None, None, Some("blocked".into()));
        let snapshot = gm.get_goal().goal.unwrap();
        assert_eq!(snapshot.status, GoalStatus::Blocked);
    }

    #[test]
    fn test_restore_clear() {
        let mut gm = make_goal_mode();
        gm.restore_create("g1".into(), "obj".into(), None);
        gm.restore_clear();
        assert!(gm.get_goal().goal.is_none());
    }

    #[test]
    fn test_restore_forked() {
        let mut gm = make_goal_mode();
        gm.restore_create("g1".into(), "obj".into(), None);
        let had = gm.restore_forked();
        assert!(had);
        assert!(gm.get_goal().goal.is_none());
    }

    #[test]
    fn test_pause_on_interrupt() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let s = gm.pause_on_interrupt(Some("user pressed stop".into())).unwrap();
        assert_eq!(s.status, GoalStatus::Paused);
    }

    #[test]
    fn test_pause_active_goal_noop_when_not_active() {
        let mut gm = make_goal_mode();
        assert!(gm.pause_active_goal(None, GoalActor::Runtime).is_none());
    }

    #[test]
    fn test_wall_clock_tracking() {
        let mut gm = make_goal_mode();
        let _ = gm.create_goal(make_input("test"), GoalActor::User).unwrap();
        let snapshot = gm.get_goal().goal.unwrap();
        assert!(snapshot.wall_clock_ms > 0 || snapshot.budget.remaining_wall_clock_ms.is_none());
    }

    #[test]
    fn test_normalize_completion_criterion_truncation() {
        let long = "x".repeat(MAX_GOAL_OBJECTIVE_LENGTH + 10);
        let normalized = normalize_completion_criterion(Some(long.clone()));
        assert!(normalized.is_some());
        let n = normalized.unwrap();
        // Truncated string should be shorter than the original
        assert!(n.len() < long.len());
        // Should end with the ellipsis character
        assert!(n.ends_with('…'));
    }

    #[test]
    fn test_normalize_completion_criterion_none() {
        assert!(normalize_completion_criterion(None).is_none());
    }

    #[test]
    fn test_generate_goal_id_unique() {
        let id1 = generate_goal_id();
        let id2 = generate_goal_id();
        assert_ne!(id1, id2);
    }
}