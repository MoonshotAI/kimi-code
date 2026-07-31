/// Retry logic for LLM calls and tool executions.
///
/// Corresponds to `packages/agent-core/src/loop/retry.ts`.
///
/// Layered backoff strategy:
/// - Rate limit errors (429): 15s base, 60s max
/// - Overload errors (503): 5s base, 30s max
/// - Transient errors (timeout, connection): 500ms base, 32s max
/// - Default: 1s base, 30s max

use std::time::Duration;

/// Configuration for retry behavior.
#[derive(Debug, Clone)]
pub struct RetryConfig {
    /// Maximum number of retry attempts.
    pub max_attempts: u32,
    /// Base delay for exponential backoff (in milliseconds).
    pub base_delay_ms: u64,
    /// Maximum delay (in milliseconds).
    pub max_delay_ms: u64,
}

/// Error classification for layered backoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// Rate limit (HTTP 429, provider rate limit).
    RateLimit,
    /// Overload (HTTP 503, server overloaded).
    Overload,
    /// Transient (timeout, connection error, etc.).
    Transient,
    /// Default (other retryable errors).
    Default,
}

impl Default for RetryConfig {
    fn default() -> Self {
        // TS defaults (agent-core/src/loop/retry.ts): 10 attempts (9 retries),
        // 500ms base, 32s cap — the transient/default tier.
        Self {
            max_attempts: 10,
            base_delay_ms: 500,
            max_delay_ms: 32000,
        }
    }
}

/// Get retry config per error class.
///
/// The attempt budget is shared across classes (TS `DEFAULT_MAX_RETRY_ATTEMPTS`);
/// only the delay tier varies. Rate-limit (429) waits longest because TPM
/// windows refresh per minute; overload (503) is moderate; transient errors
/// use the default ramp.
pub fn retry_config_for(error_class: ErrorClass) -> RetryConfig {
    match error_class {
        ErrorClass::RateLimit => RetryConfig {
            max_attempts: 10,
            base_delay_ms: 15000,
            max_delay_ms: 60000,
        },
        ErrorClass::Overload => RetryConfig {
            max_attempts: 10,
            base_delay_ms: 5000,
            max_delay_ms: 30000,
        },
        ErrorClass::Transient => RetryConfig::default(),
        ErrorClass::Default => RetryConfig::default(),
    }
}

/// Classify an error string.
pub fn classify_error(error: &str) -> ErrorClass {
    let lower = error.to_lowercase();
    if lower.contains("rate limit") || lower.contains("429") || lower.contains("too many requests") {
        ErrorClass::RateLimit
    } else if lower.contains("overload") || lower.contains("503") || lower.contains("service unavailable") {
        ErrorClass::Overload
    } else if lower.contains("timeout") || lower.contains("connection") || lower.contains("eof") || lower.contains("reset") {
        ErrorClass::Transient
    } else {
        ErrorClass::Default
    }
}

