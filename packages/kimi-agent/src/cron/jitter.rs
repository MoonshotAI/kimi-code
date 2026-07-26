/// Per-task deterministic jitter for cron fire times.
///
/// Two flavours:
///
/// - **Recurring**: shift *forward* by a fraction of the period
///   (cap 10% of period, hard cap 15 min).
///
/// - **One-shot**: shift *earlier* (negative), but only when the
///   ideal lands on `:00` or `:30` — cap 90 s earlier.
///
/// The function is pure given its inputs — no module-level cache; the
/// hash is recomputed from `task_id` each call.

use crate::cron::expr::compute_next_cron_run;
use crate::cron::types::{JitterConfig, ParsedCronExpression};

const MS_PER_MINUTE: u64 = 60_000;
const MS_PER_DAY: u64 = 24 * 60 * 60_000;

/// Environment variable to disable jitter.
const ENV_NO_JITTER: &str = "KIMI_CRON_NO_JITTER";

/// Check if jitter is disabled by environment variable.
fn jitter_disabled() -> bool {
    std::env::var(ENV_NO_JITTER).as_deref() == Ok("1")
}

/// Map a task id to a deterministic fraction in `[0, 1)`.
///
/// Cron task ids are 8 hex chars (`/^[0-9a-f]{8}$/`), so `u32::from_str_radix`
/// lands neatly in range. For non-hex inputs we fall back to a djb2-style
/// reduction.
fn fraction_from_id(id: &str) -> f64 {
    // Try hex parsing for 8-char hex ids
    if id.len() == 8 && id.chars().all(|c| c.is_ascii_hexdigit()) {
        if let Ok(n) = u32::from_str_radix(id, 16) {
            return n as f64 / 0x1_0000_0000u64 as f64;
        }
    }
    // djb2 reduction for non-hex test ids
    let mut hash: i64 = 5381;
    for b in id.bytes() {
        hash = ((hash << 5).wrapping_add(hash).wrapping_add(b as i64)) & 0xFFFF_FFFF;
    }
    // Map signed int32 to [0, 1)
    let unsigned = hash as u32;
    unsigned as f64 / 0x1_0000_0000u64 as f64
}

/// Apply recurring-job jitter to an already-computed ideal fire time.
///
/// The shift is **forward only** (≥ 0), bounded by both the relative
/// fraction-of-period cap and the absolute ms cap.
pub fn jittered_next_cron_run_ms(
    task_id: &str,
    _task_cron: &str,
    parsed: &ParsedCronExpression,
    ideal_ms: u64,
    config: &JitterConfig,
) -> u64 {
    if jitter_disabled() {
        return ideal_ms;
    }

    let next_next = compute_next_cron_run(parsed, ideal_ms);
    let period = match next_next {
        Some(next) if next > ideal_ms => next - ideal_ms,
        _ => MS_PER_DAY,
    };

    let period_cap = (period as f64 * config.recurring_max_fraction_of_period) as u64;
    let cap = period_cap.min(config.recurring_max_ms);

    if cap == 0 {
        return ideal_ms;
    }

    let offset = (cap as f64 * fraction_from_id(task_id)) as u64;
    ideal_ms + offset
}

/// Apply one-shot pull-forward jitter to an ideal fire time.
///
/// Only fires on `:00` and `:30` of the hour. The shift is in
/// `[-oneShotMaxMs, 0)`. When the deterministic offset would land
/// before `created_at`, skip jitter and return `ideal_ms` unchanged.
pub fn one_shot_jittered_next_cron_run_ms(
    task_id: &str,
    ideal_ms: u64,
    created_at: Option<u64>,
    config: &JitterConfig,
) -> u64 {
    if jitter_disabled() {
        return ideal_ms;
    }

    // Only jitter if the ideal is on a minute boundary
    if ideal_ms % MS_PER_MINUTE != 0 {
        return ideal_ms;
    }

    // Check if minute is :00 or :30
    // We approximate using milliseconds since it's always on the minute
    let minutes_from_midnight = (ideal_ms % MS_PER_DAY) / MS_PER_MINUTE;
    let minute_of_hour = minutes_from_midnight % 60;
    if minute_of_hour != 0 && minute_of_hour != 30 {
        return ideal_ms;
    }

    if config.one_shot_max_ms == 0 {
        return ideal_ms;
    }

    let offset = -(config.one_shot_max_ms as f64 * fraction_from_id(task_id)) as i64;
    let shifted = (ideal_ms as i64).wrapping_add(offset);

    // Skip jitter when the budget is insufficient to avoid firing too early
    if let Some(ca) = created_at {
        if (shifted as u64) < ca {
            return ideal_ms;
        }
    }

    shifted as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cron::expr::parse_cron_expression;

    #[test]
    fn test_fraction_from_id_hex() {
        // 8-char hex id should produce a stable fraction in [0, 1)
        let f = fraction_from_id("a1b2c3d4");
        assert!(f >= 0.0 && f < 1.0);
        // Same id -> same fraction
        assert!((fraction_from_id("a1b2c3d4") - f).abs() < f64::EPSILON);
    }

    #[test]
    fn test_fraction_from_id_non_hex() {
        let f = fraction_from_id("test-id-123");
        assert!(f >= 0.0 && f < 1.0);
        // Same id -> same fraction
        assert!((fraction_from_id("test-id-123") - f).abs() < f64::EPSILON);
    }

    #[test]
    fn test_recurring_jitter_forward() {
        let parsed = parse_cron_expression("0 9 * * *").unwrap();
        let ideal = 1000000; // some epoch ms
        let config = JitterConfig::default();

        let jittered = jittered_next_cron_run_ms("a1b2c3d4", "0 9 * * *", &parsed, ideal, &config);
        // Should be >= ideal (forward shift)
        assert!(jittered >= ideal);
        // Should not be beyond cap (15 min = 900000 ms)
        assert!(jittered - ideal <= config.recurring_max_ms);
    }

    #[test]
    fn test_one_shot_jitter_on_00() {
        let config = JitterConfig::default();
        // Use a realistic epoch time at an hour boundary
        let ideal = 1705305600000u64; // 2024-01-15 00:00:00 UTC

        let jittered = one_shot_jittered_next_cron_run_ms("a1b2c3d4", ideal, None, &config);
        // Should be <= ideal (pull-forward)
        assert!(jittered <= ideal, "jittered {} should be <= ideal {}", jittered, ideal);
        // Should not be more than oneShotMaxMs earlier
        assert!(ideal - jittered <= config.one_shot_max_ms,
            "jittered {} too far from ideal {}", jittered, ideal);
    }

    #[test]
    fn test_one_shot_skips_non_boundary() {
        let config = JitterConfig::default();
        // A non-round minute like :07 should not be jittered
        let ideal = 1705305600000u64 + 7 * MS_PER_MINUTE; // 2024-01-15 00:07:00

        let jittered = one_shot_jittered_next_cron_run_ms("a1b2c3d4", ideal, None, &config);
        assert_eq!(jittered, ideal); // unchanged
    }

    #[test]
    fn test_jitter_deterministic() {
        let parsed = parse_cron_expression("*/5 * * * *").unwrap();
        let config = JitterConfig::default();

        let r1 = jittered_next_cron_run_ms("fixe8hex", "*/5 * * * *", &parsed, 1000000, &config);
        let r2 = jittered_next_cron_run_ms("fixe8hex", "*/5 * * * *", &parsed, 1000000, &config);
        assert_eq!(r1, r2);
    }
}

/// The static `jitter_disabled` check used by scheduler tests.
pub fn is_jitter_disabled() -> bool {
    jitter_disabled()
}