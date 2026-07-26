/// `fullCompaction` strategy — when to compact, and where to cut.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/fullCompaction/strategy.ts`.
///
/// Two independent decisions live here:
///
/// 1. **Whether** to compact (`should_compact`) or to block the step loop
///    until compaction finishes (`should_block`). Both are pure predicates on
///    the used token count.
/// 2. **Where** to cut (`compute_compact_count`) — which prefix of the history
///    is handed to the summarizer. The cut may only land at a point where
///    removing the prefix leaves a wire-valid conversation, which is what
///    `can_split_after` enforces.
///
/// The same algorithm is also ported in `kimi-native-tools/src/compaction.rs`
/// for the napi path. That copy is currently unreachable (no TS caller wires
/// `tryNativeComputeCompactCount`), and this one is independent so the CLI
/// binary does not have to link napi. If either is changed, change both.
use crate::context::tokenizer::estimate_message_tokens;
use crate::context::types::ContextMessage;

/// Whether the compaction was asked for by the user or triggered by pressure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionSource {
    Auto,
    Manual,
}

/// Knobs for the compaction algorithm. Defaults mirror
/// `DEFAULT_COMPACTION_CONFIG`.
///
/// `max_compaction_per_turn` and `max_recent_user_messages` are `Infinity` in
/// TS; `None` carries that here.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionStrategyConfig {
    pub trigger_ratio: f64,
    pub block_ratio: f64,
    pub reserved_context_size: u64,
    pub max_compaction_per_turn: Option<u32>,
    pub max_overflow_compaction_attempts: u32,
    pub max_recent_messages: u32,
    pub max_recent_user_messages: Option<u32>,
    pub max_recent_size_ratio: f64,
    pub min_overflow_reduction_ratio: f64,
}

impl Default for CompactionStrategyConfig {
    fn default() -> Self {
        Self {
            trigger_ratio: 0.85,
            block_ratio: 0.85,
            reserved_context_size: 50_000,
            max_compaction_per_turn: None,
            max_overflow_compaction_attempts: 3,
            max_recent_messages: 4,
            max_recent_user_messages: None,
            max_recent_size_ratio: 0.2,
            min_overflow_reduction_ratio: 0.05,
        }
    }
}

/// The model-side inputs the runtime strategy reads.
#[derive(Debug, Clone, Default)]
pub struct ProfileModelContext {
    /// `max_input_tokens` when the provider publishes one, else
    /// `max_context_tokens`.
    pub max_size: u64,
    pub compaction_trigger_ratio: Option<f64>,
    pub reserved_context_size: Option<u64>,
}

/// The strategy as configured by the active model profile.
///
/// Note the asymmetry TS encodes and this preserves: the *trigger* predicates
/// read the model-adjusted config, while the *window* functions
/// (`compute_compact_count` / `reduce_compact_on_overflow`) always run against
/// the defaults, taking only `max_size` from the model. A profile that raises
/// its trigger ratio therefore compacts sooner without also changing where the
/// cut lands.
#[derive(Debug, Clone)]
pub struct RuntimeCompactionStrategy {
    context: ProfileModelContext,
}

impl RuntimeCompactionStrategy {
    pub fn new(context: ProfileModelContext) -> Self {
        Self { context }
    }

    /// The model's usable context window.
    pub fn max_size(&self) -> u64 {
        self.context.max_size
    }

    /// The model-adjusted config used by the trigger predicates.
    pub fn config(&self) -> CompactionStrategyConfig {
        let defaults = CompactionStrategyConfig::default();
        let trigger_ratio = self.context.compaction_trigger_ratio.unwrap_or(defaults.trigger_ratio);
        CompactionStrategyConfig {
            trigger_ratio,
            // A profile may lower the trigger but never the block threshold.
            block_ratio: trigger_ratio.max(defaults.block_ratio),
            reserved_context_size: self
                .context
                .reserved_context_size
                .unwrap_or(defaults.reserved_context_size),
            ..defaults
        }
    }

    fn trigger_delegate(&self) -> DefaultCompactionStrategy {
        DefaultCompactionStrategy::new(self.context.max_size, self.config())
    }

    fn window_delegate(&self) -> DefaultCompactionStrategy {
        DefaultCompactionStrategy::new(self.context.max_size, CompactionStrategyConfig::default())
    }

