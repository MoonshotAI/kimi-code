/// Token usage wire shape and aggregations.
///
/// Corresponds to `kosong/contract/usage.ts`.
use serde::{Deserialize, Serialize};

/// Token usage breakdown for a single LLM generation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
pub struct TokenUsage {
    pub input_other: u32,
    pub output: u32,
    #[serde(default)]
    pub input_cache_read: u32,
    #[serde(default)]
    pub input_cache_creation: u32,
    /// Reasoning/output tokens (Anthropic, etc.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_output: Option<u32>,
}

impl TokenUsage {
    pub fn input_total(&self) -> u32 {
        self.input_other + self.input_cache_read + self.input_cache_creation
    }

    pub fn grand_total(&self) -> u32 {
        self.input_total() + self.output
    }

    pub fn empty() -> Self {
        Self::default()
    }
}

impl std::ops::Add for TokenUsage {
    type Output = Self;

    fn add(self, rhs: Self) -> Self {
        Self {
            input_other: self.input_other + rhs.input_other,
            output: self.output + rhs.output,
            input_cache_read: self.input_cache_read + rhs.input_cache_read,
            input_cache_creation: self.input_cache_creation + rhs.input_cache_creation,
            reasoning_output: match (self.reasoning_output, rhs.reasoning_output) {
                (Some(a), Some(b)) => Some(a + b),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_usage() {
        let u = TokenUsage::empty();
        assert_eq!(u.input_total(), 0);
        assert_eq!(u.grand_total(), 0);
    }

    #[test]
    fn test_input_total() {
        let u = TokenUsage {
            input_other: 100,
            input_cache_read: 20,
            input_cache_creation: 10,
            output: 50,
            reasoning_output: None,
        };
        assert_eq!(u.input_total(), 130);
        assert_eq!(u.grand_total(), 180);
    }

    #[test]
    fn test_add_usage() {
        let a = TokenUsage {
            input_other: 100,
            output: 50,
            ..TokenUsage::empty()
        };
        let b = TokenUsage {
            input_other: 200,
            output: 30,
            ..TokenUsage::empty()
        };
        let c = a + b;
        assert_eq!(c.input_other, 300);
        assert_eq!(c.output, 80);
    }
}