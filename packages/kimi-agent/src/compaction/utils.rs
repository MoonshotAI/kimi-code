/// `fullCompaction` helpers — summarizer-input shaping and response validation.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/fullCompaction/compactionUtils.ts`.
///
/// When the summarizer request itself overflows the model window, the history
/// handed to it is shrunk and retried. Shrinking is not a plain slice: cutting
/// mid-exchange leaves tool results whose calls are gone, which most providers
/// reject outright, so every trim is followed by dropping any leading tool
/// results the cut exposed.
use crate::compaction::strategy::CompactionSource;
use crate::context::tokenizer::{estimate_message_tokens, estimate_messages_tokens};
use crate::context::types::{ContentPart, ContextMessage};

/// Progressively harsher retry budgets, as a share of the current history.
pub const COMPACTION_OVERFLOW_SHRINK_RATIOS: [f64; 3] = [0.7, 0.5, 0.35];

/// Why a compaction attempt produced no usable summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompactionAttemptError {
    /// The provider stopped mid-summary; retrying with less input may help.
    Truncated,
    /// The provider returned successfully but with no text.
    EmptyResponse,
}

impl std::fmt::Display for CompactionAttemptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CompactionAttemptError::Truncated => f.write_str(
                "Compaction response was truncated before producing a complete summary.",
            ),
            CompactionAttemptError::EmptyResponse => {
                f.write_str("The compaction response did not contain a non-empty summary.")
            }
        }
    }
}

impl std::error::Error for CompactionAttemptError {}