    pub fn should_compact(&self, used_size: u64) -> bool {
        self.trigger_delegate().should_compact(used_size)
    }

    pub fn should_block(&self, used_size: u64) -> bool {
        self.trigger_delegate().should_block(used_size)
    }

    pub fn compute_compact_count(
        &self,
        messages: &[ContextMessage],
        source: CompactionSource,
    ) -> usize {
        self.window_delegate().compute_compact_count(messages, source)
    }

    pub fn reduce_compact_on_overflow(&self, messages: &[ContextMessage]) -> usize {
        self.window_delegate().reduce_compact_on_overflow(messages)
    }

    /// The largest safe cut strictly shallower than `current`.
    pub fn previous_safe_split(
        &self,
        messages: &[ContextMessage],
        current: usize,
    ) -> Option<usize> {
        self.window_delegate().previous_safe_split(messages, current)
    }

    /// Whether the loop must re-check pressure after every step, which is only
    /// necessary when blocking kicks in later than triggering.
    pub fn check_after_step(&self) -> bool {
        let config = self.config();
        config.trigger_ratio != config.block_ratio
    }

    pub fn max_compaction_per_turn(&self) -> Option<u32> {
        CompactionStrategyConfig::default().max_compaction_per_turn
    }

    pub fn max_overflow_compaction_attempts(&self) -> u32 {
        CompactionStrategyConfig::default().max_overflow_compaction_attempts
    }
}

#[derive(Debug, Clone)]
pub struct DefaultCompactionStrategy {
    max_size: u64,
    config: CompactionStrategyConfig,
}

impl DefaultCompactionStrategy {
    pub fn new(max_size: u64, config: CompactionStrategyConfig) -> Self {
        Self { max_size, config }
    }

    pub fn with_defaults(max_size: u64) -> Self {
        Self::new(max_size, CompactionStrategyConfig::default())
    }

    pub fn config(&self) -> &CompactionStrategyConfig {
        &self.config
    }

    pub fn max_size(&self) -> u64 {
        self.max_size
    }

    /// Whether pressure warrants compacting.
    ///
    /// Either the plain ratio is crossed, or the remaining headroom has fallen
    /// below the reserved slice the agent must keep free for its own output.
    pub fn should_compact(&self, used_size: u64) -> bool {
        if self.max_size == 0 {
            return false;
        }
        used_size as f64 >= self.max_size as f64 * self.config.trigger_ratio
            || self.should_use_reserved_context(used_size)
    }

    /// Whether the step loop must stop and wait for compaction.
    pub fn should_block(&self, used_size: u64) -> bool {
        if self.max_size == 0 {
            return false;
        }
        used_size as f64 >= self.max_size as f64 * self.config.block_ratio
            || self.should_use_reserved_context(used_size)
    }

    /// True once the free headroom no longer covers the reserved slice.
    ///
    /// A reserve at or above `max_size` is meaningless (nothing would ever
    /// fit), so it is ignored rather than pinning the predicate to true.
    fn should_use_reserved_context(&self, used_size: u64) -> bool {
        let reserved = self.config.reserved_context_size;
        reserved > 0 && reserved < self.max_size && used_size + reserved >= self.max_size
    }

    /// How many messages from the head should be handed to the summarizer.
    ///
    /// Manual compaction takes the largest safe prefix. Auto compaction keeps a
    /// recent window — bounded by message count, user-message count, and a
    /// share of the context — and compacts everything before it.
    pub fn compute_compact_count(
        &self,
        messages: &[ContextMessage],
        source: CompactionSource,
    ) -> usize {
        let n = messages.len();
        if n == 0 {
            return 0;
        }

        if source == CompactionSource::Manual {
            for i in (1..n).rev() {
                if can_split_after(messages, i) {
                    return self.fit_compact_count_to_window(messages, i + 1);
                }
            }
            return 0;
        }

        let mut recent_messages: usize = 1;
        let mut recent_user_messages: u32 = 0;
        let mut recent_size: u64 = 0;
        let mut best_n: Option<usize> = None;

        while recent_messages < n {
            let index = n - recent_messages;
            let message = &messages[index];
            if message.role == "user" {
                recent_user_messages += 1;
            }
            recent_size = recent_size.saturating_add(estimate_message_tokens(message));

            let split_index = index - 1;
            if can_split_after(messages, split_index) {
                best_n = Some(split_index + 1);
            }

            let reaches_max = recent_messages as u32 >= self.config.max_recent_messages
                || self
                    .config
                    .max_recent_user_messages
                    .is_some_and(|limit| recent_user_messages >= limit)
                || recent_size as f64 >= self.max_size as f64 * self.config.max_recent_size_ratio;
            if reaches_max && best_n.is_some() {
                break;
            }
            recent_messages += 1;
        }

        self.fit_compact_count_to_window(messages, best_n.unwrap_or(0))
    }

