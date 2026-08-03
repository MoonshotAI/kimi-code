//! Goal wire types — moved from
//! `packages/kimi-agent/src/turn_loop/types.rs` (Rust-first migration, stage A3).
//! Pure serde types + budget math.

use serde::Deserialize;


/// Goal status, matching the 6-state machine in `kimi-native-tools::goal::state`.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub enum GoalStatus {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "paused")]
    Paused,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(rename = "complete")]
    Complete,
    #[serde(rename = "budgetLimited")]
    BudgetLimited,
    #[serde(rename = "usageLimited")]
    UsageLimited,
}

impl GoalStatus {
    /// Returns true if the goal is actively being pursued.
    pub fn is_active(self) -> bool {
        matches!(self, GoalStatus::Active)
    }
}

/// Goal context passed from the host for budget-aware turn execution.
///
/// The host owns the durable goal state; this struct carries a snapshot
/// so the Rust loop can check budgets locally and render steering text
/// without an extra round-trip per step.
#[derive(Debug, Clone, Deserialize)]
pub struct GoalContext {
    pub goal_id: String,
    pub objective: String,
    pub status: GoalStatus,
    /// Optional token budget (total tokens allowed).
    pub token_budget: Option<i64>,
    /// Optional turn budget (max turns).
    pub turn_budget: Option<i64>,
    /// Cumulative tokens consumed so far (before this turn).
    pub tokens_used: i64,
    /// Cumulative turns run so far (before this turn).
    pub turns_used: i64,
}

impl GoalContext {
    /// Returns true if adding `turn_tokens` and one more turn would exceed
    /// any configured budget.
    pub fn would_exceed_budget(&self, turn_tokens: i64, turns_this_turn: i64) -> bool {
        if let Some(budget) = self.token_budget {
            if self.tokens_used + turn_tokens >= budget {
                return true;
            }
        }
        if let Some(budget) = self.turn_budget {
            if self.turns_used + turns_this_turn >= budget {
                return true;
            }
        }
        false
    }

    /// Maximum fraction of any budget dimension currently consumed
    /// (0.0 when no budgets configured).
    pub fn budget_fraction(&self, turn_tokens: i64, turns_this_turn: i64) -> f64 {
        let mut fractions = Vec::new();
        if let Some(budget) = self.token_budget {
            if budget > 0 {
                fractions.push((self.tokens_used + turn_tokens) as f64 / budget as f64);
            }
        }
        if let Some(budget) = self.turn_budget {
            if budget > 0 {
                fractions.push((self.turns_used + turns_this_turn) as f64 / budget as f64);
            }
        }
        fractions.iter().cloned().fold(0.0_f64, f64::max)
    }
}

