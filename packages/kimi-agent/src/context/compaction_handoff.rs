/// `contextMemory` domain helper — derives the v1-compatible full-compaction
/// handoff shape for live rewrites, wire replay, and snapshot reducers.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/contextMemory/compactionHandoff.ts`.
///
/// Compaction does not simply collapse the history to a summary: the real user
/// input is the part a summary cannot reconstruct, so a token-budgeted
/// selection of user messages survives verbatim. When the budget cannot hold
/// them all, the oldest (head) and newest (tail) slices are kept and an elision
/// note is spliced between them.
use crate::context::tokenizer::{estimate_message_tokens, estimate_messages_tokens, estimate_tokens};
use crate::context::types::{ContentPart, ContextMessage, MessageOrigin};

/// Prefix prepended to the model-facing compaction summary.
///
/// Mirrors `compaction-summary-prefix.md`, `trimEnd()`-ed as the TS module does
/// at import time.
pub const COMPACTION_SUMMARY_PREFIX: &str = "The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over. Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it. Any user messages earlier in this context are preserved verbatim from the compacted conversation; where a system-reminder note among them marks an omitted middle section, the user messages it replaced are covered by this summary.";

pub const COMPACT_USER_MESSAGE_MAX_TOKENS: u64 = 20_000;
pub const COMPACT_USER_MESSAGE_HEAD_TOKENS: u64 = 2_000;
pub const COMPACTION_ELISION_VARIANT: &str = "compaction_elision";

/// Whether a user message survives compaction verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionDisposition {
    Keep,
    Drop,
}

/// The head/tail split produced by the token-budgeted user-message selection.
#[derive(Debug, Clone)]
pub struct CompactionUserSelection {
    pub head: Vec<ContextMessage>,
    pub tail: Vec<ContextMessage>,
    pub elided: bool,
    pub omitted_tokens: u64,
}

#[derive(Debug, Clone, Default)]
pub struct ContextCompactionShapeInput {
    pub summary: String,
    pub legacy_summary_message: Option<ContextMessage>,
    pub context_summary: Option<String>,
    pub compacted_count: usize,
    pub tokens_before: u64,
    pub tokens_after: Option<u64>,
    pub kept_user_message_count: Option<usize>,
    pub kept_head_user_message_count: Option<usize>,
    pub dropped_count: Option<u32>,
    pub legacy_tail: bool,
}

#[derive(Debug, Clone)]
pub struct ContextCompactionShape {
    pub summary: String,
    pub context_summary: String,
    pub compacted_count: usize,
    pub tokens_before: u64,
    pub tokens_after: u64,
    pub kept_user_message_count: usize,
    pub kept_head_user_message_count: Option<usize>,
    pub dropped_count: Option<u32>,
    pub messages: Vec<ContextMessage>,
}