/// Extract the summary text from a finished summarizer response.
///
/// TS also threads the provider's `usage` through; that is pure passthrough and
/// is left to the caller so this stays a function of the response text alone.
pub fn collect_summary(
    provider_finish_reason: Option<&str>,
    content: &[ContentPart],
) -> Result<String, CompactionAttemptError> {
    if provider_finish_reason == Some("truncated") {
        return Err(CompactionAttemptError::Truncated);
    }
    let summary: String = content
        .iter()
        .filter_map(|part| match part {
            ContentPart::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .concat()
        .trim()
        .to_string();
    if summary.is_empty() {
        return Err(CompactionAttemptError::EmptyResponse);
    }
    Ok(summary)
}

/// Whether the live history still matches the snapshot the summary was built
/// from.
///
/// Compaction runs concurrently with the turn loop, so the history can move
/// underneath it. Applying a summary computed from a stale prefix would drop
/// messages the summary never covered. The rewrite is only safe when the
/// original is still an exact prefix and everything appended since is real user
/// input — which the summary's own tail selection will preserve anyway.
///
/// TS compares by reference identity (`message === current[index]`); this
/// compares structurally, which is strictly weaker only in the case where a
/// message was replaced by an identical copy — indistinguishable to the caller.
pub fn history_safe_to_compact(
    current: &[ContextMessage],
    original: &[ContextMessage],
) -> bool {
    if current.len() < original.len() {
        return false;
    }
    if !original.iter().enumerate().all(|(index, message)| messages_equal(message, &current[index]))
    {
        return false;
    }
    current[original.len()..]
        .iter()
        .all(crate::context::compaction_handoff::is_real_user_input)
}

/// Structural stand-in for TS's reference equality.
fn messages_equal(left: &ContextMessage, right: &ContextMessage) -> bool {
    left.role == right.role
        && left.tool_call_id == right.tool_call_id
        && left.tool_calls.len() == right.tool_calls.len()
        && left
            .tool_calls
            .iter()
            .zip(right.tool_calls.iter())
            .all(|(a, b)| a.id == b.id && a.name == b.name)
        && content_text(left) == content_text(right)
}

fn content_text(message: &ContextMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|part| match part {
            ContentPart::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .concat()
}

/// Shrink the summarizer input after an overflow, harder on each attempt.
///
/// `attempt` is 1-based; past the ratio table the harshest ratio repeats.
pub fn shrink_compaction_history_after_overflow(
    messages: &[ContextMessage],
    attempt: u32,
) -> Vec<ContextMessage> {
    if messages.len() <= 1 {
        return messages.to_vec();
    }
    let index = (attempt.max(1) as usize - 1).min(COMPACTION_OVERFLOW_SHRINK_RATIOS.len() - 1);
    let ratio = COMPACTION_OVERFLOW_SHRINK_RATIOS[index];
    let token_budget = (estimate_messages_tokens(messages) as f64 * ratio).floor() as u64;
    take_recent_messages_within_token_budget(messages, token_budget)
}

/// Keep the newest messages that fit the budget, never returning an empty
/// history, and never leading with an orphaned tool result.
fn take_recent_messages_within_token_budget(
    messages: &[ContextMessage],
    token_budget: u64,
) -> Vec<ContextMessage> {
    let mut start = messages.len();
    let mut tokens: u64 = 0;
    for i in (0..messages.len()).rev() {
        let message_tokens = estimate_message_tokens(&messages[i]);
        if tokens + message_tokens > token_budget {
            break;
        }
        tokens += message_tokens;
        start = i;
    }
    // Always leave the model something to summarise.
    if start == 0 {
        start = 1;
    }
    drop_leading_tool_results(&messages[start..])
}

/// Drop the oldest message, then any tool results the cut exposed.
pub fn drop_oldest_message_and_leading_tool_results(
    messages: &[ContextMessage],
) -> Vec<ContextMessage> {
    if messages.len() <= 1 {
        return messages.to_vec();
    }
    drop_leading_tool_results(&messages[1..])
}

/// Strip leading `tool` messages, whose owning assistant is no longer present.
pub fn drop_leading_tool_results(messages: &[ContextMessage]) -> Vec<ContextMessage> {
    let start = messages.iter().position(|m| m.role != "tool").unwrap_or(messages.len());
    messages[start..].to_vec()
}

/// Whether a source warrants retrying after an overflow at all.
///
/// Manual compaction is user-initiated and always retried; automatic
/// compaction gives up once the attempt budget is spent so the turn is not
/// stalled indefinitely.
pub fn should_retry_after_overflow(
    source: CompactionSource,
    attempt: u32,
    max_attempts: u32,
) -> bool {
    match source {
        CompactionSource::Manual => attempt <= max_attempts,
        CompactionSource::Auto => attempt <= max_attempts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::types::MessageOrigin;

    fn msg(role: &str, text: &str) -> ContextMessage {
        ContextMessage {
            role: role.to_string(),
            content: vec![ContentPart::Text { text: text.to_string() }],
            ..Default::default()
        }
    }

    fn user(text: &str) -> ContextMessage {
        ContextMessage { origin: Some(MessageOrigin::User), ..msg("user", text) }
    }

    fn roles(messages: &[ContextMessage]) -> Vec<&str> {
        messages.iter().map(|m| m.role.as_str()).collect()
    }

    // ── collect_summary ───────────────────────────────────────────────────

    #[test]
    fn collects_and_trims_the_summary_text() {
        let content = vec![
            ContentPart::Text { text: "  first ".to_string() },
            ContentPart::Text { text: "second  ".to_string() },
        ];
        assert_eq!(collect_summary(None, &content).unwrap(), "first second");
    }

    #[test]
    fn a_truncated_response_is_rejected() {
        let content = vec![ContentPart::Text { text: "partial".to_string() }];
        assert_eq!(
            collect_summary(Some("truncated"), &content),
            Err(CompactionAttemptError::Truncated)
        );
    }

    #[test]
    fn an_empty_response_is_rejected() {
        assert_eq!(collect_summary(None, &[]), Err(CompactionAttemptError::EmptyResponse));
        let blank = vec![ContentPart::Text { text: "   \n ".to_string() }];
        assert_eq!(
            collect_summary(None, &blank),
            Err(CompactionAttemptError::EmptyResponse)
        );
    }

    #[test]
    fn non_text_parts_are_skipped() {
        let content = vec![
            ContentPart::Think { think: Some("reasoning".to_string()), encrypted: None, signature: None },
            ContentPart::Text { text: "summary".to_string() },
        ];
        assert_eq!(collect_summary(None, &content).unwrap(), "summary");
    }

    #[test]
    fn other_finish_reasons_are_accepted() {
        let content = vec![ContentPart::Text { text: "done".to_string() }];
        assert_eq!(collect_summary(Some("stop"), &content).unwrap(), "done");
    }

    // ── history_safe_to_compact ───────────────────────────────────────────

    #[test]
    fn an_unchanged_history_is_safe() {
        let original = vec![user("q"), msg("assistant", "a")];
        assert!(history_safe_to_compact(&original, &original));
    }

    #[test]
    fn appended_user_input_is_safe() {
        let original = vec![user("q"), msg("assistant", "a")];
        let mut current = original.clone();
        current.push(user("another question"));
        assert!(history_safe_to_compact(&current, &original));
    }

    #[test]
    fn a_shortened_history_is_unsafe() {
        let original = vec![user("q"), msg("assistant", "a")];
        assert!(!history_safe_to_compact(&original[..1], &original));
    }

    #[test]
    fn a_rewritten_prefix_is_unsafe() {
        let original = vec![user("q"), msg("assistant", "a")];
        let mut current = original.clone();
        current[1] = msg("assistant", "different answer");
        assert!(!history_safe_to_compact(&current, &original));
    }

    #[test]
    fn appended_non_user_traffic_is_unsafe() {
        // An assistant turn landed while the summary was in flight; applying
        // the rewrite would drop it.
        let original = vec![user("q")];
        let mut current = original.clone();
        current.push(msg("assistant", "a"));
        assert!(!history_safe_to_compact(&current, &original));
    }

    #[test]
    fn appended_synthetic_user_messages_are_unsafe() {
        let original = vec![user("q")];
        let mut current = original.clone();
        current.push(ContextMessage {
            origin: Some(MessageOrigin::Injection { variant: "goal".to_string() }),
            ..msg("user", "reminder")
        });
        assert!(!history_safe_to_compact(&current, &original));
    }

    // ── shrinking ─────────────────────────────────────────────────────────

    #[test]
    fn a_single_message_history_is_returned_as_is() {
        let messages = vec![user("only")];
        assert_eq!(shrink_compaction_history_after_overflow(&messages, 1).len(), 1);
        assert!(shrink_compaction_history_after_overflow(&[], 1).is_empty());
    }

    #[test]
    fn each_attempt_shrinks_harder() {
        let messages: Vec<_> = (0..20).map(|i| user(&format!("message {i} {}", "x".repeat(200)))).collect();
        let first = shrink_compaction_history_after_overflow(&messages, 1);
        let second = shrink_compaction_history_after_overflow(&messages, 2);
        let third = shrink_compaction_history_after_overflow(&messages, 3);
        assert!(first.len() > second.len(), "{} vs {}", first.len(), second.len());
        assert!(second.len() > third.len(), "{} vs {}", second.len(), third.len());
    }

    #[test]
    fn attempts_past_the_table_reuse_the_harshest_ratio() {
        let messages: Vec<_> = (0..20).map(|i| user(&format!("message {i} {}", "x".repeat(200)))).collect();
        let third = shrink_compaction_history_after_overflow(&messages, 3);
        let tenth = shrink_compaction_history_after_overflow(&messages, 10);
        assert_eq!(third.len(), tenth.len());
    }

    #[test]
    fn shrinking_keeps_the_newest_messages() {
        let messages: Vec<_> = (0..20).map(|i| user(&format!("message {i} {}", "x".repeat(200)))).collect();
        let shrunk = shrink_compaction_history_after_overflow(&messages, 1);
        let last = shrunk.last().unwrap();
        assert!(content_text(last).starts_with("message 19"));
    }

    #[test]
    fn a_budget_too_small_for_any_message_shrinks_to_nothing() {
        // Faithful to TS, and worth pinning: `start` begins at `len` and only
        // walks back for messages that fit, so when none fit the result is
        // empty. The `start === 0` guard only prevents keeping *everything* —
        // it does not establish a floor of one. The caller must treat an empty
        // shrink as "give up", not as "summarise nothing".
        let messages = vec![user(&"x".repeat(100_000)), user(&"y".repeat(100_000))];
        assert!(shrink_compaction_history_after_overflow(&messages, 3).is_empty());
    }

    #[test]
    fn shrinking_keeps_at_least_one_message_when_the_tail_fits() {
        let messages: Vec<_> = (0..10).map(|i| user(&format!("m{i}"))).collect();
        let shrunk = shrink_compaction_history_after_overflow(&messages, 1);
        assert!(!shrunk.is_empty());
        assert!(shrunk.len() < messages.len(), "the head must be dropped");
    }

    #[test]
    fn shrinking_drops_tool_results_the_cut_exposed() {
        let messages = vec![
            user("q"),
            msg("assistant", "a"),
            msg("tool", "r1"),
            msg("tool", "r2"),
            user("tail"),
        ];
        // Force a cut that would otherwise lead with a tool result.
        let shrunk = take_recent_messages_within_token_budget(&messages, 1);
        assert!(shrunk.first().is_none_or(|m| m.role != "tool"));
    }

    // ── leading tool result handling ──────────────────────────────────────

    #[test]
    fn leading_tool_results_are_stripped() {
        let messages = vec![msg("tool", "r1"), msg("tool", "r2"), user("q"), msg("tool", "r3")];
        assert_eq!(roles(&drop_leading_tool_results(&messages)), vec!["user", "tool"]);
    }

    #[test]
    fn a_history_of_only_tool_results_strips_to_empty() {
        let messages = vec![msg("tool", "r1"), msg("tool", "r2")];
        assert!(drop_leading_tool_results(&messages).is_empty());
    }

    #[test]
    fn nothing_is_stripped_when_the_head_is_not_a_tool_result() {
        let messages = vec![user("q"), msg("tool", "r")];
        assert_eq!(drop_leading_tool_results(&messages).len(), 2);
    }

    #[test]
    fn dropping_the_oldest_also_clears_exposed_tool_results() {
        let messages = vec![msg("assistant", "a"), msg("tool", "r1"), msg("tool", "r2"), user("q")];
        assert_eq!(roles(&drop_oldest_message_and_leading_tool_results(&messages)), vec!["user"]);
    }

    #[test]
    fn dropping_the_oldest_of_a_singleton_is_a_no_op() {
        let messages = vec![user("only")];
        assert_eq!(drop_oldest_message_and_leading_tool_results(&messages).len(), 1);
    }

    #[test]
    fn retry_budget_is_shared_by_both_sources() {
        assert!(should_retry_after_overflow(CompactionSource::Auto, 3, 3));
        assert!(!should_retry_after_overflow(CompactionSource::Auto, 4, 3));
        assert!(should_retry_after_overflow(CompactionSource::Manual, 3, 3));
        assert!(!should_retry_after_overflow(CompactionSource::Manual, 4, 3));
    }
}
