/// Compaction — context compaction strategy and state management.
///
/// Corresponds to `packages/agent-core/src/agent/compaction/`.
///
/// Manages compaction lifecycle (full compaction and micro compaction).
/// The actual LLM-based summarization is delegated through `HostCallbacks`;
/// this module handles the state machine, triggering logic, and strategy.

/// Strategy configuration for compaction.
#[derive(Debug, Clone)]
pub struct CompactionConfig {
    /// Maximum number of compactions per turn.
    pub max_compaction_per_turn: u32,
    /// Maximum overflow compaction attempts before giving up.
    pub max_overflow_compaction_attempts: u32,
    /// Token threshold at which auto-compaction triggers (fraction of max context).
    pub auto_compact_ratio: f64,
    /// Token ratio at which before_step blocks until compaction finishes.
    pub block_ratio: f64,
    /// Reserved context size (tokens) that compaction must always leave free.
    pub reserved_context_size: u32,
    /// Whether to compact early while the provider cache is still cold.
    pub compact_early_while_cache_cold: bool,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            max_compaction_per_turn: 3,
            max_overflow_compaction_attempts: 3,
            auto_compact_ratio: 0.85,
            block_ratio: 0.95,
            reserved_context_size: 4096,
            compact_early_while_cache_cold: false,
        }
    }
}

/// Data passed when beginning a compaction.
#[derive(Debug, Clone)]
pub struct CompactionBeginData {
    pub source: CompactionSource,
    pub instruction: Option<String>,
}

/// Source of a compaction trigger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionSource {
    Auto,
    Manual,
}

/// Result of a completed compaction.
#[derive(Debug, Clone)]
pub struct CompactionResult {
    pub tokens_before: u64,
    pub tokens_after: u64,
    pub compacted_count: u32,
    pub dropped_count: Option<u32>,
}

/// Strategy trait for controlling compaction behavior.
///
/// The host can implement this to customize how compaction decisions are
/// made — for example reducing compact count on overflow, or adjusting
/// the summarization approach based on context.
pub trait CompactionStrategy: Send + Sync {
    /// Given the current token count before compaction, compute how many
    /// messages should be compacted. Returns None to use the default.
    fn compute_compact_count(&self, _before_tokens: u64) -> Option<u32> { None }

    /// After an overflow error, optionally reduce the compaction target.
    fn reduce_compact_on_overflow(&self, _attempt: u32, _current: u32) -> u32 { _current.saturating_sub(1) }
}

/// FullCompaction — manages the full compaction lifecycle.
///
/// Delegates the actual LLM summarization work through the provided
/// `CompactionDelegate` trait, which the host implements.
pub trait CompactionDelegate: Send + Sync {
    /// Begin a compaction round. Returns the compaction result.
    fn compact(
        &self,
        data: &CompactionBeginData,
        signal: &std::sync::atomic::AtomicBool,
    ) -> Result<CompactionResult, String>;
}

/// FullCompaction state machine.
pub struct FullCompaction {
    config: CompactionConfig,
    compacting: bool,
    compaction_count_in_turn: u32,
    consecutive_overflow_compactions: u32,
    last_compacted_token_count: Option<u64>,
    /// Delegate for actual compaction execution.
    delegate: Option<Box<dyn CompactionDelegate>>,
    /// Optional strategy for customizing compaction decisions.
    strategy: Option<Box<dyn CompactionStrategy>>,
}

impl FullCompaction {
    /// Create a new FullCompaction.
    pub fn new(config: CompactionConfig) -> Self {
        Self {
            config,
            compacting: false,
            compaction_count_in_turn: 0,
            consecutive_overflow_compactions: 0,
            last_compacted_token_count: None,
            delegate: None,
            strategy: None,
        }
    }

    /// Set the compaction delegate.
    pub fn set_delegate(&mut self, delegate: Box<dyn CompactionDelegate>) {
        self.delegate = Some(delegate);
    }