/// Build the post-compaction history and its accounting.
///
/// Two shapes exist. The legacy tail shape (`legacy_tail`) puts the summary
/// first and keeps everything after `compacted_count` — what v1 wrote. The
/// current shape keeps a token-budgeted selection of real user messages and
/// puts the summary *last*.
pub fn build_context_compaction_shape(
    history: &[ContextMessage],
    input: &ContextCompactionShapeInput,
) -> ContextCompactionShape {
    let context_summary =
        input.context_summary.clone().unwrap_or_else(|| input.summary.clone());

    if input.legacy_tail {
        let mut messages = Vec::new();
        messages.push(
            input
                .legacy_summary_message
                .clone()
                .unwrap_or_else(|| create_compaction_summary_message(&context_summary)),
        );
        let tail_start = input.compacted_count.min(history.len());
        messages.extend_from_slice(&history[tail_start..]);
        let tokens_after = input.tokens_after.unwrap_or_else(|| estimate_messages_tokens(&messages));
        return ContextCompactionShape {
            summary: input.summary.clone(),
            context_summary,
            compacted_count: input.compacted_count,
            tokens_before: input.tokens_before,
            tokens_after,
            kept_user_message_count: 0,
            kept_head_user_message_count: None,
            dropped_count: input.dropped_count,
            messages,
        };
    }

    let compactable = collect_compactable_user_messages(history);
    let selection = select_compaction_user_messages(
        &compactable,
        COMPACT_USER_MESSAGE_MAX_TOKENS,
        COMPACT_USER_MESSAGE_HEAD_TOKENS,
    );

    let mut kept_messages = Vec::with_capacity(selection.head.len() + selection.tail.len() + 1);
    kept_messages.extend(selection.head.iter().cloned());
    if selection.elided {
        kept_messages.push(create_compaction_elision_message(selection.omitted_tokens));
    }
    kept_messages.extend(selection.tail.iter().cloned());

    let tokens_after = input.tokens_after.unwrap_or_else(|| {
        estimate_tokens(&context_summary) + estimate_messages_tokens(&kept_messages)
    });
    let kept_user_message_count = input
        .kept_user_message_count
        .unwrap_or(selection.head.len() + selection.tail.len());
    let kept_head_user_message_count = input
        .kept_head_user_message_count
        .or(if selection.elided { Some(selection.head.len()) } else { None });

    let mut messages = kept_messages;
    messages.push(create_compaction_summary_message(&context_summary));

    ContextCompactionShape {
        summary: input.summary.clone(),
        context_summary,
        compacted_count: input.compacted_count,
        tokens_before: input.tokens_before,
        tokens_after,
        kept_user_message_count,
        kept_head_user_message_count,
        dropped_count: input.dropped_count,
        messages,
    }
}

pub fn build_compaction_summary_text(summary: &str) -> String {
    let suffix = summary.trim();
    let body = if suffix.is_empty() { "(no summary available)" } else { suffix };
    format!("{COMPACTION_SUMMARY_PREFIX}\n{body}")
}

pub fn create_compaction_summary_message(text: &str) -> ContextMessage {
    ContextMessage {
        role: "user".to_string(),
        content: vec![ContentPart::Text { text: text.to_string() }],
        tool_calls: Vec::new(),
        origin: Some(MessageOrigin::CompactionSummary),
        ..Default::default()
    }
}

pub fn create_compaction_elision_message(omitted_tokens: u64) -> ContextMessage {
    ContextMessage {
        role: "user".to_string(),
        content: vec![ContentPart::Text { text: build_compaction_elision_text(omitted_tokens) }],
        tool_calls: Vec::new(),
        origin: Some(MessageOrigin::Injection {
            variant: COMPACTION_ELISION_VARIANT.to_string(),
        }),
        ..Default::default()
    }
}

pub fn build_compaction_elision_text(omitted_tokens: u64) -> String {
    format!(
        "<system-reminder>\nSome of this conversation's user messages were omitted here during compaction: the messages above this note are the oldest user input, the messages below are the most recent, and roughly {omitted_tokens} tokens in between were dropped. The omitted content is covered by the compaction summary at the end of the conversation.\n</system-reminder>"
    )
}

pub fn collect_compactable_user_messages(messages: &[ContextMessage]) -> Vec<ContextMessage> {
    messages
        .iter()
        .filter(|m| is_real_user_input(m) && !is_compaction_summary_message(m))
        .cloned()
        .collect()
}

pub fn is_compaction_summary_message(message: &ContextMessage) -> bool {
    matches!(message.origin, Some(MessageOrigin::CompactionSummary))
}

pub fn is_real_user_input(message: &ContextMessage) -> bool {
    message.role == "user"
        && compaction_user_message_disposition(message.origin.as_ref()) == CompactionDisposition::Keep
}

