/// FaultInjection — conditionally injects faults for testing.
///
/// Corresponds to `packages/agent-core-v2/src/agent/faultInjection/`.

use std::collections::HashMap;

/// Configuration for a fault injection rule.
#[derive(Debug, Clone)]
pub struct FaultRule {
    /// Probability of failure (0.0 - 1.0).
    pub probability: f64,
    /// Optional delay in milliseconds to inject before the operation.
    pub delay_ms: Option<u64>,
    /// Error message to return on failure.
    pub error_message: Option<String>,
}

/// Fault injection controller — enabled only in test/dev builds.
pub struct FaultInjection {
    rules: HashMap<String, FaultRule>,
    enabled: bool,
}

impl FaultInjection {
    pub fn new() -> Self {
        Self { rules: HashMap::new(), enabled: false }
    }

    pub fn set_enabled(&mut self, enabled: bool) { self.enabled = enabled; }

    pub fn add_rule(&mut self, operation: &str, rule: FaultRule) {
        self.rules.insert(operation.to_string(), rule);
    }

    pub fn should_fail(&self, operation: &str) -> bool {
        if !self.enabled { return false; }
        self.rules.get(operation).map_or(false, |r| {
            if r.probability >= 1.0 { return true; }
            if r.probability <= 0.0 { return false; }
            // Simple deterministic check based on operation name hash
            let hash: u64 = operation.bytes().fold(0u64, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u64));
            (hash % 100) < (r.probability * 100.0) as u64
        })
    }

    pub fn get_delay_ms(&self, operation: &str) -> Option<u64> {
        if !self.enabled { return None; }
        self.rules.get(operation).and_then(|r| r.delay_ms)
    }

    pub fn get_error_message(&self, operation: &str) -> Option<String> {
        if !self.enabled { return None; }
        self.rules.get(operation).and_then(|r| r.error_message.clone())
    }

    pub fn clear(&mut self) { self.rules.clear(); }
}

impl Default for FaultInjection { fn default() -> Self { Self::new() } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_disabled_by_default() {
        let fi = FaultInjection::new();
        assert!(!fi.should_fail("any"));
    }
    #[test]
    fn test_enabled_rule() {
        let mut fi = FaultInjection::new();
        fi.set_enabled(true);
        fi.add_rule("read", FaultRule { probability: 1.0, delay_ms: None, error_message: None });
        assert!(fi.should_fail("read"));
    }
    #[test]
    fn test_delay() {
        let mut fi = FaultInjection::new();
        fi.set_enabled(true);
        fi.add_rule("slow", FaultRule { probability: 1.0, delay_ms: Some(100), error_message: None });
        assert_eq!(fi.get_delay_ms("slow"), Some(100));
    }
    #[test]
    fn test_disabled_returns_no_fault() {
        let mut fi = FaultInjection::new();
        fi.add_rule("read", FaultRule { probability: 1.0, delay_ms: None, error_message: None });
        assert!(!fi.should_fail("read")); // disabled
    }
}