    /// Set the compaction strategy.
    pub fn set_strategy(&mut self, strategy: Box<dyn CompactionStrategy>) {
        self.strategy = Some(strategy);
    }

    /// Whether a compaction is currently in progress.
    pub fn is_compacting(&self) -> bool {
        self.compacting
    }

    /// Begin compaction.
    pub fn begin(&mut self, data: &CompactionBeginData) -> Result<(), String> {
        if self.compacting {
            return Ok(());
        }

        if matches!(data.source, CompactionSource::Manual) {
            self.compaction_count_in_turn = 0;
        } else {
            self.compaction_count_in_turn += 1;
        }

        if self.compaction_count_in_turn > self.config.max_compaction_per_turn {
            return Err("Compaction limit exceeded".to_string());
        }

        self.compacting = true;

        let delegate = self.delegate.as_ref().ok_or("No compaction delegate set")?;
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let result = delegate.compact(data, &cancelled)?;

        self.last_compacted_token_count = Some(result.tokens_after);
        self.compacting = false;

        Ok(())
    }

    /// Cancel the current compaction.
    pub fn cancel(&mut self) {
        self.compacting = false;
    }

    /// Reset per-turn counters.
    pub fn reset_for_turn(&mut self) {
        self.compaction_count_in_turn = 0;
        self.last_compacted_token_count = None;
        self.consecutive_overflow_compactions = 0;
    }

    /// Check whether auto-compaction should trigger based on token count.
    pub fn should_compact(&self, token_count: u64, max_context_tokens: u64) -> bool {
        if self.compacting {
            return false;
        }
        if max_context_tokens == 0 {
            return false;
        }

        if let Some(last) = self.last_compacted_token_count {
            if token_count <= last {
                return false;
            }
        }

        let effective_max = self.effective_max_context(max_context_tokens);
        if effective_max == 0 {
            return false;
        }
        let trigger_at = (effective_max as f64 * self.config.auto_compact_ratio) as u64;
        token_count >= trigger_at
    }

    /// Check whether to compact early while the provider cache is still cold.
    /// This is useful when the first few LLM calls are cheap and compaction
    /// can happen before the cache fills up.
    pub fn should_compact_early_while_cache_cold(&self, token_count: u64, max_context_tokens: u64) -> bool {
        if !self.config.compact_early_while_cache_cold {
            return false;
        }
        if self.compacting || self.compaction_count_in_turn > 0 {
            return false;
        }
        // Compact early at a lower threshold (60% of effective max).
        let effective_max = self.effective_max_context(max_context_tokens);
        if effective_max == 0 {
            return false;
        }
        let early_trigger = (effective_max as f64 * 0.60) as u64;
        token_count >= early_trigger
    }

    /// Check whether the step loop should block waiting for compaction.
    pub fn should_block(&self, token_count: u64, max_context_tokens: u64) -> bool {
        if !self.compacting {
            return false;
        }
        if max_context_tokens == 0 {
            return false;
        }
        let effective_max = self.effective_max_context(max_context_tokens);
        let block_at = (effective_max as f64 * self.config.block_ratio) as u64;
        token_count >= block_at
    }

    /// Handle a context overflow error.
    pub fn handle_overflow_error(&mut self, _token_count: u64) -> Result<(), String> {
        self.consecutive_overflow_compactions += 1;
        if self.consecutive_overflow_compactions > self.config.max_overflow_compaction_attempts {
            return Err("Compaction failed to bring the context under the model window".to_string());
        }
        // Delegate will handle actual compaction on next begin() call.
        Ok(())
    }

    /// Effective max context tokens considering the reserved size.
    fn effective_max_context(&self, max_context_tokens: u64) -> u64 {
        max_context_tokens.saturating_sub(self.config.reserved_context_size as u64)
    }