/// Whether a message with this origin is real user input worth keeping verbatim.
///
/// An absent origin is treated as user input (TS: `origin === undefined` →
/// `'keep'`), matching histories written before origins were recorded.
pub fn compaction_user_message_disposition(
    origin: Option<&MessageOrigin>,
) -> CompactionDisposition {
    let Some(origin) = origin else {
        return CompactionDisposition::Keep;
    };
    match origin {
        MessageOrigin::User => CompactionDisposition::Keep,
        // A slash-invoked skill or plugin command *is* the user typing; the same
        // skill fired by the model is not.
        MessageOrigin::SkillActivation { trigger, .. }
        | MessageOrigin::PluginCommand { trigger, .. } => {
            if trigger == "user-slash" {
                CompactionDisposition::Keep
            } else {
                CompactionDisposition::Drop
            }
        }
        MessageOrigin::Injection { .. }
        | MessageOrigin::ShellCommand { .. }
        | MessageOrigin::CompactionSummary
        | MessageOrigin::SystemTrigger { .. }
        // TS names this origin `task`; this crate calls it `background_task`.
        | MessageOrigin::BackgroundTask { .. }
        | MessageOrigin::CronJob { .. }
        | MessageOrigin::CronMissed { .. }
        | MessageOrigin::HookResult { .. }
        | MessageOrigin::Retry { .. } => CompactionDisposition::Drop,
    }
}

/// Keep the newest messages that fit in `max_tokens`, truncating the boundary
/// message from its start when it only partly fits.
pub fn select_recent_user_messages(
    messages: &[ContextMessage],
    max_tokens: u64,
) -> Vec<ContextMessage> {
    let mut selected: Vec<ContextMessage> = Vec::new();
    let mut remaining = max_tokens;
    for message in messages.iter().rev() {
        if remaining == 0 {
            break;
        }
        let tokens = estimate_message_tokens(message);
        if tokens <= remaining {
            selected.push(message.clone());
            remaining -= tokens;
        } else {
            selected.push(truncate_user_message(message, remaining));
            break;
        }
    }
    selected.reverse();
    selected
}

/// Split the compactable user messages into a head slice and a tail slice that
/// together fit in `max_tokens`.
///
/// Under budget, everything is tail and nothing is elided. Over budget, the
/// newest messages fill `max_tokens - head_tokens` and the oldest fill
/// `head_tokens`; the text a partially-kept boundary message loses from its end
/// is offered back to the head as a candidate, so the opening of a long message
/// survives even when its bulk does not.
pub fn select_compaction_user_messages(
    messages: &[ContextMessage],
    max_tokens: u64,
    head_tokens: u64,
) -> CompactionUserSelection {
    let total_tokens: u64 = messages.iter().map(estimate_message_tokens).sum();
    if total_tokens <= max_tokens {
        return CompactionUserSelection {
            head: Vec::new(),
            tail: messages.to_vec(),
            elided: false,
            omitted_tokens: 0,
        };
    }

    let head_budget = head_tokens.min(max_tokens);
    let tail_budget = max_tokens - head_budget;

    let mut tail: Vec<ContextMessage> = Vec::new();
    let mut tail_remaining = tail_budget;
    let mut head_end_exclusive = messages.len();
    let mut tail_boundary_dropped_prefix: Option<ContextMessage> = None;

    let mut i = messages.len();
    while i > 0 && tail_remaining > 0 {
        i -= 1;
        let message = &messages[i];
        let tokens = estimate_message_tokens(message);
        if tokens <= tail_remaining {
            tail.push(message.clone());
            tail_remaining -= tokens;
            head_end_exclusive = i;
            continue;
        }
        let full_text = extract_text(&message.content);
        let kept_suffix = truncate_text_to_tokens_from_end(&full_text, tail_remaining);
        tail.push(replace_message_text(message, kept_suffix));
        head_end_exclusive = i;
        let dropped_prefix = &full_text[..full_text.len() - kept_suffix.len()];
        if !dropped_prefix.is_empty() {
            tail_boundary_dropped_prefix = Some(replace_message_text(message, dropped_prefix));
        }
        break;
    }
    tail.reverse();

    let mut head_candidates: Vec<ContextMessage> = messages[..head_end_exclusive].to_vec();
    if let Some(prefix) = tail_boundary_dropped_prefix {
        head_candidates.push(prefix);
    }

    let mut head: Vec<ContextMessage> = Vec::new();
    let mut head_remaining = head_budget;
    for message in &head_candidates {
        if head_remaining == 0 {
            break;
        }
        let tokens = estimate_message_tokens(message);
        if tokens <= head_remaining {
            head.push(message.clone());
            head_remaining -= tokens;
            continue;
        }
        head.push(truncate_user_message(message, head_remaining));
        break;
    }

    let kept_tokens: u64 = head.iter().chain(tail.iter()).map(estimate_message_tokens).sum();
    CompactionUserSelection {
        head,
        tail,
        elided: true,
        omitted_tokens: total_tokens.saturating_sub(kept_tokens),
    }
}

