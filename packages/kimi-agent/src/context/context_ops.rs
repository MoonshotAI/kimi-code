/// `contextMemory` Ops — pure history transforms behind the wire protocol's
/// `context.*` records.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/contextMemory/contextOps.ts`.
///
/// Every transform is total and deterministic: it either produces a new history
/// or leaves the input untouched. In particular `undo` is all-or-nothing — the
/// cut is computed first and applied only when the full requested count is
/// available, so a partially-satisfiable undo never leaves a truncated history
/// behind.
use crate::context::compaction_handoff::{
    build_context_compaction_shape, create_compaction_summary_message,
    ContextCompactionShapeInput,
};
use crate::context::types::{ContentPart, ContextMessage, MessageOrigin};

/// Injection variant popped when swarm mode exits.
pub const SWARM_MODE_INJECTION_VARIANT: &str = "swarm_mode";

/// Where an undo would cut the history, and what it would cost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UndoCut {
    /// Index of the oldest user prompt that would be removed, if any.
    /// `None` is TS's `cutIndex === -1` sentinel.
    pub cut_index: Option<usize>,
    /// How many real user prompts the walk found (capped at the request).
    pub removed_count: usize,
    /// Whether the walk halted on a compaction summary.
    pub stopped_at_compaction: bool,
}

/// Walk back over the history looking for `count` real user prompts.
///
/// Injections are transparent — they are neither counted nor a barrier. A
/// compaction summary *is* a barrier: history older than it no longer exists in
/// full, so undoing across it would silently discard the summary's coverage.
pub fn compute_undo_cut(state: &[ContextMessage], count: usize) -> UndoCut {
    let mut remaining = count;
    let mut cut_index: Option<usize> = None;
    let mut removed_count = 0usize;
    let mut stopped_at_compaction = false;

    let mut i = state.len();
    while i > 0 && remaining > 0 {
        i -= 1;
        let message = &state[i];
        if matches!(message.origin, Some(MessageOrigin::Injection { .. })) {
            continue;
        }
        if matches!(message.origin, Some(MessageOrigin::CompactionSummary)) {
            stopped_at_compaction = true;
            break;
        }
        if is_real_user_prompt(message) {
            remaining -= 1;
            removed_count += 1;
            cut_index = Some(i);
        }
    }

    UndoCut { cut_index, removed_count, stopped_at_compaction }
}

