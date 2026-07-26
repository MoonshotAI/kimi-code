/// ContextSize — tracks the current context token count.
///
/// Corresponds to `packages/agent-core-v2/src/agent/contextSize/`.
///
/// Provides a simple interface for querying the estimated token count
/// of the current context (system prompt + messages + tools).

use std::sync::atomic::{AtomicU64, Ordering};

/// Tracks the estimated token count of the agent's context.
pub struct ContextSize {
    /// Estimated token count of the system prompt.
    system_prompt_tokens: AtomicU64,
    /// Estimated token count of all messages.
    message_tokens: AtomicU64,
    /// Estimated token count of tool definitions.
    tool_tokens: AtomicU64,
}

impl ContextSize {
    /// Create a new ContextSize tracker.
    pub fn new() -> Self {
        Self {
            system_prompt_tokens: AtomicU64::new(0),
            message_tokens: AtomicU64::new(0),
            tool_tokens: AtomicU64::new(0),
        }
    }

    /// Get the total estimated token count.
    pub fn total_tokens(&self) -> u64 {
        self.system_prompt_tokens.load(Ordering::Relaxed)
            + self.message_tokens.load(Ordering::Relaxed)
            + self.tool_tokens.load(Ordering::Relaxed)
    }

    /// Set the system prompt token estimate.
    pub fn set_system_prompt_tokens(&self, tokens: u64) {
        self.system_prompt_tokens.store(tokens, Ordering::Relaxed);
    }

    /// Set the message token estimate.
    pub fn set_message_tokens(&self, tokens: u64) {
        self.message_tokens.store(tokens, Ordering::Relaxed);
    }

    /// Set the tool token estimate.
    pub fn set_tool_tokens(&self, tokens: u64) {
        self.tool_tokens.store(tokens, Ordering::Relaxed);
    }

    /// Add to the message token estimate (e.g., when a new message is appended).
    pub fn add_message_tokens(&self, tokens: u64) {
        self.message_tokens.fetch_add(tokens, Ordering::Relaxed);
    }

    /// Reset all counters.
    pub fn reset(&self) {
        self.system_prompt_tokens.store(0, Ordering::Relaxed);
        self.message_tokens.store(0, Ordering::Relaxed);
        self.tool_tokens.store(0, Ordering::Relaxed);
    }
}

impl Default for ContextSize {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_is_zero() {
        let cs = ContextSize::new();
        assert_eq!(cs.total_tokens(), 0);
    }

    #[test]
    fn test_set_system_prompt() {
        let cs = ContextSize::new();
        cs.set_system_prompt_tokens(100);
        assert_eq!(cs.total_tokens(), 100);
    }

    #[test]
    fn test_set_messages() {
        let cs = ContextSize::new();
        cs.set_message_tokens(500);
        assert_eq!(cs.total_tokens(), 500);
    }

    #[test]
    fn test_add_message_tokens() {
        let cs = ContextSize::new();
        cs.add_message_tokens(100);
        cs.add_message_tokens(50);
        assert_eq!(cs.message_tokens.load(Ordering::Relaxed), 150);
    }

    #[test]
    fn test_total_combines_all() {
        let cs = ContextSize::new();
        cs.set_system_prompt_tokens(50);
        cs.set_message_tokens(200);
        cs.set_tool_tokens(30);
        assert_eq!(cs.total_tokens(), 280);
    }

    #[test]
    fn test_reset() {
        let cs = ContextSize::new();
        cs.set_system_prompt_tokens(100);
        cs.set_message_tokens(200);
        cs.reset();
        assert_eq!(cs.total_tokens(), 0);
    }

    #[test]
    fn test_default_is_zero() {
        let cs = ContextSize::default();
        assert_eq!(cs.total_tokens(), 0);
    }
}