fn extract_text(content: &[ContentPart]) -> String {
    let mut text = String::new();
    for part in content {
        if let ContentPart::Text { text: body } = part {
            text.push_str(body);
        }
    }
    text
}

/// Keep the longest prefix of `text` that estimates to at most `max_tokens`.
///
/// Reimplements the tokenizer's `ceil(ascii/4) + non_ascii` formula inline, one
/// code point at a time, exactly as TS does — a code point is admitted only
/// while the running estimate stays within budget.
fn truncate_text_to_tokens(text: &str, max_tokens: u64) -> &str {
    if max_tokens == 0 {
        return "";
    }
    let mut ascii_count: u64 = 0;
    let mut non_ascii_count: u64 = 0;
    let mut end = 0usize;
    for (idx, ch) in text.char_indices() {
        if (ch as u32) <= 127 {
            ascii_count += 1;
        } else {
            non_ascii_count += 1;
        }
        if ascii_count.div_ceil(4) + non_ascii_count > max_tokens {
            break;
        }
        end = idx + ch.len_utf8();
    }
    &text[..end]
}

/// Keep the longest suffix of `text` that estimates to at most `max_tokens`.
///
/// TS walks UTF-16 code units backwards and manually re-pairs surrogates so a
/// non-BMP character counts once as non-ASCII; `char_indices().rev()` yields
/// whole code points natively, which is the same traversal.
fn truncate_text_to_tokens_from_end(text: &str, max_tokens: u64) -> &str {
    if max_tokens == 0 {
        return "";
    }
    let mut ascii_count: u64 = 0;
    let mut non_ascii_count: u64 = 0;
    let mut start = text.len();
    for (idx, ch) in text.char_indices().rev() {
        if (ch as u32) <= 127 {
            ascii_count += 1;
        } else {
            non_ascii_count += 1;
        }
        if ascii_count.div_ceil(4) + non_ascii_count > max_tokens {
            break;
        }
        start = idx;
    }
    &text[start..]
}

fn replace_message_text(message: &ContextMessage, text: &str) -> ContextMessage {
    ContextMessage {
        content: vec![ContentPart::Text { text: text.to_string() }],
        tool_calls: Vec::new(),
        ..message.clone()
    }
}