pub fn is_fully_undoable(cut: &UndoCut, count: usize) -> bool {
    cut.cut_index.is_some() && cut.removed_count >= count
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UndoUnavailableReason {
    Empty,
    CompactionBoundary,
    Insufficient,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UndoPrecheck {
    Ok,
    Unavailable { reason: UndoUnavailableReason, requested: usize, undoable: usize },
}

impl UndoPrecheck {
    pub fn is_ok(&self) -> bool {
        matches!(self, UndoPrecheck::Ok)
    }
}

pub fn precheck_undo(history: &[ContextMessage], count: usize) -> UndoPrecheck {
    let cut = compute_undo_cut(history, count);
    if is_fully_undoable(&cut, count) {
        return UndoPrecheck::Ok;
    }
    let reason = if cut.stopped_at_compaction {
        UndoUnavailableReason::CompactionBoundary
    } else if cut.removed_count == 0 {
        UndoUnavailableReason::Empty
    } else {
        UndoUnavailableReason::Insufficient
    };
    UndoPrecheck::Unavailable { reason, requested: count, undoable: cut.removed_count }
}

/// Render the user-facing explanation for an unavailable undo.
///
/// Returns `None` for [`UndoPrecheck::Ok`], which has nothing to explain.
pub fn format_undo_unavailable_message(precheck: &UndoPrecheck) -> Option<String> {
    match precheck {
        UndoPrecheck::Ok => None,
        UndoPrecheck::Unavailable { reason, requested, undoable } => Some(match reason {
            UndoUnavailableReason::Empty => "Nothing to undo: no user message to undo".to_string(),
            UndoUnavailableReason::CompactionBoundary => {
                "Nothing to undo: would cross a compaction boundary".to_string()
            }
            UndoUnavailableReason::Insufficient => format!(
                "Nothing to undo: only {undoable} of {requested} requested turn(s) available"
            ),
        }),
    }
}

/// Apply `context.undo`. Returns `None` when the history is unchanged.
pub fn apply_undo(state: &[ContextMessage], count: usize) -> Option<Vec<ContextMessage>> {
    if count == 0 || state.is_empty() {
        return None;
    }
    let cut = compute_undo_cut(state, count);
    if !is_fully_undoable(&cut, count) {
        return None;
    }
    let cut_index = cut.cut_index?;
    Some(state[..cut_index].to_vec())
}

/// Whether this message is a prompt the user actually typed.
///
/// An absent origin counts (histories written before origins were recorded);
/// a slash-invoked skill or plugin command counts; anything the model or the
/// runtime synthesised does not.
pub fn is_real_user_prompt(message: &ContextMessage) -> bool {
    if message.role != "user" {
        return false;
    }
    match &message.origin {
        None | Some(MessageOrigin::User) => true,
        Some(MessageOrigin::SkillActivation { trigger, .. })
        | Some(MessageOrigin::PluginCommand { trigger, .. }) => trigger == "user-slash",
        _ => false,
    }
}

/// Cross-model fold for `swarm_mode.exit`: drop the trailing swarm-mode
/// reminder if it is still the last message. Returns `None` when unchanged.
pub fn pop_swarm_mode_reminder(state: &[ContextMessage]) -> Option<Vec<ContextMessage>> {
    let last = state.last()?;
    match &last.origin {
        Some(MessageOrigin::Injection { variant }) if variant == SWARM_MODE_INJECTION_VARIANT => {
            Some(state[..state.len() - 1].to_vec())
        }
        _ => None,
    }
}

// ── `context.apply_compaction` record parsing ─────────────────────────────
//
// The on-disk record has three historical shapes (summary-as-string,
// contextSummary-as-string, and the oldest summary-as-message + `count`), so
// every field is read defensively from an untyped object rather than
// deserialised into one struct.

fn field<'a>(record: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    record.get(key)
}

fn read_optional_number(record: &serde_json::Value, key: &str) -> Option<u64> {
    field(record, key)?.as_f64().map(|n| if n < 0.0 { 0 } else { n as u64 })
}

fn read_optional_usize(record: &serde_json::Value, key: &str) -> Option<usize> {
    read_optional_number(record, key).map(|n| n as usize)
}

fn read_optional_string(record: &serde_json::Value, key: &str) -> Option<String> {
    field(record, key)?.as_str().map(str::to_string)
}

fn read_optional_bool(record: &serde_json::Value, key: &str) -> Option<bool> {
    field(record, key)?.as_bool()
}

/// TS `isContextMessage`: an object with a string `role` and an array `content`.
fn is_context_message(value: Option<&serde_json::Value>) -> bool {
    let Some(value) = value else { return false };
    let Some(object) = value.as_object() else { return false };
    object.get("role").and_then(|r| r.as_str()).is_some()
        && object.get("content").map(|c| c.is_array()).unwrap_or(false)
}

/// Deserialise a stored message, falling back to a minimal role + text
/// reconstruction when the record carries fields this crate does not model
/// (e.g. an origin kind added by a newer writer).
fn parse_context_message(value: &serde_json::Value) -> Option<ContextMessage> {
    if !is_context_message(Some(value)) {
        return None;
    }
    if let Ok(message) = serde_json::from_value::<ContextMessage>(value.clone()) {
        return Some(message);
    }
    let role = value.get("role")?.as_str()?.to_string();
    let content = value
        .get("content")?
        .as_array()?
        .iter()
        .filter_map(|part| {
            let text = part.get("text")?.as_str()?;
            Some(ContentPart::Text { text: text.to_string() })
        })
        .collect();
    Some(ContextMessage { role, content, ..Default::default() })
}

fn text_of(message: &ContextMessage) -> String {
    let mut text = String::new();
    for part in &message.content {
        if let ContentPart::Text { text: body } = part {
            text.push_str(body);
        }
    }
    text
}

/// Read `compactedCount`, accepting the legacy `count` spelling.
pub fn read_context_compacted_count(record: &serde_json::Value) -> Result<usize, String> {
    if let Some(count) = read_optional_usize(record, "compactedCount") {
        return Ok(count);
    }
    if let Some(count) = read_optional_usize(record, "count") {
        return Ok(count);
    }
    Err("Invalid context.apply_compaction record: missing compactedCount".to_string())
}

/// Read the summary as a ready-to-store message.
pub fn read_context_compaction_summary(
    record: &serde_json::Value,
) -> Result<ContextMessage, String> {
    if let Some(context_summary) = read_optional_string(record, "contextSummary") {
        return Ok(create_compaction_summary_message(&context_summary));
    }
    if let Some(summary) = read_optional_string(record, "summary") {
        return Ok(create_compaction_summary_message(&summary));
    }
    if let Some(value) = field(record, "summary") {
        if let Some(message) = parse_context_message(value) {
            return Ok(message);
        }
    }
    Err("Invalid context.apply_compaction record: missing summary".to_string())
}

fn read_context_compaction_raw_summary(record: &serde_json::Value) -> Result<String, String> {
    if let Some(summary) = read_optional_string(record, "summary") {
        return Ok(summary);
    }
    if let Some(context_summary) = read_optional_string(record, "contextSummary") {
        return Ok(context_summary);
    }
    if let Some(value) = field(record, "summary") {
        if let Some(message) = parse_context_message(value) {
            return Ok(text_of(&message));
        }
    }
    Err("Invalid context.apply_compaction record: missing summary".to_string())
}

/// Normalise a stored record into the shape builder's input.
pub fn read_context_compaction_shape_input(
    record: &serde_json::Value,
) -> Result<ContextCompactionShapeInput, String> {
    let kept_user_message_count = read_optional_usize(record, "keptUserMessageCount");
    let legacy_summary_message = field(record, "summary").and_then(parse_context_message);
    Ok(ContextCompactionShapeInput {
        summary: read_context_compaction_raw_summary(record)?,
        legacy_summary_message,
        context_summary: read_optional_string(record, "contextSummary"),
        compacted_count: read_context_compacted_count(record)?,
        tokens_before: read_optional_number(record, "tokensBefore").unwrap_or(0),
        tokens_after: read_optional_number(record, "tokensAfter"),
        kept_user_message_count,
        kept_head_user_message_count: read_optional_usize(record, "keptHeadUserMessageCount"),
        dropped_count: read_optional_number(record, "droppedCount").map(|n| n as u32),
        // A record that never named a kept-user count predates the head/tail
        // shape, so it must replay as the legacy summary-first tail.
        legacy_tail: read_optional_bool(record, "legacyTail")
            .unwrap_or(kept_user_message_count.is_none()),
    })
}

/// Apply a stored `context.apply_compaction` record to a history.
pub fn apply_context_compaction_record(
    state: &[ContextMessage],
    record: &serde_json::Value,
) -> Result<Vec<ContextMessage>, String> {
    let input = read_context_compaction_shape_input(record)?;
    Ok(build_context_compaction_shape(state, &input).messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(role: &str, text: &str, origin: Option<MessageOrigin>) -> ContextMessage {
        ContextMessage {
            role: role.to_string(),
            content: vec![ContentPart::Text { text: text.to_string() }],
            origin,
            ..Default::default()
        }
    }

    fn user(text: &str) -> ContextMessage {
        msg("user", text, Some(MessageOrigin::User))
    }

    fn assistant(text: &str) -> ContextMessage {
        msg("assistant", text, None)
    }

    fn injection(text: &str, variant: &str) -> ContextMessage {
        msg("user", text, Some(MessageOrigin::Injection { variant: variant.to_string() }))
    }

    fn texts(messages: &[ContextMessage]) -> Vec<String> {
        messages.iter().map(text_of).collect()
    }

    // ── is_real_user_prompt ───────────────────────────────────────────────

    #[test]
    fn origin_less_user_message_is_a_real_prompt() {
        assert!(is_real_user_prompt(&msg("user", "hi", None)));
    }

    #[test]
    fn assistant_is_never_a_real_prompt() {
        assert!(!is_real_user_prompt(&assistant("hi")));
        // even with a user origin, which cannot legitimately happen
        assert!(!is_real_user_prompt(&msg("assistant", "hi", Some(MessageOrigin::User))));
    }

    #[test]
    fn slash_skill_is_a_real_prompt_but_model_tool_is_not() {
        let slash = msg(
            "user",
            "/do",
            Some(MessageOrigin::SkillActivation {
                activation_id: "a".to_string(),
                skill_name: "s".to_string(),
                skill_args: None,
                trigger: "user-slash".to_string(),
            }),
        );
        let model = msg(
            "user",
            "do",
            Some(MessageOrigin::SkillActivation {
                activation_id: "a".to_string(),
                skill_name: "s".to_string(),
                skill_args: None,
                trigger: "model-tool".to_string(),
            }),
        );
        assert!(is_real_user_prompt(&slash));
        assert!(!is_real_user_prompt(&model));
    }

    #[test]
    fn synthetic_user_messages_are_not_real_prompts() {
        assert!(!is_real_user_prompt(&injection("reminder", "x")));
        assert!(!is_real_user_prompt(&msg(
            "user",
            "hook",
            Some(MessageOrigin::HookResult { event: "e".to_string(), blocked: None })
        )));
    }

    // ── compute_undo_cut ──────────────────────────────────────────────────

    #[test]
    fn undo_cut_finds_the_last_user_prompt() {
        let history = vec![user("first"), assistant("a"), user("second"), assistant("b")];
        let cut = compute_undo_cut(&history, 1);
        assert_eq!(cut.cut_index, Some(2));
        assert_eq!(cut.removed_count, 1);
        assert!(!cut.stopped_at_compaction);
        assert!(is_fully_undoable(&cut, 1));
    }

    #[test]
    fn undo_cut_walks_back_multiple_turns() {
        let history = vec![user("first"), assistant("a"), user("second"), assistant("b")];
        let cut = compute_undo_cut(&history, 2);
        assert_eq!(cut.cut_index, Some(0));
        assert_eq!(cut.removed_count, 2);
        assert!(is_fully_undoable(&cut, 2));
    }

    #[test]
    fn undo_cut_treats_injections_as_transparent() {
        let history = vec![user("first"), injection("reminder", "goal"), assistant("a")];
        let cut = compute_undo_cut(&history, 1);
        assert_eq!(cut.cut_index, Some(0));
        assert_eq!(cut.removed_count, 1);
    }

    #[test]
    fn undo_cut_stops_at_a_compaction_summary() {
        let history = vec![
            user("ancient"),
            msg("user", "summary", Some(MessageOrigin::CompactionSummary)),
            assistant("a"),
        ];
        let cut = compute_undo_cut(&history, 1);
        assert!(cut.stopped_at_compaction);
        assert_eq!(cut.removed_count, 0);
        assert_eq!(cut.cut_index, None);
        assert!(!is_fully_undoable(&cut, 1));
    }

    #[test]
    fn undo_cut_reports_partial_availability() {
        let history = vec![user("only"), assistant("a")];
        let cut = compute_undo_cut(&history, 3);
        assert_eq!(cut.removed_count, 1);
        assert_eq!(cut.cut_index, Some(0));
        assert!(!is_fully_undoable(&cut, 3));
    }

    #[test]
    fn undo_cut_on_an_empty_history() {
        let cut = compute_undo_cut(&[], 1);
        assert_eq!(cut.cut_index, None);
        assert_eq!(cut.removed_count, 0);
        assert!(!is_fully_undoable(&cut, 1));
    }

    // ── apply_undo ────────────────────────────────────────────────────────

    #[test]
    fn undo_truncates_at_the_cut() {
        let history = vec![user("first"), assistant("a"), user("second"), assistant("b")];
        let next = apply_undo(&history, 1).expect("undo applies");
        assert_eq!(texts(&next), vec!["first", "a"]);
    }

    #[test]
    fn undo_is_all_or_nothing_when_not_enough_turns_exist() {
        // Regression guard: a partially-satisfiable undo must leave the history
        // completely untouched rather than removing what it could find.
        let history = vec![user("only"), assistant("a")];
        assert!(apply_undo(&history, 3).is_none());
    }

    #[test]
    fn undo_refuses_to_cross_a_compaction_boundary() {
        let history = vec![
            msg("user", "summary", Some(MessageOrigin::CompactionSummary)),
            assistant("a"),
        ];
        assert!(apply_undo(&history, 1).is_none());
    }

    #[test]
    fn undo_of_zero_or_on_empty_history_is_a_no_op() {
        let history = vec![user("first")];
        assert!(apply_undo(&history, 0).is_none());
        assert!(apply_undo(&[], 1).is_none());
    }

    #[test]
    fn undo_removes_trailing_injections_along_with_the_turn() {
        let history = vec![user("first"), assistant("a"), user("second"), injection("r", "goal")];
        let next = apply_undo(&history, 1).expect("undo applies");
        assert_eq!(texts(&next), vec!["first", "a"]);
    }

    // ── precheck ──────────────────────────────────────────────────────────

    #[test]
    fn precheck_ok_when_fully_undoable() {
        let history = vec![user("first"), assistant("a")];
        assert!(precheck_undo(&history, 1).is_ok());
        assert_eq!(format_undo_unavailable_message(&UndoPrecheck::Ok), None);
    }

    #[test]
    fn precheck_reports_empty() {
        let precheck = precheck_undo(&[assistant("a")], 1);
        assert_eq!(
            precheck,
            UndoPrecheck::Unavailable {
                reason: UndoUnavailableReason::Empty,
                requested: 1,
                undoable: 0,
            }
        );
        assert_eq!(
            format_undo_unavailable_message(&precheck).unwrap(),
            "Nothing to undo: no user message to undo"
        );
    }

    #[test]
    fn precheck_reports_the_compaction_boundary() {
        let history = vec![msg("user", "s", Some(MessageOrigin::CompactionSummary))];
        let precheck = precheck_undo(&history, 1);
        assert!(matches!(
            precheck,
            UndoPrecheck::Unavailable { reason: UndoUnavailableReason::CompactionBoundary, .. }
        ));
        assert_eq!(
            format_undo_unavailable_message(&precheck).unwrap(),
            "Nothing to undo: would cross a compaction boundary"
        );
    }

    #[test]
    fn precheck_reports_insufficient_turns() {
        let history = vec![user("only"), assistant("a")];
        let precheck = precheck_undo(&history, 3);
        assert_eq!(
            precheck,
            UndoPrecheck::Unavailable {
                reason: UndoUnavailableReason::Insufficient,
                requested: 3,
                undoable: 1,
            }
        );
        assert_eq!(
            format_undo_unavailable_message(&precheck).unwrap(),
            "Nothing to undo: only 1 of 3 requested turn(s) available"
        );
    }

    // ── swarm pop ─────────────────────────────────────────────────────────

    #[test]
    fn swarm_pop_removes_a_trailing_swarm_reminder() {
        let history = vec![user("first"), injection("swarm on", SWARM_MODE_INJECTION_VARIANT)];
        let next = pop_swarm_mode_reminder(&history).expect("pops");
        assert_eq!(texts(&next), vec!["first"]);
    }

    #[test]
    fn swarm_pop_ignores_other_trailing_messages() {
        assert!(pop_swarm_mode_reminder(&[user("first")]).is_none());
        assert!(pop_swarm_mode_reminder(&[injection("other", "goal")]).is_none());
        assert!(pop_swarm_mode_reminder(&[]).is_none());
    }

    #[test]
    fn swarm_pop_only_looks_at_the_last_message() {
        let history =
            vec![injection("swarm on", SWARM_MODE_INJECTION_VARIANT), user("later")];
        assert!(pop_swarm_mode_reminder(&history).is_none());
    }

    // ── record parsing ────────────────────────────────────────────────────

    #[test]
    fn reads_compacted_count_from_either_spelling() {
        assert_eq!(read_context_compacted_count(&json!({ "compactedCount": 7 })).unwrap(), 7);
        assert_eq!(read_context_compacted_count(&json!({ "count": 4 })).unwrap(), 4);
        assert!(read_context_compacted_count(&json!({})).is_err());
    }

    #[test]
    fn reads_summary_as_a_message_from_each_shape() {
        let from_context = read_context_compaction_summary(&json!({
            "contextSummary": "ctx", "summary": "model", "compactedCount": 1
        }))
        .unwrap();
        assert_eq!(text_of(&from_context), "ctx");

        let from_summary =
            read_context_compaction_summary(&json!({ "summary": "model", "compactedCount": 1 }))
                .unwrap();
        assert_eq!(text_of(&from_summary), "model");

        let legacy = read_context_compaction_summary(&json!({
            "summary": { "role": "user", "content": [{ "type": "text", "text": "legacy" }] },
            "count": 1
        }))
        .unwrap();
        assert_eq!(text_of(&legacy), "legacy");

        assert!(read_context_compaction_summary(&json!({ "compactedCount": 1 })).is_err());
    }

    #[test]
    fn shape_input_defaults_legacy_tail_from_the_kept_count() {
        let modern = read_context_compaction_shape_input(&json!({
            "summary": "s", "compactedCount": 2, "keptUserMessageCount": 3
        }))
        .unwrap();
        assert!(!modern.legacy_tail);

        let legacy =
            read_context_compaction_shape_input(&json!({ "summary": "s", "compactedCount": 2 }))
                .unwrap();
        assert!(legacy.legacy_tail);
    }

    #[test]
    fn shape_input_honours_an_explicit_legacy_tail_flag() {
        let forced = read_context_compaction_shape_input(&json!({
            "summary": "s", "compactedCount": 2, "keptUserMessageCount": 3, "legacyTail": true
        }))
        .unwrap();
        assert!(forced.legacy_tail);
    }

    #[test]
    fn shape_input_reads_the_accounting_fields() {
        let input = read_context_compaction_shape_input(&json!({
            "summary": "s",
            "contextSummary": "c",
            "compactedCount": 2,
            "tokensBefore": 500,
            "tokensAfter": 120,
            "keptUserMessageCount": 3,
            "keptHeadUserMessageCount": 1,
            "droppedCount": 9
        }))
        .unwrap();
        assert_eq!(input.summary, "s");
        assert_eq!(input.context_summary.as_deref(), Some("c"));
        assert_eq!(input.tokens_before, 500);
        assert_eq!(input.tokens_after, Some(120));
        assert_eq!(input.kept_user_message_count, Some(3));
        assert_eq!(input.kept_head_user_message_count, Some(1));
        assert_eq!(input.dropped_count, Some(9));
    }

    #[test]
    fn shape_input_falls_back_to_context_summary_for_the_raw_summary() {
        let input = read_context_compaction_shape_input(&json!({
            "contextSummary": "only-context", "compactedCount": 1
        }))
        .unwrap();
        assert_eq!(input.summary, "only-context");
    }

    #[test]
    fn shape_input_derives_the_raw_summary_from_a_legacy_message() {
        let input = read_context_compaction_shape_input(&json!({
            "summary": { "role": "user", "content": [
                { "type": "text", "text": "part one " },
                { "type": "text", "text": "part two" }
            ]},
            "count": 1
        }))
        .unwrap();
        assert_eq!(input.summary, "part one part two");
        assert!(input.legacy_summary_message.is_some());
        assert!(input.legacy_tail);
    }

    #[test]
    fn shape_input_rejects_a_record_with_no_summary() {
        assert!(read_context_compaction_shape_input(&json!({ "compactedCount": 1 })).is_err());
    }

    #[test]
    fn applying_a_modern_record_keeps_user_messages_and_appends_the_summary() {
        let history = vec![user("first"), assistant("a"), user("second")];
        let messages = apply_context_compaction_record(
            &history,
            &json!({ "summary": "sum", "compactedCount": 3, "keptUserMessageCount": 2 }),
        )
        .unwrap();
        assert_eq!(texts(&messages), vec!["first", "second", "sum"]);
    }

    #[test]
    fn applying_a_legacy_record_prepends_the_summary_and_keeps_the_tail() {
        let history = vec![user("first"), assistant("a"), user("second")];
        let messages = apply_context_compaction_record(
            &history,
            &json!({ "summary": "sum", "compactedCount": 2 }),
        )
        .unwrap();
        assert_eq!(texts(&messages), vec!["sum", "second"]);
    }

    #[test]
    fn parse_context_message_rejects_non_messages() {
        assert!(parse_context_message(&json!("just a string")).is_none());
        assert!(parse_context_message(&json!({ "role": "user" })).is_none());
        assert!(parse_context_message(&json!({ "content": [] })).is_none());
    }

    #[test]
    fn parse_context_message_falls_back_on_an_unknown_origin_kind() {
        // A newer writer may record an origin this crate does not model; the
        // message must still round-trip its role and text.
        let value = json!({
            "role": "user",
            "content": [{ "type": "text", "text": "hello" }],
            "origin": { "kind": "some_future_kind", "extra": 1 }
        });
        let message = parse_context_message(&value).expect("falls back");
        assert_eq!(message.role, "user");
        assert_eq!(text_of(&message), "hello");
    }
}
