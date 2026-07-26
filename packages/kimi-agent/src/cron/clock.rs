/// Clock abstraction for the cron scheduler.
///
/// Two distinct notions of time are kept apart on purpose:
///
/// 1. wall-clock — what the user perceives as "the current time". Used
///    for cron expression matching, `created_at`, and the stale judgment.
///    May be overridden in tests for simulated time.
///
/// 2. monotonic — a strictly non-decreasing counter that never jumps
///    backwards across NTP adjustments, suspend/resume. Used for the
///    poll cadence — anything where "did N seconds elapse since we last
///    looked" must hold even when the wall clock is frozen.
///
/// Every component in the cron module MUST take a `ClockSources` and
/// route every time read through it.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Clock sources for the scheduler.
#[derive(Clone)]
pub struct ClockSources {
    /// Wall-clock epoch milliseconds. May be overridden in tests.
    /// Used for cron matching, `created_at`, stale judgment.
    pub wall_now: Arc<dyn Fn() -> u64 + Send + Sync>,

    /// Strictly monotonic millisecond counter. Never overridden.
    /// Used for the poll cadence.
    pub mono_now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,

    /// Optional: monotonic Instant for timing operations.
    pub mono_instant: Arc<dyn Fn() -> Instant + Send + Sync>,
}

impl Default for ClockSources {
    fn default() -> Self {
        Self::system()
    }
}

impl ClockSources {
    /// Production default — `SystemTime::now()` + `Instant::now()`.
    pub fn system() -> Self {
        Self {
            wall_now: Arc::new(system_wall_now),
            mono_now_ms: Arc::new(system_mono_now_ms),
            mono_instant: Arc::new(Instant::now),
        }
    }

    /// Create a test clock with a fixed wall time.
    pub fn test(wall_now: u64) -> Self {
        Self {
            wall_now: Arc::new(move || wall_now),
            mono_now_ms: Arc::new(system_mono_now_ms),
            mono_instant: Arc::new(Instant::now),
        }
    }

    /// Create a clock that advances wall time by `advance_ms` per call.
    pub fn advancing(initial: u64, advance_ms: u64) -> Self {
        let current = AtomicU64::new(initial);
        Self {
            wall_now: Arc::new(move || {
                let val = current.fetch_add(advance_ms, Ordering::Relaxed);
                val
            }),
            mono_now_ms: Arc::new(system_mono_now_ms),
            mono_instant: Arc::new(Instant::now),
        }
    }
}

fn system_wall_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

fn system_mono_now_ms() -> u64 {
    // Use the elapsed time since a fixed reference point
    static START: std::sync::LazyLock<Instant> = std::sync::LazyLock::new(Instant::now);
    START.elapsed().as_millis() as u64
}