    /// Pick a deeper cut after the summarizer request itself overflowed.
    ///
    /// Walks back from the tail until the removed slice is worth the retry
    /// (`min_overflow_reduction_ratio` of the window), returning the first safe
    /// split that clears the bar, or the deepest safe split found.
    pub fn reduce_compact_on_overflow(&self, messages: &[ContextMessage]) -> usize {
        let n = messages.len();
        if n < 2 {
            return n;
        }
        let min_reduced_size = ((self.max_size as f64
            * self.config.min_overflow_reduction_ratio)
            .ceil() as u64)
            .max(1);

        let mut reduced_size: u64 = 0;
        let mut best_n: Option<usize> = None;

        for i in (1..n - 1).rev() {
            reduced_size = reduced_size.saturating_add(estimate_message_tokens(&messages[i + 1]));
            if can_split_after(messages, i) {
                best_n = Some(i + 1);
                if reduced_size >= min_reduced_size {
                    return i + 1;
                }
            }
        }
        best_n.unwrap_or(n)
    }

    /// Shrink the cut until the compacted prefix itself fits the window —
    /// there is no point asking the model to summarise more than it can read.
    fn fit_compact_count_to_window(
        &self,
        messages: &[ContextMessage],
        compacted_count: usize,
    ) -> usize {
        if self.max_size == 0 || compacted_count == 0 {
            return compacted_count;
        }

        let mut compacted_size: u64 = messages
            .iter()
            .take(compacted_count)
            .map(estimate_message_tokens)
            .sum();
        if compacted_size <= self.max_size {
            return compacted_count;
        }

        let mut best_n: Option<usize> = None;
        for n in (1..compacted_count).rev() {
            compacted_size = compacted_size.saturating_sub(estimate_message_tokens(&messages[n]));
            if !can_split_after(messages, n - 1) {
                continue;
            }
            best_n = Some(n);
            if compacted_size <= self.max_size {
                return n;
            }
        }

        best_n.unwrap_or(compacted_count)
    }

    pub fn check_after_step(&self) -> bool {
        self.config.trigger_ratio != self.config.block_ratio
    }

    /// The largest safe cut strictly shallower than `current`.
    ///
    /// Used to make progress across repeated overflows:
    /// `reduce_compact_on_overflow` is a function of the history alone, so
    /// calling it twice returns the same answer. Stepping down one safe split
    /// at a time guarantees each retry sends a strictly smaller request.
    pub fn previous_safe_split(
        &self,
        messages: &[ContextMessage],
        current: usize,
    ) -> Option<usize> {
        (1..current.min(messages.len() + 1)).rev().find(|&n| can_split_after(messages, n - 1))
    }
}

/// Whether a cut placed immediately after `messages[index]` leaves both halves
/// wire-valid.
///
/// Unsafe when the cut would separate a user turn from its answer, strand an
/// assistant's tool calls from their results, orphan a tool result from its
/// call, or leave the compacted prefix ending inside an unresolved exchange.
pub fn can_split_after(messages: &[ContextMessage], index: usize) -> bool {
    let Some(message) = messages.get(index) else {
        return false;
    };
    if message.role == "user" {
        return false;
    }
    if message.role == "assistant" && !message.tool_calls.is_empty() {
        return false;
    }
    if messages.get(index + 1).is_some_and(|next| next.role == "tool") {
        return false;
    }
    if prefix_ends_with_open_tool_exchange(messages, index) {
        return false;
    }
    true
}

