/// Cron type definitions for the kimi-agent Rust engine.
///
/// Mirrors the TS types in `packages/agent-core/src/tools/cron/types.ts`.

use serde::{Deserialize, Serialize};

/// Persistent representation of a cron task.
///
/// - `id` — 8-hex; jitter is keyed off this hash, so stable id == stable
///   jitter across schedule rewrites.
/// - `cron` — 5-field expression, evaluated in local time.
/// - `created_at` — wall-clock epoch ms at original scheduling. NOT updated
///   when the scheduler fires; recurring uses it as the baseline floor
///   when no `last_fired_at` has been recorded. Also the input to the
///   7-day stale judgment.
/// - `recurring` — true (default) means "fire repeatedly until deleted
///   or auto-expired"; false means "fire once then auto-delete".
/// - `last_fired_at` — wall-clock epoch ms of the last ideal occurrence
///   whose jittered delivery has actually completed. Persisted so
///   resuming the session does not replay already-delivered recurring
///   fires.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronTask {
    pub id: String,
    pub cron: String,
    pub prompt: String,
    pub created_at: u64,
    #[serde(default = "default_recurring", skip_serializing_if = "Option::is_none")]
    pub recurring: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fired_at: Option<u64>,
}

fn default_recurring() -> Option<bool> {
    Some(true)
}

impl CronTask {
    /// Returns true when this task is recurring (default).
    pub fn is_recurring(&self) -> bool {
        self.recurring.unwrap_or(true)
    }

    /// Returns true when this task is one-shot.
    pub fn is_one_shot(&self) -> bool {
        !self.is_recurring()
    }
}

/// Input to create a cron task (everything except `id` and `created_at`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronTaskInit {
    pub cron: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurring: Option<bool>,
}

/// Parsed 5-field cron expression. Opaque to callers — pass it back into
/// `compute_next_cron_run`.
#[derive(Debug, Clone)]
pub struct ParsedCronExpression {
    pub raw: String,
    pub minutes: Vec<u8>,
    pub hours: Vec<u8>,
    pub days_of_month: Vec<u8>,
    pub months: Vec<u8>,
    pub days_of_week: Vec<u8>,
    /// True if the source field was `*` — needed so cron's dom/dow OR rule
    /// fires only when both are restricted.
    pub days_of_month_wildcard: bool,
    pub days_of_week_wildcard: bool,
}

/// Tunables for jitter calculation.
#[derive(Debug, Clone, Copy)]
pub struct JitterConfig {
    /// Recurring offset cap as a fraction of the cron period (0..1).
    pub recurring_max_fraction_of_period: f64,
    /// Absolute cap on the recurring offset, in ms.
    pub recurring_max_ms: u64,
    /// Absolute cap on the one-shot pull-forward, in ms.
    pub one_shot_max_ms: u64,
}

impl Default for JitterConfig {
    fn default() -> Self {
        Self {
            recurring_max_fraction_of_period: 0.1,
            recurring_max_ms: 15 * 60_000,
            one_shot_max_ms: 90_000,
        }
    }
}

/// Goal status values matching the Rust GoalStatus enum (used in cron context).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GoalStatus {
    Active,
    Paused,
    Blocked,
    Complete,
    BudgetLimited,
    UsageLimited,
}

/// Fire-and-forget event sent from the Rust scheduler to the JS host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronFireEvent {
    pub kind: String,
    pub job_id: String,
    pub cron: String,
    pub recurring: bool,
    pub coalesced_count: u32,
    pub stale: bool,
    pub prompt: String,
}