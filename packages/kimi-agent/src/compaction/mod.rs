/// Compaction — the full-compaction lifecycle.
///
/// Corresponds to `packages/agent-core-v2/src/agent/fullCompaction/`.
///
/// This module owns the *state machine*: when a compaction may start, how many
/// messages it targets, how an overflowing summarizer request is retried, and
/// what the result reads as. The summarization itself — building the request,
/// calling the model, writing the rewritten history — is delegated to the host
/// through [`CompactionDelegate`], because none of it is decidable here.
///
/// The decision logic lives in [`strategy`]; the summarizer-input shaping in
/// [`utils`]; the replayable phase in [`ops`].
pub mod ops;
pub mod strategy;
pub mod utils;

pub use ops::{
    apply_begin, apply_cancel, apply_complete, begin_event, normalise_restored_phase,
    CompactionBeginData, CompactionEvent, CompactionPhase,
};
pub use strategy::{
    can_split_after, CompactionSource, CompactionStrategyConfig, DefaultCompactionStrategy,
    ProfileModelContext, RuntimeCompactionStrategy,
};
pub use utils::{
    collect_summary, drop_leading_tool_results, drop_oldest_message_and_leading_tool_results,
    history_safe_to_compact, shrink_compaction_history_after_overflow, CompactionAttemptError,
    COMPACTION_OVERFLOW_SHRINK_RATIOS,
};

use crate::context::types::ContextMessage;

/// Share of the window at which a cache-cold early compaction may fire.
const EARLY_CACHE_COLD_RATIO: f64 = 0.60;

/// Lifecycle knobs, distinct from the algorithm knobs in
/// [`CompactionStrategyConfig`].
///
/// The ratios and the reserved slice belong to the strategy because a model
/// profile can override them; these govern the retry loop and are fixed.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionConfig {
    /// `None` is TS's `Infinity` — no per-turn cap.
    pub max_compaction_per_turn: Option<u32>,
    pub max_overflow_compaction_attempts: u32,
    /// Compact ahead of the trigger while the provider cache is still cold.
    /// Not present in TS; opt-in and off by default.
    pub compact_early_while_cache_cold: bool,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        let strategy = CompactionStrategyConfig::default();
        Self {
            max_compaction_per_turn: strategy.max_compaction_per_turn,
            max_overflow_compaction_attempts: strategy.max_overflow_compaction_attempts,
            compact_early_while_cache_cold: false,
        }
    }
}

/// What the host is being asked to summarise.
pub struct CompactionRequest<'a> {
    pub source: CompactionSource,
    pub instruction: Option<String>,
    /// How many messages from the head to summarise.
    pub compacted_count: usize,
    /// The history the count refers to.
    pub messages: &'a [ContextMessage],
    /// 1-based; greater than 1 means a previous attempt overflowed.
    pub attempt: u32,
}

/// Outcome of a completed compaction. Mirrors the TS `CompactionResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionResult {
    pub summary: String,
    pub context_summary: Option<String>,
    pub compacted_count: usize,
    pub tokens_before: u64,
    pub tokens_after: u64,
    pub kept_user_message_count: Option<usize>,
    pub kept_head_user_message_count: Option<usize>,
    pub dropped_count: Option<u32>,
}

/// Why a compaction round did not produce a result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompactionError {
    /// The per-turn cap was already spent.
    TurnLimitExceeded,
    /// The retry budget ran out without the request fitting the window.
    OverflowUnrecoverable { attempts: u32 },
    /// Nothing could be safely summarised.
    NothingToCompact,
    NoDelegate,
    /// The host reported a failure.
    Delegate(String),
}