    /// Run a complete compaction round from check to completion.
    ///
    /// 1. Check whether compaction should trigger (via `should_compact()`).
    /// 2. If triggered, call the delegate to execute compaction.
    /// 3. Handle overflow errors with retry if needed.
    /// 4. Return the result or an error if compaction failed.
    ///
    /// This is the main entry point for the turn loop to call.
    pub fn compaction_round(
        &mut self,
        token_count: u64,
        max_context_tokens: u64,
        source: CompactionSource,
        instruction: Option<String>,
    ) -> Result<Option<CompactionResult>, String> {
        // Skip if already compacting or not needed.
        if self.compacting {
            return Ok(None);
        }

        let should_run = match source {
            CompactionSource::Manual => true,
            CompactionSource::Auto => {
                if self.should_compact_early_while_cache_cold(token_count, max_context_tokens) {
                    true
                } else if self.should_compact(token_count, max_context_tokens) {
                    true
                } else {
                    return Ok(None);
                }
            }
        };

        if !should_run {
            return Ok(None);
        }

        // Apply strategy to determine compact count.
        let target_count = self
            .strategy
            .as_ref()
            .and_then(|s| s.compute_compact_count(token_count));

        let data = CompactionBeginData {
            source,
            instruction,
        };

        // Attempt compaction with overflow retry.
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            if let Err(e) = self.begin(&data) {
                // Check if this is an overflow that can be retried.
                if e.contains("overflow") || e.contains("limit") {
                    self.consecutive_overflow_compactions += 1;
                    if self.consecutive_overflow_compactions > self.config.max_overflow_compaction_attempts {
                        return Err("Compaction failed to bring the context under the model window".to_string());
                    }
                    // Reduce target for next attempt via strategy.
                    if let Some(ref strategy) = self.strategy {
                        let reduced = strategy.reduce_compact_on_overflow(attempt, target_count.unwrap_or(1));
                        if reduced == 0 {
                            return Err(format!("Compaction overflow retry exhausted after {} attempts", attempt));
                        }
                    }
                    continue;
                }
                return Err(e);
            }
            break;
        }

        // Build the result from internal state.
        Ok(Some(CompactionResult {
            tokens_before: token_count,
            tokens_after: self.last_compacted_token_count.unwrap_or(token_count),
            compacted_count: self.compaction_count_in_turn,
            dropped_count: None,
        }))
    }
}

// ── CompactionHandoffInfo ────────────────────────────────────────────────────

/// Information about a compaction handoff event, for integration with the
/// handoff mechanism in `kimi-native-tools`.
#[derive(Debug, Clone)]
pub struct CompactionHandoffInfo {
    /// Token count before compaction.
    pub tokens_before: u64,
    /// Token count after compaction.
    pub tokens_after: u64,
    /// Number of messages compacted.
    pub compacted_count: u32,
    /// Whether the compaction was triggered automatically.
    pub is_auto: bool,
}

impl From<&CompactionResult> for CompactionHandoffInfo {
    fn from(result: &CompactionResult) -> Self {
        Self {
            tokens_before: result.tokens_before,
            tokens_after: result.tokens_after,
            compacted_count: result.compacted_count,
            is_auto: true,
        }
    }
}

// ── MicroCompaction ───────────────────────────────────────────────────────

/// MicroCompaction — detects when a micro-compaction is needed.
///
/// Micro-compaction is a lightweight compaction that removes only the
/// most recent tool results, without running an LLM summarizer.
pub struct MicroCompaction {
    /// Token threshold for triggering micro-compaction.
    threshold: u64,
}

impl MicroCompaction {
    /// Create a new MicroCompaction.
    pub fn new(threshold: u64) -> Self {
        Self { threshold }
    }

    /// Detect whether micro-compaction should run.
    pub fn detect(&self, token_count: u64, max_context_tokens: u64) -> bool {
        if max_context_tokens == 0 {
            return false;
        }
        token_count > max_context_tokens.saturating_sub(self.threshold)
    }
}