fn truncate_user_message(message: &ContextMessage, max_tokens: u64) -> ContextMessage {
    let full = extract_text(&message.content);
    let truncated = truncate_text_to_tokens(&full, max_tokens);
    replace_message_text(message, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_msg(text: &str) -> ContextMessage {
        ContextMessage {
            role: "user".to_string(),
            content: vec![ContentPart::Text { text: text.to_string() }],
            origin: Some(MessageOrigin::User),
            ..Default::default()
        }
    }

    fn assistant_msg(text: &str) -> ContextMessage {
        ContextMessage {
            role: "assistant".to_string(),
            content: vec![ContentPart::Text { text: text.to_string() }],
            ..Default::default()
        }
    }

    fn text_of(message: &ContextMessage) -> String {
        extract_text(&message.content)
    }

    // ── disposition ───────────────────────────────────────────────────────

    #[test]
    fn absent_origin_is_kept() {
        assert_eq!(compaction_user_message_disposition(None), CompactionDisposition::Keep);
    }

    #[test]
    fn user_origin_is_kept() {
        assert_eq!(
            compaction_user_message_disposition(Some(&MessageOrigin::User)),
            CompactionDisposition::Keep
        );
    }

    #[test]
    fn slash_invoked_skill_is_kept_model_invoked_is_dropped() {
        let slash = MessageOrigin::SkillActivation {
            activation_id: "a".to_string(),
            skill_name: "s".to_string(),
            skill_args: None,
            trigger: "user-slash".to_string(),
        };
        let model = MessageOrigin::SkillActivation {
            activation_id: "a".to_string(),
            skill_name: "s".to_string(),
            skill_args: None,
            trigger: "model-tool".to_string(),
        };
        assert_eq!(compaction_user_message_disposition(Some(&slash)), CompactionDisposition::Keep);
        assert_eq!(compaction_user_message_disposition(Some(&model)), CompactionDisposition::Drop);
    }

    #[test]
    fn synthetic_origins_are_dropped() {
        let origins = [
            MessageOrigin::Injection { variant: "x".to_string() },
            MessageOrigin::CompactionSummary,
            MessageOrigin::SystemTrigger { name: "n".to_string() },
            MessageOrigin::ShellCommand { phase: "input".to_string(), is_error: None },
            MessageOrigin::HookResult { event: "e".to_string(), blocked: None },
            MessageOrigin::Retry { trigger: None },
            MessageOrigin::CronMissed { count: 1 },
        ];
        for origin in &origins {
            assert_eq!(
                compaction_user_message_disposition(Some(origin)),
                CompactionDisposition::Drop,
                "{origin:?} should be dropped"
            );
        }
    }

    #[test]
    fn collect_keeps_only_real_user_input() {
        let history = vec![
            user_msg("keep me"),
            assistant_msg("not a user message"),
            ContextMessage {
                role: "user".to_string(),
                content: vec![ContentPart::Text { text: "injected".to_string() }],
                origin: Some(MessageOrigin::Injection { variant: "x".to_string() }),
                ..Default::default()
            },
            create_compaction_summary_message("old summary"),
            user_msg("keep me too"),
        ];
        let kept = collect_compactable_user_messages(&history);
        assert_eq!(kept.len(), 2);
        assert_eq!(text_of(&kept[0]), "keep me");
        assert_eq!(text_of(&kept[1]), "keep me too");
    }

    // ── truncation helpers ────────────────────────────────────────────────

    #[test]
    fn truncate_from_start_respects_budget() {
        // 8 ascii chars = 2 tokens; budget 1 token → 4 chars
        assert_eq!(truncate_text_to_tokens("abcdefgh", 1), "abcd");
        assert_eq!(truncate_text_to_tokens("abcdefgh", 2), "abcdefgh");
        assert_eq!(truncate_text_to_tokens("abcdefgh", 0), "");
    }

    #[test]
    fn truncate_from_end_respects_budget() {
        assert_eq!(truncate_text_to_tokens_from_end("abcdefgh", 1), "efgh");
        assert_eq!(truncate_text_to_tokens_from_end("abcdefgh", 2), "abcdefgh");
        assert_eq!(truncate_text_to_tokens_from_end("abcdefgh", 0), "");
    }

    #[test]
    fn truncate_never_splits_a_multibyte_char() {
        // Each CJK code point costs a full token.
        assert_eq!(truncate_text_to_tokens("中文测试", 2), "中文");
        assert_eq!(truncate_text_to_tokens_from_end("中文测试", 2), "测试");
        // And a non-BMP code point counts once, not twice.
        assert_eq!(truncate_text_to_tokens("🙂🙂🙂", 2), "🙂🙂");
        assert_eq!(truncate_text_to_tokens_from_end("🙂🙂🙂", 2), "🙂🙂");
    }

    #[test]
    fn truncate_head_and_tail_partition_the_text() {
        let text = "abcdefghijklmnop"; // 16 ascii = 4 tokens
        let suffix = truncate_text_to_tokens_from_end(text, 1);
        assert_eq!(suffix, "mnop");
        assert_eq!(&text[..text.len() - suffix.len()], "abcdefghijkl");
    }

    // ── selection ─────────────────────────────────────────────────────────

    #[test]
    fn under_budget_keeps_everything_as_tail() {
        let messages = vec![user_msg("one"), user_msg("two")];
        let selection = select_compaction_user_messages(&messages, 1000, 100);
        assert!(!selection.elided);
        assert!(selection.head.is_empty());
        assert_eq!(selection.tail.len(), 2);
        assert_eq!(selection.omitted_tokens, 0);
    }

    #[test]
    fn over_budget_splits_head_and_tail_and_reports_omission() {
        // Each message: role "user" = 1 token + 40 ascii chars = 10 tokens → 11.
        let body = "a".repeat(40);
        let messages: Vec<_> = (0..10).map(|i| user_msg(&format!("{i}{body}"))).collect();
        let total: u64 = messages.iter().map(estimate_message_tokens).sum();
        let selection = select_compaction_user_messages(&messages, 40, 12);
        assert!(selection.elided);
        assert!(!selection.head.is_empty(), "head slice must survive");
        assert!(!selection.tail.is_empty(), "tail slice must survive");
        let kept: u64 =
            selection.head.iter().chain(selection.tail.iter()).map(estimate_message_tokens).sum();
        // The budget is approximate at the tail boundary: the partially-kept
        // message is truncated to fit by *text* tokens, then re-estimated as a
        // whole message, which re-adds its role overhead. TS overshoots
        // identically (`truncateTextToTokensFromEnd` feeding
        // `replaceMessageText`, priced by `estimateTokensForMessage`), so the
        // ceiling is the budget plus one message's role.
        let boundary_slack = estimate_tokens("user");
        assert!(kept <= 40 + boundary_slack, "kept {kept} overshot the budget by more than a role");
        assert!(kept > 40 - 12, "the tail budget should be substantially used");
        assert_eq!(selection.omitted_tokens, total - kept);
    }

    #[test]
    fn over_budget_keeps_the_newest_messages_in_the_tail() {
        let body = "a".repeat(40);
        let messages: Vec<_> = (0..10).map(|i| user_msg(&format!("{i}{body}"))).collect();
        let selection = select_compaction_user_messages(&messages, 40, 12);
        // the very last message must be present verbatim at the end of the tail
        let last_tail = selection.tail.last().expect("tail is non-empty");
        assert!(text_of(last_tail).starts_with('9'));
        // and the oldest must lead the head
        let first_head = selection.head.first().expect("head is non-empty");
        assert!(text_of(first_head).starts_with('0'));
    }

    #[test]
    fn boundary_message_is_split_between_tail_suffix_and_head_prefix() {
        // One huge message that cannot fit the tail budget whole.
        let messages = vec![user_msg(&"a".repeat(400))];
        let selection = select_compaction_user_messages(&messages, 40, 12);
        assert!(selection.elided);
        // The tail keeps a suffix...
        assert_eq!(selection.tail.len(), 1);
        let tail_text = text_of(&selection.tail[0]);
        assert!(!tail_text.is_empty() && tail_text.len() < 400);
        // ...and the dropped prefix is offered back to the head.
        assert_eq!(selection.head.len(), 1);
        let head_text = text_of(&selection.head[0]);
        assert!(!head_text.is_empty());
        assert!(head_text.len() + tail_text.len() < 400, "the middle must be dropped");
    }

    #[test]
    fn zero_head_budget_keeps_only_a_tail() {
        let body = "a".repeat(40);
        let messages: Vec<_> = (0..10).map(|i| user_msg(&format!("{i}{body}"))).collect();
        let selection = select_compaction_user_messages(&messages, 40, 0);
        assert!(selection.elided);
        assert!(selection.head.is_empty());
        assert!(!selection.tail.is_empty());
    }

    #[test]
    fn head_budget_is_clamped_to_the_total_budget() {
        let body = "a".repeat(40);
        let messages: Vec<_> = (0..10).map(|i| user_msg(&format!("{i}{body}"))).collect();
        // head_tokens > max_tokens → tail budget 0, everything goes to head
        let selection = select_compaction_user_messages(&messages, 20, 1000);
        assert!(selection.elided);
        assert!(selection.tail.is_empty());
        assert!(!selection.head.is_empty());
    }

    #[test]
    fn select_recent_keeps_the_newest_within_budget() {
        let body = "a".repeat(40); // 10 tokens + 1 role = 11
        let messages: Vec<_> = (0..5).map(|i| user_msg(&format!("{i}{body}"))).collect();
        let selected = select_recent_user_messages(&messages, 25);
        // two whole messages (22) then a truncated third
        assert!(selected.len() >= 2);
        assert!(text_of(selected.last().unwrap()).starts_with('4'));
    }

    // ── shape ─────────────────────────────────────────────────────────────

    #[test]
    fn shape_puts_the_summary_last_and_keeps_user_messages() {
        let history = vec![
            user_msg("first"),
            assistant_msg("reply"),
            user_msg("second"),
        ];
        let shape = build_context_compaction_shape(
            &history,
            &ContextCompactionShapeInput {
                summary: "the summary".to_string(),
                compacted_count: 3,
                tokens_before: 100,
                ..Default::default()
            },
        );
        assert_eq!(shape.messages.len(), 3); // two user messages + summary
        assert_eq!(text_of(&shape.messages[0]), "first");
        assert_eq!(text_of(&shape.messages[1]), "second");
        assert!(is_compaction_summary_message(&shape.messages[2]));
        assert_eq!(text_of(&shape.messages[2]), "the summary");
        assert_eq!(shape.kept_user_message_count, 2);
        assert_eq!(shape.kept_head_user_message_count, None);
        assert_eq!(shape.context_summary, "the summary");
    }

    #[test]
    fn shape_prefers_context_summary_over_summary_for_the_message_body() {
        let shape = build_context_compaction_shape(
            &[],
            &ContextCompactionShapeInput {
                summary: "model-facing".to_string(),
                context_summary: Some("context-facing".to_string()),
                compacted_count: 0,
                ..Default::default()
            },
        );
        assert_eq!(shape.summary, "model-facing");
        assert_eq!(shape.context_summary, "context-facing");
        assert_eq!(text_of(shape.messages.last().unwrap()), "context-facing");
    }

    #[test]
    fn shape_estimates_tokens_after_when_not_supplied() {
        let history = vec![user_msg("first")];
        let shape = build_context_compaction_shape(
            &history,
            &ContextCompactionShapeInput {
                summary: "sum".to_string(),
                compacted_count: 1,
                ..Default::default()
            },
        );
        let expected = estimate_tokens("sum") + estimate_messages_tokens(&[user_msg("first")]);
        assert_eq!(shape.tokens_after, expected);
    }

    #[test]
    fn shape_honours_supplied_accounting() {
        let shape = build_context_compaction_shape(
            &[user_msg("first")],
            &ContextCompactionShapeInput {
                summary: "sum".to_string(),
                compacted_count: 1,
                tokens_before: 999,
                tokens_after: Some(42),
                kept_user_message_count: Some(7),
                kept_head_user_message_count: Some(3),
                dropped_count: Some(5),
                ..Default::default()
            },
        );
        assert_eq!(shape.tokens_after, 42);
        assert_eq!(shape.kept_user_message_count, 7);
        assert_eq!(shape.kept_head_user_message_count, Some(3));
        assert_eq!(shape.dropped_count, Some(5));
        assert_eq!(shape.tokens_before, 999);
    }

    #[test]
    fn shape_splices_an_elision_note_between_head_and_tail() {
        let body = "a".repeat(400);
        let history: Vec<_> = (0..300).map(|i| user_msg(&format!("{i}{body}"))).collect();
        let shape = build_context_compaction_shape(
            &history,
            &ContextCompactionShapeInput {
                summary: "sum".to_string(),
                compacted_count: history.len(),
                ..Default::default()
            },
        );
        let elision_index = shape
            .messages
            .iter()
            .position(|m| {
                matches!(&m.origin, Some(MessageOrigin::Injection { variant })
                    if variant == COMPACTION_ELISION_VARIANT)
            })
            .expect("an elision note must be spliced in");
        assert!(elision_index > 0, "head must precede the note");
        assert!(elision_index < shape.messages.len() - 2, "tail must follow the note");
        assert_eq!(shape.kept_head_user_message_count, Some(elision_index));
        assert!(text_of(&shape.messages[elision_index]).contains("tokens in between were dropped"));
    }

    #[test]
    fn legacy_tail_shape_puts_the_summary_first_and_keeps_the_tail() {
        let history = vec![
            user_msg("dropped"),
            assistant_msg("dropped too"),
            user_msg("kept"),
            assistant_msg("kept too"),
        ];
        let shape = build_context_compaction_shape(
            &history,
            &ContextCompactionShapeInput {
                summary: "sum".to_string(),
                compacted_count: 2,
                legacy_tail: true,
                ..Default::default()
            },
        );
        assert_eq!(shape.messages.len(), 3);
        assert!(is_compaction_summary_message(&shape.messages[0]));
        assert_eq!(text_of(&shape.messages[1]), "kept");
        assert_eq!(text_of(&shape.messages[2]), "kept too");
        assert_eq!(shape.kept_user_message_count, 0);
        assert_eq!(shape.kept_head_user_message_count, None);
    }

    #[test]
    fn legacy_tail_shape_uses_the_supplied_summary_message() {
        let legacy = ContextMessage {
            role: "user".to_string(),
            content: vec![ContentPart::Text { text: "verbatim legacy".to_string() }],
            origin: Some(MessageOrigin::CompactionSummary),
            ..Default::default()
        };
        let shape = build_context_compaction_shape(
            &[user_msg("kept")],
            &ContextCompactionShapeInput {
                summary: "sum".to_string(),
                legacy_summary_message: Some(legacy),
                compacted_count: 0,
                legacy_tail: true,
                ..Default::default()
            },
        );
        assert_eq!(text_of(&shape.messages[0]), "verbatim legacy");
    }

    #[test]
    fn legacy_tail_shape_tolerates_an_out_of_range_compacted_count() {
        // A replayed record can name a count past the current history length.
        let shape = build_context_compaction_shape(
            &[user_msg("only")],
            &ContextCompactionShapeInput {
                summary: "sum".to_string(),
                compacted_count: 99,
                legacy_tail: true,
                ..Default::default()
            },
        );
        assert_eq!(shape.messages.len(), 1);
        assert!(is_compaction_summary_message(&shape.messages[0]));
    }

    #[test]
    fn summary_text_falls_back_when_the_summary_is_blank() {
        let text = build_compaction_summary_text("   ");
        assert!(text.starts_with(COMPACTION_SUMMARY_PREFIX));
        assert!(text.ends_with("(no summary available)"));
    }

    #[test]
    fn summary_text_trims_and_appends_the_body() {
        let text = build_compaction_summary_text("  did the thing  ");
        assert_eq!(text, format!("{COMPACTION_SUMMARY_PREFIX}\ndid the thing"));
    }
}
