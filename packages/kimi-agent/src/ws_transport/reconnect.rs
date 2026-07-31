/// Reconnection policy and state management for WS transport.
///
/// Implements exponential backoff with jitter to avoid thundering herd
/// problems when the server restarts.

use std::time::Duration;

/// Reconnection configuration.
#[derive(Debug, Clone)]
pub struct ReconnectConfig {
    /// Initial backoff duration after the first disconnect.
    pub initial_backoff: Duration,
    /// Maximum backoff duration (cap for exponential growth).
    pub max_backoff: Duration,
    /// Multiplier for exponential backoff.
    pub backoff_multiplier: f64,
    /// Maximum number of reconnection attempts. `None` means unlimited.
    pub max_attempts: Option<u32>,
    /// Whether to add jitter to backoff durations.
    pub jitter: bool,
}

impl ReconnectConfig {
    /// Create a default reconnect config (5s initial, 60s max, 1h total).
    pub fn default() -> Self {
        Self {
            initial_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(60),
            backoff_multiplier: 2.0,
            max_attempts: None,
            jitter: true,
        }
    }

    /// Create an aggressive reconnect config (faster retries).
    pub fn aggressive() -> Self {
        Self {
            initial_backoff: Duration::from_millis(500),
            max_backoff: Duration::from_secs(10),
            backoff_multiplier: 1.5,
            max_attempts: Some(20),
            jitter: true,
        }
    }

    /// Create a conservative reconnect config (slower retries, longer total).
    pub fn conservative() -> Self {
        Self {
            initial_backoff: Duration::from_secs(5),
            max_backoff: Duration::from_secs(300),
            backoff_multiplier: 2.0,
            max_attempts: Some(10),
            jitter: true,
        }
    }
}

/// Reconnection policy that tracks retry state.
#[derive(Debug)]
pub struct ReconnectPolicy {
    config: ReconnectConfig,
    attempt: u32,
}

impl ReconnectPolicy {
    /// Create a new reconnect policy with the given config.
    pub fn new(config: ReconnectConfig) -> Self {
        Self {
            config,
            attempt: 0,
        }
    }

    /// Record a successful connection (resets the attempt counter).
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    /// Check if another reconnection attempt is allowed.
    pub fn can_retry(&self) -> bool {
        match self.config.max_attempts {
            Some(max) => self.attempt < max,
            None => true,
        }
    }

    /// Get the next backoff duration and increment the attempt counter.
    ///
    /// Returns `None` if no more retries are allowed.
    pub fn next_backoff(&mut self) -> Option<Duration> {
        if !self.can_retry() {
            return None;
        }

        let base = self.config.initial_backoff.as_secs_f64()
            * self.config.backoff_multiplier.powi(self.attempt as i32);

        let capped = base.min(self.config.max_backoff.as_secs_f64());
        let result = if self.config.jitter {
            // Add ±25% jitter.
            let jitter_range = capped * 0.25;
            let jitter = if cfg!(test) {
                // Deterministic jitter for tests.
                jitter_range * 0.5
            } else {
                fastrand::f64() * jitter_range * 2.0 - jitter_range
            };
            (capped + jitter).max(0.0)
        } else {
            capped
        };

        self.attempt += 1;
        Some(Duration::from_secs_f64(result))
    }

    /// Get the current attempt number.
    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    /// Get the config.
    pub fn config(&self) -> &ReconnectConfig {
        &self.config
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reconnect_policy_can_retry_unlimited() {
        let config = ReconnectConfig::default();
        let mut policy = ReconnectPolicy::new(config);

        for _ in 0..100 {
            assert!(policy.can_retry());
            policy.next_backoff();
        }
        assert!(policy.can_retry());
    }

    #[test]
    fn test_reconnect_policy_max_attempts() {
        let config = ReconnectConfig {
            initial_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(10),
            backoff_multiplier: 2.0,
            max_attempts: Some(5),
            jitter: false,
        };
        let mut policy = ReconnectPolicy::new(config);

        for _ in 0..5 {
            assert!(policy.can_retry());
            policy.next_backoff();
        }
        assert!(!policy.can_retry());
        assert!(policy.next_backoff().is_none());
    }

    #[test]
    fn test_exponential_backoff() {
        let config = ReconnectConfig {
            initial_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(60),
            backoff_multiplier: 2.0,
            max_attempts: Some(10),
            jitter: false,
        };
        let mut policy = ReconnectPolicy::new(config);

        let b1 = policy.next_backoff().unwrap();
        let b2 = policy.next_backoff().unwrap();
        let b3 = policy.next_backoff().unwrap();

        assert_eq!(b1, Duration::from_secs(1));
        assert_eq!(b2, Duration::from_secs(2));
        assert_eq!(b3, Duration::from_secs(4));
    }

    #[test]
    fn test_backoff_cap() {
        let config = ReconnectConfig {
            initial_backoff: Duration::from_secs(10),
            max_backoff: Duration::from_secs(30),
            backoff_multiplier: 2.0,
            max_attempts: Some(10),
            jitter: false,
        };
        let mut policy = ReconnectPolicy::new(config);

        let _ = policy.next_backoff(); // 10s
        let b2 = policy.next_backoff().unwrap(); // 20s
        let b3 = policy.next_backoff().unwrap(); // should be capped at 30s

        assert_eq!(b2, Duration::from_secs(20));
        assert_eq!(b3, Duration::from_secs(30));
    }

    #[test]
    fn test_reset() {
        let config = ReconnectConfig {
            initial_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(60),
            backoff_multiplier: 2.0,
            max_attempts: Some(5),
            jitter: false,
        };
        let mut policy = ReconnectPolicy::new(config);

        let _ = policy.next_backoff();
        let _ = policy.next_backoff();
        assert_eq!(policy.attempt(), 2);

        policy.reset();
        assert_eq!(policy.attempt(), 0);
        assert!(policy.can_retry());
    }
}