/// Whether `messages[..=index]` ends inside a tool exchange whose assistant
/// issued more calls than the trailing results answer.
fn prefix_ends_with_open_tool_exchange(messages: &[ContextMessage], index: usize) -> bool {
    let Some(message) = messages.get(index) else {
        return false;
    };
    if message.role != "tool" {
        return false;
    }

    let mut tool_result_count: usize = 0;
    for i in (0..=index).rev() {
        let Some(message) = messages.get(i) else {
            return false;
        };
        if message.role == "tool" {
            tool_result_count += 1;
            continue;
        }
        return message.role == "assistant" && message.tool_calls.len() > tool_result_count;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::types::{ContentPart, ToolCall};

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

    fn user(text: &str) -> ContextMessage {
        msg("user", text, 0)
    }
    fn assistant(text: &str) -> ContextMessage {
        msg("assistant", text, 0)
    }
    fn assistant_calling(text: &str, calls: usize) -> ContextMessage {
        msg("assistant", text, calls)
    }
    fn tool(text: &str) -> ContextMessage {
        msg("tool", text, 0)
    }

    // ── trigger predicates ────────────────────────────────────────────────

    #[test]
    fn a_zero_window_never_triggers() {
        let s = DefaultCompactionStrategy::with_defaults(0);
        assert!(!s.should_compact(u64::MAX));
        assert!(!s.should_block(u64::MAX));
    }

    #[test]
    fn the_plain_ratio_triggers_compaction() {
        // reserved defaults to 50k, so use a window large enough that the
        // reserved rule does not fire first.
        let s = DefaultCompactionStrategy::new(
            1_000_000,
            CompactionStrategyConfig { reserved_context_size: 0, ..Default::default() },
        );
        assert!(!s.should_compact(849_999));
        assert!(s.should_compact(850_000));
    }

    #[test]
    fn the_reserved_slice_triggers_before_the_ratio() {
        // 100k window, 50k reserved: pressure hits at 50k used, well before the
        // 85k the ratio alone would demand.
        let s = DefaultCompactionStrategy::with_defaults(100_000);
        assert!(!s.should_compact(49_999));
        assert!(s.should_compact(50_000));
    }

    #[test]
    fn a_reserve_at_or_above_the_window_is_ignored() {
        // Otherwise every session would be permanently "under pressure".
        let s = DefaultCompactionStrategy::new(
            10_000,
            CompactionStrategyConfig { reserved_context_size: 10_000, ..Default::default() },
        );
        assert!(!s.should_compact(0));
        assert!(s.should_compact(8_500), "the ratio still applies");
    }

    #[test]
    fn a_zero_reserve_disables_the_reserved_rule() {
        let s = DefaultCompactionStrategy::new(
            100_000,
            CompactionStrategyConfig { reserved_context_size: 0, ..Default::default() },
        );
        assert!(!s.should_compact(50_000));
        assert!(s.should_compact(85_000));
    }

    #[test]
    fn block_uses_its_own_ratio() {
        let s = DefaultCompactionStrategy::new(
            1_000_000,
            CompactionStrategyConfig {
                trigger_ratio: 0.5,
                block_ratio: 0.9,
                reserved_context_size: 0,
                ..Default::default()
            },
        );
        assert!(s.should_compact(500_000));
        assert!(!s.should_block(500_000));
        assert!(s.should_block(900_000));
    }

    #[test]
    fn check_after_step_only_when_the_ratios_differ() {
        let same = DefaultCompactionStrategy::with_defaults(1000);
        assert!(!same.check_after_step());
        let split = DefaultCompactionStrategy::new(
            1000,
            CompactionStrategyConfig { trigger_ratio: 0.5, ..Default::default() },
        );
        assert!(split.check_after_step());
    }

    // ── runtime strategy config resolution ────────────────────────────────

    #[test]
    fn the_runtime_strategy_defaults_to_the_static_config() {
        let s = RuntimeCompactionStrategy::new(ProfileModelContext {
            max_size: 100_000,
            ..Default::default()
        });
        assert_eq!(s.config(), CompactionStrategyConfig::default());
    }

    #[test]
    fn a_profile_may_lower_the_trigger_but_not_the_block_threshold() {
        let s = RuntimeCompactionStrategy::new(ProfileModelContext {
            max_size: 100_000,
            compaction_trigger_ratio: Some(0.5),
            ..Default::default()
        });
        let config = s.config();
        assert_eq!(config.trigger_ratio, 0.5);
        assert_eq!(config.block_ratio, 0.85, "block stays at the default floor");
        assert!(s.check_after_step());
    }

    #[test]
    fn a_profile_raising_the_trigger_raises_blocking_with_it() {
        let s = RuntimeCompactionStrategy::new(ProfileModelContext {
            max_size: 100_000,
            compaction_trigger_ratio: Some(0.95),
            ..Default::default()
        });
        let config = s.config();
        assert_eq!(config.trigger_ratio, 0.95);
        assert_eq!(config.block_ratio, 0.95);
        assert!(!s.check_after_step());
    }

    #[test]
    fn a_profile_may_override_the_reserved_slice() {
        let s = RuntimeCompactionStrategy::new(ProfileModelContext {
            max_size: 100_000,
            reserved_context_size: Some(1_000),
            ..Default::default()
        });
        assert_eq!(s.config().reserved_context_size, 1_000);
        assert!(!s.should_compact(50_000), "the smaller reserve delays the trigger");
        assert!(s.should_compact(99_000));
    }

    #[test]
    fn the_window_functions_ignore_the_profile_trigger_ratio() {
        // The cut point must not move just because a profile compacts sooner.
        let messages = vec![user("q"), assistant("a"), user("q2"), assistant("a2")];
        let tuned = RuntimeCompactionStrategy::new(ProfileModelContext {
            max_size: 100_000,
            compaction_trigger_ratio: Some(0.3),
            reserved_context_size: Some(1),
            ..Default::default()
        });
        let plain = RuntimeCompactionStrategy::new(ProfileModelContext {
            max_size: 100_000,
            ..Default::default()
        });
        assert_eq!(
            tuned.compute_compact_count(&messages, CompactionSource::Manual),
            plain.compute_compact_count(&messages, CompactionSource::Manual)
        );
    }

    // ── can_split_after ───────────────────────────────────────────────────

    #[test]
    fn cannot_split_after_a_user_message() {
        let messages = vec![user("q"), assistant("a")];
        assert!(!can_split_after(&messages, 0));
    }

    #[test]
    fn can_split_after_a_plain_assistant_message() {
        let messages = vec![user("q"), assistant("a"), user("q2")];
        assert!(can_split_after(&messages, 1));
    }

    #[test]
    fn cannot_split_after_an_assistant_with_pending_calls() {
        let messages = vec![assistant_calling("a", 1), tool("r")];
        assert!(!can_split_after(&messages, 0));
    }

    #[test]
    fn cannot_split_when_the_next_message_is_a_tool_result() {
        // Would orphan the result from its call.
        let messages = vec![assistant("a"), tool("r")];
        assert!(!can_split_after(&messages, 0));
    }

    #[test]
    fn can_split_after_a_closed_tool_exchange() {
        let messages = vec![assistant_calling("a", 1), tool("r"), user("next")];
        assert!(can_split_after(&messages, 1));
    }

    #[test]
    fn cannot_split_inside_an_open_tool_exchange() {
        // Two calls, only one result so far.
        let messages = vec![assistant_calling("a", 2), tool("r1"), tool("r2")];
        assert!(!can_split_after(&messages, 1), "one result still outstanding");
        assert!(can_split_after(&messages, 2), "both results present");
    }

    #[test]
    fn an_out_of_range_index_is_never_splittable() {
        assert!(!can_split_after(&[], 0));
        assert!(!can_split_after(&[user("q")], 5));
    }

    // ── compute_compact_count ─────────────────────────────────────────────

    #[test]
    fn an_empty_history_compacts_nothing() {
        let s = DefaultCompactionStrategy::with_defaults(100_000);
        assert_eq!(s.compute_compact_count(&[], CompactionSource::Auto), 0);
        assert_eq!(s.compute_compact_count(&[], CompactionSource::Manual), 0);
    }

    #[test]
    fn manual_compaction_takes_the_largest_safe_prefix() {
        let messages = vec![user("q1"), assistant("a1"), user("q2"), assistant("a2")];
        let s = DefaultCompactionStrategy::with_defaults(100_000);
        // The deepest safe split is after index 3 (the trailing assistant).
        assert_eq!(s.compute_compact_count(&messages, CompactionSource::Manual), 4);
    }

    #[test]
    fn manual_compaction_returns_zero_with_no_safe_split() {
        // A lone opening user message has no cut point after index 0.
        let messages = vec![user("q1"), user("q2")];
        let s = DefaultCompactionStrategy::with_defaults(100_000);
        assert_eq!(s.compute_compact_count(&messages, CompactionSource::Manual), 0);
    }

    #[test]
    fn manual_compaction_never_cuts_inside_a_tool_exchange() {
        let messages = vec![
            user("q"),
            assistant_calling("a", 2),
            tool("r1"),
            tool("r2"),
            user("next"),
        ];
        let s = DefaultCompactionStrategy::with_defaults(100_000);
        // Index 4 is a user message and index 3 closes the exchange, so the cut
        // lands after index 3.
        assert_eq!(s.compute_compact_count(&messages, CompactionSource::Manual), 4);
    }

    #[test]
    fn auto_compaction_keeps_a_recent_window() {
        // 10 turns; the default window keeps ~4 recent messages.
        let mut messages = Vec::new();
        for i in 0..5 {
            messages.push(user(&format!("q{i}")));
            messages.push(assistant(&format!("a{i}")));
        }
        let s = DefaultCompactionStrategy::with_defaults(1_000_000);
        let count = s.compute_compact_count(&messages, CompactionSource::Auto);
        assert!(count > 0 && count < messages.len(), "got {count}");
        assert!(can_split_after(&messages, count - 1), "the cut must be safe");
        assert!(messages.len() - count >= 4, "at least the recent window survives");
    }

    #[test]
    fn auto_compaction_respects_the_recent_size_ratio() {
        // One enormous trailing message should keep the window from growing.
        let mut messages = vec![user("q"), assistant("a"), user("q2")];
        messages.push(assistant(&"x".repeat(400_000)));
        let s = DefaultCompactionStrategy::with_defaults(100_000);
        let count = s.compute_compact_count(&messages, CompactionSource::Auto);
        assert!(count <= messages.len());
    }

    #[test]
    fn auto_compaction_returns_zero_when_no_safe_split_exists() {
        let messages = vec![user("q1"), user("q2")];
        let s = DefaultCompactionStrategy::with_defaults(100_000);
        assert_eq!(s.compute_compact_count(&messages, CompactionSource::Auto), 0);
    }

    #[test]
    fn the_cut_is_shrunk_to_fit_the_window() {
        // A prefix far larger than the window must be trimmed back.
        let big = "x".repeat(40_000); // 10k tokens each
        let messages = vec![
            assistant(&big),
            assistant(&big),
            assistant(&big),
            assistant(&big),
            user("tail"),
        ];
        let s = DefaultCompactionStrategy::with_defaults(15_000);
        let count = s.compute_compact_count(&messages, CompactionSource::Manual);
        let prefix_tokens: u64 =
            messages.iter().take(count).map(estimate_message_tokens).sum();
        assert!(prefix_tokens <= 15_000, "prefix {prefix_tokens} exceeded the window");
        assert!(count > 0);
    }

    #[test]
    fn a_zero_window_skips_the_fit_step() {
        let messages = vec![user("q"), assistant("a")];
        let s = DefaultCompactionStrategy::new(
            0,
            CompactionStrategyConfig { reserved_context_size: 0, ..Default::default() },
        );
        assert_eq!(s.compute_compact_count(&messages, CompactionSource::Manual), 2);
    }

    // ── reduce_compact_on_overflow ────────────────────────────────────────

    #[test]
    fn overflow_reduction_on_a_tiny_history_is_the_whole_history() {
        let s = DefaultCompactionStrategy::with_defaults(100_000);
        assert_eq!(s.reduce_compact_on_overflow(&[]), 0);
        assert_eq!(s.reduce_compact_on_overflow(&[user("q")]), 1);
    }

    #[test]
    fn overflow_reduction_finds_a_deeper_safe_split() {
        let mut messages = Vec::new();
        for i in 0..8 {
            messages.push(user(&format!("q{i}")));
            messages.push(assistant(&"x".repeat(40_000)));
        }
        let s = DefaultCompactionStrategy::with_defaults(100_000);
        let count = s.reduce_compact_on_overflow(&messages);
        assert!(count > 0 && count < messages.len(), "got {count}");
        assert!(can_split_after(&messages, count - 1));
    }

    #[test]
    fn overflow_reduction_falls_back_to_the_deepest_safe_split() {
        // Nothing removes enough tokens to clear the bar, so the best safe cut
        // found wins rather than giving up.
        let messages = vec![user("q"), assistant("a"), user("q2"), assistant("a2")];
        let s = DefaultCompactionStrategy::with_defaults(1_000_000);
        let count = s.reduce_compact_on_overflow(&messages);
        assert!(count >= 1 && count <= messages.len());
    }
}