impl std::fmt::Display for CompactionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CompactionError::TurnLimitExceeded => f.write_str("Compaction limit exceeded"),
            CompactionError::OverflowUnrecoverable { attempts } => write!(
                f,
                "Compaction failed to bring the context under the model window after {attempts} attempt(s)"
            ),
            CompactionError::NothingToCompact => {
                f.write_str("No safe compaction split point in the current history")
            }
            CompactionError::NoDelegate => f.write_str("No compaction delegate set"),
            CompactionError::Delegate(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for CompactionError {}

/// What the host reports back from one summarization attempt.
pub enum CompactionAttempt {
    Done(CompactionResult),
    /// The request itself exceeded the model window; the round will retry with
    /// a shallower cut.
    Overflowed,
}

pub trait CompactionDelegate: Send + Sync {
    fn compact(&self, request: &CompactionRequest<'_>) -> Result<CompactionAttempt, String>;
}

/// The full-compaction state machine.
pub struct FullCompaction {
    config: CompactionConfig,
    strategy: RuntimeCompactionStrategy,
    phase: CompactionPhase,
    compaction_count_in_turn: u32,
    consecutive_overflow_compactions: u32,
    last_compacted_token_count: Option<u64>,
    delegate: Option<Box<dyn CompactionDelegate>>,
}

impl FullCompaction {
    pub fn new(config: CompactionConfig, model: ProfileModelContext) -> Self {
        Self {
            config,
            strategy: RuntimeCompactionStrategy::new(model),
            phase: CompactionPhase::Idle,
            compaction_count_in_turn: 0,
            consecutive_overflow_compactions: 0,
            last_compacted_token_count: None,
            delegate: None,
        }
    }

    pub fn set_delegate(&mut self, delegate: Box<dyn CompactionDelegate>) {
        self.delegate = Some(delegate);
    }

    pub fn set_model(&mut self, model: ProfileModelContext) {
        self.strategy = RuntimeCompactionStrategy::new(model);
    }

    pub fn strategy(&self) -> &RuntimeCompactionStrategy {
        &self.strategy
    }

    pub fn phase(&self) -> CompactionPhase {
        self.phase
    }

    pub fn is_compacting(&self) -> bool {
        self.phase == CompactionPhase::Running
    }

    /// Whether pressure warrants an automatic compaction now.
    ///
    /// On top of the strategy's predicate this adds two liveness guards: never
    /// stack a second compaction, and never re-run at a token count the last
    /// compaction already failed to get below — otherwise a history that cannot
    /// shrink further would compact on every step forever.
    pub fn should_compact(&self, used_tokens: u64) -> bool {
        if self.is_compacting() {
            return false;
        }
        if self.last_compacted_token_count.is_some_and(|last| used_tokens <= last) {
            return false;
        }
        self.strategy.should_compact(used_tokens)
    }

    /// Whether the step loop must wait for compaction before continuing.
    ///
    /// A pure predicate on pressure, as in TS — the caller decides what to do
    /// about it.
    pub fn should_block(&self, used_tokens: u64) -> bool {
        self.strategy.should_block(used_tokens)
    }

    /// Compact ahead of the trigger while the provider cache is still cold.
    ///
    /// Not a TS behaviour — opt-in and off by default. Compaction invalidates
    /// the provider's prefix cache, so doing it before the cache is warm costs
    /// nothing, whereas the same rewrite later throws away a paid-for prefix.
    /// Only ever fires on the first compaction of a turn.
    pub fn should_compact_early_while_cache_cold(&self, used_tokens: u64) -> bool {
        if !self.config.compact_early_while_cache_cold {
            return false;
        }
        if self.is_compacting() || self.compaction_count_in_turn > 0 {
            return false;
        }
        let max_size = self.strategy.max_size();
        if max_size == 0 {
            return false;
        }
        used_tokens as f64 >= max_size as f64 * EARLY_CACHE_COLD_RATIO
    }

    pub fn reset_for_turn(&mut self) {
        self.compaction_count_in_turn = 0;
        self.consecutive_overflow_compactions = 0;
        self.last_compacted_token_count = None;
    }

    pub fn cancel(&mut self) {
        if let Some(next) = apply_cancel(self.phase) {
            self.phase = next;
        }
    }

    /// Reset a phase stranded by a crash.
    pub fn restore(&mut self, phase: CompactionPhase) {
        self.phase = normalise_restored_phase(phase);
    }

    /// Run one compaction round end to end.
    ///
    /// Returns `Ok(None)` when no compaction was warranted. On overflow the cut
    /// is deepened via [`RuntimeCompactionStrategy::reduce_compact_on_overflow`]
    /// and retried until the attempt budget is spent.
    pub fn compaction_round(
        &mut self,
        messages: &[ContextMessage],
        used_tokens: u64,
        source: CompactionSource,
        instruction: Option<String>,
    ) -> Result<Option<CompactionResult>, CompactionError> {
        if self.is_compacting() {
            return Ok(None);
        }
        if source == CompactionSource::Auto
            && !self.should_compact(used_tokens)
            && !self.should_compact_early_while_cache_cold(used_tokens)
        {
            return Ok(None);
        }

        if source == CompactionSource::Manual {
            self.compaction_count_in_turn = 0;
        } else {
            self.compaction_count_in_turn += 1;
            if self
                .config
                .max_compaction_per_turn
                .is_some_and(|cap| self.compaction_count_in_turn > cap)
            {
                return Err(CompactionError::TurnLimitExceeded);
            }
        }

        let mut compacted_count = self.strategy.compute_compact_count(messages, source);
        if compacted_count == 0 {
            return Err(CompactionError::NothingToCompact);
        }

        if self.delegate.is_none() {
            return Err(CompactionError::NoDelegate);
        }
        self.phase = apply_begin(self.phase).unwrap_or(self.phase);

        let max_attempts = self.config.max_overflow_compaction_attempts;
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            let request = CompactionRequest {
                source,
                instruction: instruction.clone(),
                compacted_count,
                messages,
                attempt,
            };
            let outcome = self
                .delegate
                .as_ref()
                .expect("delegate presence checked above")
                .compact(&request);

            match outcome {
                Ok(CompactionAttempt::Done(result)) => {
                    self.last_compacted_token_count = Some(result.tokens_after);
                    self.consecutive_overflow_compactions = 0;
                    self.phase = apply_complete(self.phase).unwrap_or(self.phase);
                    return Ok(Some(result));
                }
                Ok(CompactionAttempt::Overflowed) => {
                    self.consecutive_overflow_compactions += 1;
                    if attempt >= max_attempts {
                        self.phase = apply_complete(self.phase).unwrap_or(self.phase);
                        return Err(CompactionError::OverflowUnrecoverable { attempts: attempt });
                    }
                    // Shrink the cut so the retry sends a *smaller* request —
                    // `compacted_count` is how much history goes to the
                    // summarizer, so fewer messages is what relieves the
                    // overflow. Previously this value was computed and thrown
                    // away, so every retry re-sent the identical oversized
                    // request and the budget burned for nothing.
                    //
                    // `reduce_compact_on_overflow` is a pure function of the
                    // history, so it can only help once; after that, step down
                    // one safe split at a time to guarantee progress.
                    let reduced = self.strategy.reduce_compact_on_overflow(messages);
                    let next = if reduced < compacted_count {
                        Some(reduced)
                    } else {
                        self.strategy.previous_safe_split(messages, compacted_count)
                    };
                    match next.filter(|n| *n > 0) {
                        Some(next) => compacted_count = next,
                        None => {
                            self.phase = apply_complete(self.phase).unwrap_or(self.phase);
                            return Err(CompactionError::OverflowUnrecoverable {
                                attempts: attempt,
                            });
                        }
                    }
                }
                Err(message) => {
                    self.phase = apply_complete(self.phase).unwrap_or(self.phase);
                    return Err(CompactionError::Delegate(message));
                }
            }
        }
    }
}

// ── CompactionHandoffInfo ──────────────────────────────────────────────────

/// Summary of a compaction for the handoff mechanism.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionHandoffInfo {
    pub tokens_before: u64,
    pub tokens_after: u64,
    pub compacted_count: usize,
    pub is_auto: bool,
}