/// Calculate the delay for a retry attempt using exponential backoff with jitter.
pub fn retry_delay(attempt: u32, config: &RetryConfig) -> Duration {
    let delay = config.base_delay_ms * 2u64.pow(attempt.saturating_sub(1));
    let delay = delay.min(config.max_delay_ms);
    // Add jitter: ±25%
    let jitter = fastrand::i64(-(delay as i64 / 4)..=(delay as i64 / 4));
    Duration::from_millis((delay as i64 + jitter).max(100) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_retry_config_defaults() {
        let config = RetryConfig::default();
        assert_eq!(config.max_attempts, 10);
        assert_eq!(config.base_delay_ms, 500);
        assert_eq!(config.max_delay_ms, 32000);
    }

    #[test]
    fn test_retry_config_for_rate_limit() {
        let config = retry_config_for(ErrorClass::RateLimit);
        assert_eq!(config.max_attempts, 10);
        assert_eq!(config.base_delay_ms, 15000);
        assert_eq!(config.max_delay_ms, 60000);
    }

    #[test]
    fn test_retry_config_for_overload() {
        let config = retry_config_for(ErrorClass::Overload);
        assert_eq!(config.max_attempts, 10);
        assert_eq!(config.base_delay_ms, 5000);
    }

    #[test]
    fn test_retry_config_for_transient() {
        let config = retry_config_for(ErrorClass::Transient);
        assert_eq!(config.base_delay_ms, 500);
    }

    #[test]
    fn test_classify_rate_limit() {
        assert_eq!(classify_error("rate limit exceeded"), ErrorClass::RateLimit);
        assert_eq!(classify_error("HTTP 429 Too Many Requests"), ErrorClass::RateLimit);
        assert_eq!(classify_error("too many requests"), ErrorClass::RateLimit);
    }

    #[test]
    fn test_classify_overload() {
        assert_eq!(classify_error("server overloaded"), ErrorClass::Overload);
        assert_eq!(classify_error("HTTP 503 Service Unavailable"), ErrorClass::Overload);
    }

    #[test]
    fn test_classify_transient() {
        assert_eq!(classify_error("timeout"), ErrorClass::Transient);
        assert_eq!(classify_error("connection reset"), ErrorClass::Transient);
        assert_eq!(classify_error("eof"), ErrorClass::Transient);
    }

    #[test]
    fn test_classify_default() {
        assert_eq!(classify_error("unknown error"), ErrorClass::Default);
        assert_eq!(classify_error("internal error"), ErrorClass::Default);
    }

    #[test]
    fn test_retry_delay_first_attempt() {
        let config = RetryConfig::default();
        let delay = retry_delay(1, &config);
        let ms = delay.as_millis() as u64;
        assert!(ms >= 100, "delay too small: {ms}");
        assert!(ms <= 1250, "delay too large: {ms}");
    }

    #[test]
    fn test_retry_delay_second_attempt() {
        let config = RetryConfig::default();
        let delay = retry_delay(2, &config);
        let ms = delay.as_millis() as u64;
        assert!(ms >= 100, "delay too small: {ms}");
        assert!(ms <= 2500, "delay too large: {ms}");
    }

    #[test]
    fn test_retry_delay_third_attempt() {
        let config = RetryConfig::default();
        let delay = retry_delay(3, &config);
        let ms = delay.as_millis() as u64;
        assert!(ms >= 100, "delay too small: {ms}");
        assert!(ms <= 5000, "delay too large: {ms}");
    }

    #[test]
    fn test_retry_delay_caps_at_max() {
        let config = RetryConfig {
            max_attempts: 10,
            base_delay_ms: 1000,
            max_delay_ms: 5000,
        };
        let delay = retry_delay(5, &config);
        let ms = delay.as_millis() as u64;
        assert!(ms >= 100, "delay too small: {ms}");
        assert!(ms <= 6250, "delay exceeded max: {ms}");
    }

    #[test]
    fn test_retry_delay_zero_base_delay() {
        let config = RetryConfig {
            max_attempts: 3,
            base_delay_ms: 0,
            max_delay_ms: 1000,
        };
        let delay = retry_delay(1, &config);
        let ms = delay.as_millis() as u64;
        assert_eq!(ms, 100, "should floor at 100ms minimum");
    }

    #[test]
    fn test_retry_delay_high_attempt_respects_max() {
        let config = RetryConfig {
            max_attempts: 20,
            base_delay_ms: 100,
            max_delay_ms: 2000,
        };
        for attempt in 1..=10 {
            let delay = retry_delay(attempt, &config);
            let ms = delay.as_millis() as u64;
            let expected_max = (config.base_delay_ms * 2u64.pow(attempt.saturating_sub(1)))
                .min(config.max_delay_ms) as i64;
            let with_jitter = expected_max + expected_max / 4;
            let cap = with_jitter.max(100) as u64;
            assert!(ms <= cap, "attempt {attempt}: delay {ms} exceeded cap {cap}");
        }
    }

    #[test]
    fn test_retry_delay_jitter_variation() {
        let config = RetryConfig::default();
        let mut delays = std::collections::HashSet::new();
        for _ in 0..50 {
            delays.insert(retry_delay(1, &config));
        }
        assert!(delays.len() >= 2, "jitter should produce varied delays");
    }

    #[test]
    fn test_retry_delay_non_zero() {
        let config = RetryConfig::default();
        for attempt in 1..=10 {
            let delay = retry_delay(attempt, &config);
            assert!(
                delay.as_millis() > 0,
                "attempt {attempt}: delay must be positive"
            );
        }
    }

    #[test]
    fn test_retry_delay_custom_config() {
        let config = RetryConfig {
            max_attempts: 5,
            base_delay_ms: 500,
            max_delay_ms: 10000,
        };
        let delay = retry_delay(3, &config);
        let ms = delay.as_millis() as u64;
        assert!(ms >= 100, "delay too small: {ms}");
        assert!(ms <= 2500, "delay too large: {ms}");
    }

    #[test]
    fn test_retry_delay_attempt_zero() {
        let config = RetryConfig::default();
        let delay = retry_delay(0, &config);
        // attempt 0 → saturating_sub(1) = 0 → 1000 * 1 = 1000, jitter ±250
        let ms = delay.as_millis() as u64;
        assert!(ms >= 100, "delay too small: {ms}");
        assert!(ms <= 1250, "delay too large: {ms}");
    }

    #[test]
    fn test_retry_delay_jitter_lower_bound() {
        let config = RetryConfig {
            max_attempts: 3,
            base_delay_ms: 50,
            max_delay_ms: 1000,
        };
        let delay = retry_delay(1, &config);
        // base=50, jitter ±12 → 38..62, floored to 100
        assert_eq!(delay.as_millis(), 100, "should floor at 100ms minimum");
    }

    #[test]
    fn test_retry_delay_exponential_growth() {
        let config = RetryConfig {
            max_attempts: 10,
            base_delay_ms: 100,
            max_delay_ms: 100000,
        };
        let prev = retry_delay(1, &config).as_millis();
        // Each subsequent attempt should be >= previous (within jitter range)
        for attempt in 2..=5 {
            let curr = retry_delay(attempt, &config).as_millis();
            // The base grows exponentially, jitter is ±25%, so curr should be
            // >= prev * 0.5 (allowing for jitter on both sides)
            assert!(
                (curr as i64) >= (prev as i64 / 2),
                "attempt {attempt}: delay {curr} should not drop too much from {prev}"
            );
        }
    }

    #[test]
    fn test_retry_delay_max_attempt_delays() {
        let config = RetryConfig {
            max_attempts: 3,
            base_delay_ms: 1000,
            max_delay_ms: 30000,
        };
        let delays: Vec<_> = (1..=3).map(|a| retry_delay(a, &config)).collect();
        // Each delay should be distinct (due to jitter or base growth)
        // delay 3 (base 4000) > delay 2 (base 2000) > delay 1 (base 1000) in expectation
        // We can't guarantee strict ordering due to jitter, but we can verify
        // that delay 3's jitter range is above delay 1's jitter range
        let d1 = delays[0].as_millis();
        let d3 = delays[2].as_millis();
        // d3 base = 4000, min with jitter = 3000; d1 base = 1000, max with jitter = 1250
        // So d3 should always be >= d1
        assert!(d3 >= d1, "d3={d3} should be >= d1={d1}");
    }

    #[test]
    fn test_retry_delay_consistent_type() {
        let config = RetryConfig::default();
        for attempt in 1..=5 {
            let delay = retry_delay(attempt, &config);
            // Duration should be a valid finite value
            assert!(
                delay.as_nanos() > 0,
                "attempt {attempt}: delay should be positive"
            );
        }
    }
}