impl Default for MicroCompaction {
    fn default() -> Self {
        Self::new(4096)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_full_compaction_new() {
        let fc = FullCompaction::new(CompactionConfig::default());
        assert!(!fc.is_compacting());
    }

    #[test]
    fn test_full_compaction_begin_without_delegate_fails() {
        let mut fc = FullCompaction::new(CompactionConfig::default());
        let data = CompactionBeginData {
            source: CompactionSource::Auto,
            instruction: None,
        };
        let result = fc.begin(&data);
        assert!(result.is_err());
    }

    #[test]
    fn test_reset_for_turn() {
        let mut fc = FullCompaction::new(CompactionConfig::default());
        fc.compaction_count_in_turn = 5;
        fc.last_compacted_token_count = Some(1000);
        fc.reset_for_turn();
        assert_eq!(fc.compaction_count_in_turn, 0);
        assert!(fc.last_compacted_token_count.is_none());
    }

    #[test]
    fn test_should_compact_below_threshold() {
        let fc = FullCompaction::new(CompactionConfig::default());
        // 100_000 effective max, 0.85 ratio = 85_000 trigger. 800 < 85_000 → no.
        assert!(!fc.should_compact(800, 100_000));
    }

    #[test]
    fn test_should_compact_above_threshold() {
        let fc = FullCompaction::new(CompactionConfig::default());
        // 100_000 effective max, 0.85 ratio = 85_000 trigger. 90_000 >= 85_000 → yes.
        assert!(fc.should_compact(90_000, 100_000));
    }

    #[test]
    fn test_should_compact_no_max_context() {
        let fc = FullCompaction::new(CompactionConfig::default());
        assert!(!fc.should_compact(900, 0));
    }

    #[test]
    fn test_should_compact_already_compacting() {
        let mut fc = FullCompaction::new(CompactionConfig::default());
        fc.compacting = true;
        assert!(!fc.should_compact(900, 1000));
    }

    #[test]
    fn test_should_compact_same_token_count() {
        let mut fc = FullCompaction::new(CompactionConfig::default());
        fc.last_compacted_token_count = Some(900);
        assert!(!fc.should_compact(800, 1000));
    }

    #[test]
    fn test_should_block_during_compaction() {
        let mut fc = FullCompaction::new(CompactionConfig::default());
        fc.compacting = true;
        // At 95% block ratio, 1000 * 0.95 = 950. Token count 980 >= 950 → yes.
        assert!(fc.should_block(980, 1000));
    }

    #[test]
    fn test_should_block_when_not_compacting() {
        let fc = FullCompaction::new(CompactionConfig::default());
        assert!(!fc.should_block(980, 1000));
    }

    #[test]
    fn test_effective_max_context() {
        let fc = FullCompaction::new(CompactionConfig {
            reserved_context_size: 4096,
            ..Default::default()
        });
        assert_eq!(fc.effective_max_context(100_000), 95_904);
    }

    #[test]
    fn test_overflow_exceeds_limit() {
        let mut fc = FullCompaction::new(CompactionConfig {
            max_overflow_compaction_attempts: 2,
            ..Default::default()
        });
        assert!(fc.handle_overflow_error(1000).is_ok());
        assert!(fc.handle_overflow_error(1000).is_ok());
        assert!(fc.handle_overflow_error(1000).is_err());
    }

    #[test]
    fn test_cancel_clears_compacting() {
        let mut fc = FullCompaction::new(CompactionConfig::default());
        fc.compacting = true;
        fc.cancel();
        assert!(!fc.is_compacting());
    }

    #[test]
    fn test_micro_compaction_detects_above_threshold() {
        let mc = MicroCompaction::new(4096);
        // 100_000 - 4096 = 95904. Token count 96000 > 95904 → yes.
        assert!(mc.detect(96000, 100_000));
    }

    #[test]
    fn test_micro_compaction_below_threshold() {
        let mc = MicroCompaction::new(4096);
        assert!(!mc.detect(90000, 100_000));
    }

    #[test]
    fn test_micro_compaction_no_max_context() {
        let mc = MicroCompaction::new(4096);
        assert!(!mc.detect(90000, 0));
    }

    #[test]
    fn test_default_config_sensible() {
        let config = CompactionConfig::default();
        assert_eq!(config.max_compaction_per_turn, 3);
        assert!(config.auto_compact_ratio > 0.0);
        assert!(config.block_ratio > config.auto_compact_ratio);
    }

    #[test]
    fn test_compaction_round_skips_when_not_needed() {
        let mut fc = FullCompaction::new(CompactionConfig::default());
        let result = fc.compaction_round(800, 100_000, CompactionSource::Auto, None).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_compaction_round_manual_triggers() {
        let mut fc = FullCompaction::new(CompactionConfig::default());
        struct MockDelegate;
        impl CompactionDelegate for MockDelegate {
            fn compact(&self, _data: &CompactionBeginData, _signal: &std::sync::atomic::AtomicBool) -> Result<CompactionResult, String> {
                Ok(CompactionResult {
                    tokens_before: 90_000,
                    tokens_after: 30_000,
                    compacted_count: 5,
                    dropped_count: None,
                })
            }
        }
        fc.set_delegate(Box::new(MockDelegate));
        let result = fc.compaction_round(90_000, 100_000, CompactionSource::Manual, None).unwrap();
        assert!(result.is_some());
        let r = result.unwrap();
        assert!(r.tokens_after < r.tokens_before);
    }

    #[test]
    fn test_compaction_round_auto_triggers_at_threshold() {
        let mut fc = FullCompaction::new(CompactionConfig::default());
        struct MockDelegate;
        impl CompactionDelegate for MockDelegate {
            fn compact(&self, _data: &CompactionBeginData, _signal: &std::sync::atomic::AtomicBool) -> Result<CompactionResult, String> {
                Ok(CompactionResult {
                    tokens_before: 90_000,
                    tokens_after: 30_000,
                    compacted_count: 5,
                    dropped_count: None,
                })
            }
        }
        fc.set_delegate(Box::new(MockDelegate));
        // 90_000 >= 85_000 (85% of 100_000 - 4096) → should trigger
        let result = fc.compaction_round(90_000, 100_000, CompactionSource::Auto, None).unwrap();
        assert!(result.is_some());
    }

    #[test]
    fn test_compaction_round_no_delegate() {
        let mut fc = FullCompaction::new(CompactionConfig::default());
        let result = fc.compaction_round(90_000, 100_000, CompactionSource::Manual, None);
        assert!(result.is_err());
    }

    #[test]
    fn test_compaction_handoff_info_from_result() {
        let result = CompactionResult {
            tokens_before: 100_000,
            tokens_after: 40_000,
            compacted_count: 10,
            dropped_count: Some(2),
        };
        let info = CompactionHandoffInfo::from(&result);
        assert_eq!(info.tokens_before, 100_000);
        assert_eq!(info.tokens_after, 40_000);
        assert_eq!(info.compacted_count, 10);
        assert!(info.is_auto);
    }

    #[test]
    fn test_compaction_round_strategy_override() {
        let mut fc = FullCompaction::new(CompactionConfig::default());
        struct MockDelegate;
        impl CompactionDelegate for MockDelegate {
            fn compact(&self, _data: &CompactionBeginData, _signal: &std::sync::atomic::AtomicBool) -> Result<CompactionResult, String> {
                Ok(CompactionResult {
                    tokens_before: 90_000,
                    tokens_after: 30_000,
                    compacted_count: 5,
                    dropped_count: None,
                })
            }
        }
        fc.set_delegate(Box::new(MockDelegate));

        struct TestStrategy;
        impl CompactionStrategy for TestStrategy {
            fn compute_compact_count(&self, _before_tokens: u64) -> Option<u32> {
                Some(10) // compact 10 messages
            }
        }
        fc.set_strategy(Box::new(TestStrategy));

        let result = fc.compaction_round(90_000, 100_000, CompactionSource::Manual, None).unwrap();
        assert!(result.is_some());
    }
}