impl CompactionHandoffInfo {
    pub fn from_result(result: &CompactionResult, source: CompactionSource) -> Self {
        Self {
            tokens_before: result.tokens_before,
            tokens_after: result.tokens_after,
            compacted_count: result.compacted_count,
            is_auto: source == CompactionSource::Auto,
        }
    }
}

// ── MicroCompaction ────────────────────────────────────────────────────────

/// Detects when a lightweight compaction — dropping recent tool results
/// without invoking a summarizer — is warranted.
pub struct MicroCompaction {
    threshold: u64,
}

impl MicroCompaction {
    pub fn new(threshold: u64) -> Self {
        Self { threshold }
    }

    pub fn detect(&self, used_tokens: u64, max_context_tokens: u64) -> bool {
        if max_context_tokens == 0 {
            return false;
        }
        used_tokens > max_context_tokens.saturating_sub(self.threshold)
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
    use crate::context::types::{ContentPart, ToolCall};
    use std::sync::Mutex;

    fn msg(role: &str, text: &str, tool_calls: usize) -> ContextMessage {
        ContextMessage {
            role: role.to_string(),
            content: vec![ContentPart::Text { text: text.to_string() }],
            tool_calls: (0..tool_calls)
                .map(|i| ToolCall {
                    r#type: "function".to_string(),
                    id: format!("c{i}"),
                    name: "read".to_string(),
                    arguments: serde_json::Value::Null,
                    extras: None,
                })
                .collect(),
            ..Default::default()
        }
    }

    fn history() -> Vec<ContextMessage> {
        vec![
            msg("user", "q1", 0),
            msg("assistant", "a1", 0),
            msg("user", "q2", 0),
            msg("assistant", "a2", 0),
            msg("user", "q3", 0),
            msg("assistant", "a3", 0),
        ]
    }

    /// `turns` user/assistant pairs — a safe cut after every assistant.
    fn long_history(turns: usize) -> Vec<ContextMessage> {
        let mut messages = Vec::with_capacity(turns * 2);
        for i in 0..turns {
            messages.push(msg("user", &format!("question number {i}"), 0));
            messages.push(msg("assistant", &format!("answer number {i}"), 0));
        }
        messages
    }

    fn model(max_size: u64) -> ProfileModelContext {
        ProfileModelContext { max_size, ..Default::default() }
    }

    fn result(tokens_after: u64) -> CompactionResult {
        CompactionResult {
            summary: "summary".to_string(),
            context_summary: None,
            compacted_count: 2,
            tokens_before: 1000,
            tokens_after,
            kept_user_message_count: Some(1),
            kept_head_user_message_count: None,
            dropped_count: None,
        }
    }

    /// Records every request and replays a scripted sequence of outcomes.
    struct ScriptedDelegate {
        outcomes: Mutex<Vec<Result<CompactionAttempt, String>>>,
        seen_counts: Mutex<Vec<usize>>,
    }

    impl ScriptedDelegate {
        fn new(outcomes: Vec<Result<CompactionAttempt, String>>) -> Self {
            Self { outcomes: Mutex::new(outcomes), seen_counts: Mutex::new(Vec::new()) }
        }
    }

    impl CompactionDelegate for ScriptedDelegate {
        fn compact(&self, request: &CompactionRequest<'_>) -> Result<CompactionAttempt, String> {
            self.seen_counts.lock().unwrap().push(request.compacted_count);
            let mut outcomes = self.outcomes.lock().unwrap();
            if outcomes.is_empty() {
                return Err("script exhausted".to_string());
            }
            outcomes.remove(0)
        }
    }

    fn with_delegate(
        max_size: u64,
        outcomes: Vec<Result<CompactionAttempt, String>>,
    ) -> (FullCompaction, std::sync::Arc<ScriptedDelegate>) {
        let delegate = std::sync::Arc::new(ScriptedDelegate::new(outcomes));
        let mut fc = FullCompaction::new(CompactionConfig::default(), model(max_size));
        fc.set_delegate(Box::new(DelegateHandle(delegate.clone())));
        (fc, delegate)
    }

    struct DelegateHandle(std::sync::Arc<ScriptedDelegate>);
    impl CompactionDelegate for DelegateHandle {
        fn compact(&self, request: &CompactionRequest<'_>) -> Result<CompactionAttempt, String> {
            self.0.compact(request)
        }
    }

    // ── construction ──────────────────────────────────────────────────────

    #[test]
    fn a_new_compaction_is_idle() {
        let fc = FullCompaction::new(CompactionConfig::default(), model(100_000));
        assert!(!fc.is_compacting());
        assert_eq!(fc.phase(), CompactionPhase::Idle);
    }

    #[test]
    fn the_lifecycle_defaults_track_the_strategy_defaults() {
        let config = CompactionConfig::default();
        let strategy = CompactionStrategyConfig::default();
        assert_eq!(config.max_compaction_per_turn, strategy.max_compaction_per_turn);
        assert_eq!(
            config.max_overflow_compaction_attempts,
            strategy.max_overflow_compaction_attempts
        );
        assert!(!config.compact_early_while_cache_cold);
    }

    // ── trigger predicates ────────────────────────────────────────────────

    #[test]
    fn pressure_below_the_threshold_does_not_trigger() {
        let fc = FullCompaction::new(CompactionConfig::default(), model(1_000_000));
        assert!(!fc.should_compact(800));
    }

    #[test]
    fn pressure_above_the_threshold_triggers() {
        let fc = FullCompaction::new(CompactionConfig::default(), model(1_000_000));
        assert!(fc.should_compact(900_000));
    }

    #[test]
    fn the_reserved_slice_triggers_earlier_than_the_ratio() {
        // Regression guard: the previous implementation subtracted the reserve
        // from the window and *then* applied the ratio, which fires far too
        // early. TS applies the ratio to the full window and treats the reserve
        // as a separate floor.
        let fc = FullCompaction::new(CompactionConfig::default(), model(100_000));
        assert!(!fc.should_compact(49_999));
        assert!(fc.should_compact(50_000));
    }

    #[test]
    fn a_zero_window_never_triggers() {
        let fc = FullCompaction::new(CompactionConfig::default(), model(0));
        assert!(!fc.should_compact(u64::MAX));
        assert!(!fc.should_block(u64::MAX));
    }

    #[test]
    fn blocking_does_not_require_a_compaction_to_be_running() {
        // TS's shouldBlock is a pure pressure predicate; the previous Rust
        // version returned false unless a compaction was already in flight,
        // which meant the loop never blocked at all.
        let fc = FullCompaction::new(CompactionConfig::default(), model(1_000_000));
        assert!(!fc.is_compacting());
        assert!(fc.should_block(900_000));
    }

    #[test]
    fn a_repeat_at_the_same_token_count_does_not_re_trigger() {
        let (mut fc, _) = with_delegate(100_000, vec![Ok(CompactionAttempt::Done(result(60_000)))]);
        fc.compaction_round(&history(), 90_000, CompactionSource::Auto, None).unwrap();
        assert!(!fc.should_compact(60_000), "already at the post-compaction size");
        assert!(!fc.should_compact(59_000), "and below it");
        assert!(fc.should_compact(70_000), "but growth re-arms the trigger");
    }

    // ── rounds ────────────────────────────────────────────────────────────

    #[test]
    fn an_auto_round_below_threshold_does_nothing() {
        let (mut fc, delegate) = with_delegate(1_000_000, vec![]);
        let outcome = fc.compaction_round(&history(), 100, CompactionSource::Auto, None).unwrap();
        assert!(outcome.is_none());
        assert!(delegate.seen_counts.lock().unwrap().is_empty());
    }

    #[test]
    fn a_manual_round_runs_regardless_of_pressure() {
        let (mut fc, delegate) =
            with_delegate(1_000_000, vec![Ok(CompactionAttempt::Done(result(500)))]);
        let outcome = fc.compaction_round(&history(), 1, CompactionSource::Manual, None).unwrap();
        assert!(outcome.is_some());
        assert_eq!(delegate.seen_counts.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_round_returns_to_idle_on_success() {
        let (mut fc, _) = with_delegate(1_000_000, vec![Ok(CompactionAttempt::Done(result(500)))]);
        fc.compaction_round(&history(), 1, CompactionSource::Manual, None).unwrap();
        assert_eq!(fc.phase(), CompactionPhase::Idle);
    }

    #[test]
    fn a_round_passes_the_computed_cut_to_the_delegate() {
        let (mut fc, delegate) =
            with_delegate(1_000_000, vec![Ok(CompactionAttempt::Done(result(500)))]);
        let messages = history();
        fc.compaction_round(&messages, 1, CompactionSource::Manual, None).unwrap();
        let counts = delegate.seen_counts.lock().unwrap();
        assert_eq!(counts.len(), 1);
        assert!(counts[0] > 0 && counts[0] <= messages.len());
        assert!(can_split_after(&messages, counts[0] - 1), "the cut must be safe");
    }

    #[test]
    fn a_history_with_no_safe_split_reports_nothing_to_compact() {
        let (mut fc, _) = with_delegate(1_000_000, vec![]);
        let messages = vec![msg("user", "q1", 0), msg("user", "q2", 0)];
        assert_eq!(
            fc.compaction_round(&messages, 1, CompactionSource::Manual, None),
            Err(CompactionError::NothingToCompact)
        );
    }

    #[test]
    fn a_round_without_a_delegate_fails_before_starting() {
        let mut fc = FullCompaction::new(CompactionConfig::default(), model(1_000_000));
        assert_eq!(
            fc.compaction_round(&history(), 1, CompactionSource::Manual, None),
            Err(CompactionError::NoDelegate)
        );
        assert_eq!(fc.phase(), CompactionPhase::Idle);
    }

    #[test]
    fn a_delegate_failure_surfaces_and_clears_the_phase() {
        let (mut fc, _) = with_delegate(1_000_000, vec![Err("model unavailable".to_string())]);
        assert_eq!(
            fc.compaction_round(&history(), 1, CompactionSource::Manual, None),
            Err(CompactionError::Delegate("model unavailable".to_string()))
        );
        assert_eq!(fc.phase(), CompactionPhase::Idle);
    }

    // ── overflow retry ────────────────────────────────────────────────────

    #[test]
    fn an_overflow_shrinks_the_cut_and_retries() {
        // Regression guard: the reduced count used to be computed and dropped,
        // so every retry re-sent the identical oversized request. The retry
        // must summarise *less* history, not more — `compacted_count` is the
        // size of the summarizer's input.
        let (mut fc, delegate) = with_delegate(
            1_000_000,
            vec![
                Ok(CompactionAttempt::Overflowed),
                Ok(CompactionAttempt::Done(result(500))),
            ],
        );
        let outcome = fc.compaction_round(&history(), 1, CompactionSource::Manual, None).unwrap();
        assert!(outcome.is_some());
        let counts = delegate.seen_counts.lock().unwrap();
        assert_eq!(counts.len(), 2);
        assert!(counts[1] < counts[0], "the retry must send less: {counts:?}");
    }

    #[test]
    fn repeated_overflows_keep_shrinking() {
        // A window small enough that the reduction threshold (5% of it) is
        // reachable, so the first retry lands mid-history instead of jumping
        // straight to the shallowest cut and leaving nowhere to retreat to.
        let messages = long_history(8);
        let (mut fc, delegate) = with_delegate(
            200,
            vec![
                Ok(CompactionAttempt::Overflowed),
                Ok(CompactionAttempt::Overflowed),
                Ok(CompactionAttempt::Done(result(50))),
            ],
        );
        fc.compaction_round(&messages, 1, CompactionSource::Manual, None).unwrap();
        let counts = delegate.seen_counts.lock().unwrap();
        assert_eq!(counts.len(), 3, "{counts:?}");
        assert!(counts[1] < counts[0] && counts[2] < counts[1], "{counts:?}");
    }

    #[test]
    fn overflow_gives_up_when_no_shallower_split_exists() {
        // One turn: the only safe cut is the whole prefix (cutting after the
        // opening user message would strand it), so there is nowhere left to
        // retreat to and the round must fail rather than spin.
        let messages = vec![msg("user", "q", 0), msg("assistant", "a", 0)];
        let (mut fc, delegate) = with_delegate(
            1_000_000,
            vec![Ok(CompactionAttempt::Overflowed), Ok(CompactionAttempt::Overflowed)],
        );
        let outcome = fc.compaction_round(&messages, 1, CompactionSource::Manual, None);
        assert!(matches!(outcome, Err(CompactionError::OverflowUnrecoverable { .. })));
        assert_eq!(delegate.seen_counts.lock().unwrap().len(), 1, "no pointless retry");
        assert_eq!(fc.phase(), CompactionPhase::Idle);
    }

    #[test]
    fn overflow_gives_up_after_the_attempt_budget() {
        let messages = long_history(8);
        let (mut fc, delegate) = with_delegate(
            200,
            (0..4).map(|_| Ok(CompactionAttempt::Overflowed)).collect(),
        );
        let outcome = fc.compaction_round(&messages, 1, CompactionSource::Manual, None);
        assert!(matches!(outcome, Err(CompactionError::OverflowUnrecoverable { .. })));
        let counts = delegate.seen_counts.lock().unwrap();
        assert!(
            counts.len() <= CompactionConfig::default().max_overflow_compaction_attempts as usize,
            "{counts:?} exceeded the attempt budget"
        );
        assert_eq!(fc.phase(), CompactionPhase::Idle);
    }

    #[test]
    fn every_retry_cut_is_valid_and_strictly_smaller() {
        let messages = long_history(8);
        let (mut fc, delegate) = with_delegate(
            200,
            vec![
                Ok(CompactionAttempt::Overflowed),
                Ok(CompactionAttempt::Overflowed),
                Ok(CompactionAttempt::Done(result(50))),
            ],
        );
        fc.compaction_round(&messages, 1, CompactionSource::Manual, None).unwrap();
        let counts = delegate.seen_counts.lock().unwrap();
        for pair in counts.windows(2) {
            assert!(pair[1] < pair[0], "retries must shrink: {counts:?}");
        }
        for count in counts.iter() {
            assert!(*count > 0 && *count <= messages.len(), "cut {count} out of range");
            assert!(can_split_after(&messages, count - 1), "cut {count} is unsafe");
        }
    }

    // ── per-turn cap ──────────────────────────────────────────────────────

    #[test]
    fn the_default_has_no_per_turn_cap() {
        let (mut fc, _) = with_delegate(
            100_000,
            (0..5).map(|_| Ok(CompactionAttempt::Done(result(1)))).collect(),
        );
        for i in 0..5 {
            let used = 90_000 + i * 1_000;
            assert!(fc.compaction_round(&history(), used, CompactionSource::Auto, None).is_ok());
        }
    }

    #[test]
    fn a_configured_cap_stops_repeated_auto_compaction() {
        let delegate = std::sync::Arc::new(ScriptedDelegate::new(
            (0..5).map(|_| Ok(CompactionAttempt::Done(result(1)))).collect(),
        ));
        let mut fc = FullCompaction::new(
            CompactionConfig { max_compaction_per_turn: Some(2), ..Default::default() },
            model(100_000),
        );
        fc.set_delegate(Box::new(DelegateHandle(delegate)));
        assert!(fc.compaction_round(&history(), 90_000, CompactionSource::Auto, None).is_ok());
        assert!(fc.compaction_round(&history(), 91_000, CompactionSource::Auto, None).is_ok());
        assert_eq!(
            fc.compaction_round(&history(), 92_000, CompactionSource::Auto, None),
            Err(CompactionError::TurnLimitExceeded)
        );
    }

    #[test]
    fn a_manual_compaction_resets_the_per_turn_counter() {
        let delegate = std::sync::Arc::new(ScriptedDelegate::new(
            (0..5).map(|_| Ok(CompactionAttempt::Done(result(1)))).collect(),
        ));
        let mut fc = FullCompaction::new(
            CompactionConfig { max_compaction_per_turn: Some(1), ..Default::default() },
            model(100_000),
        );
        fc.set_delegate(Box::new(DelegateHandle(delegate)));
        fc.compaction_round(&history(), 90_000, CompactionSource::Auto, None).unwrap();
        // Manual clears the budget rather than being refused by it.
        assert!(fc.compaction_round(&history(), 91_000, CompactionSource::Manual, None).is_ok());
    }

    #[test]
    fn reset_for_turn_clears_the_counters() {
        let (mut fc, _) = with_delegate(100_000, vec![Ok(CompactionAttempt::Done(result(60_000)))]);
        fc.compaction_round(&history(), 90_000, CompactionSource::Auto, None).unwrap();
        fc.reset_for_turn();
        assert!(fc.should_compact(60_000), "the monotonic guard is cleared too");
    }

    // ── phase handling ────────────────────────────────────────────────────

    #[test]
    fn cancel_returns_to_idle() {
        let mut fc = FullCompaction::new(CompactionConfig::default(), model(100_000));
        fc.phase = CompactionPhase::Running;
        fc.cancel();
        assert_eq!(fc.phase(), CompactionPhase::Idle);
    }

    #[test]
    fn a_stranded_running_phase_is_reset_on_restore() {
        let mut fc = FullCompaction::new(CompactionConfig::default(), model(100_000));
        fc.restore(CompactionPhase::Running);
        assert_eq!(fc.phase(), CompactionPhase::Idle);
        assert!(!fc.is_compacting());
    }

    // ── handoff + micro ───────────────────────────────────────────────────

    #[test]
    fn handoff_info_records_the_trigger_source() {
        let result = result(500);
        let auto = CompactionHandoffInfo::from_result(&result, CompactionSource::Auto);
        assert!(auto.is_auto);
        assert_eq!(auto.tokens_before, 1000);
        assert_eq!(auto.tokens_after, 500);
        let manual = CompactionHandoffInfo::from_result(&result, CompactionSource::Manual);
        assert!(!manual.is_auto);
    }

    #[test]
    fn micro_compaction_detects_pressure_near_the_ceiling() {
        let micro = MicroCompaction::new(1_000);
        assert!(micro.detect(99_500, 100_000));
        assert!(!micro.detect(98_000, 100_000));
        assert!(!micro.detect(99_500, 0), "an unknown window never triggers");
    }
}
