/// ContextMemory — the per-agent conversation history.
///
/// Corresponds to `AgentContextMemoryService`
/// (`packages/agent-core-v2/src/agent/contextMemory/contextMemoryService.ts`).
///
/// This type is the sole live mutation gateway for the history. It owns the
/// message vector plus the loop-event fold state, and mirrors the TS service's
/// division of labour:
///   - the *reduction* lives in [`crate::context::loop_event_fold`] and
///     [`crate::context::context_ops`] as pure transforms,
///   - the *accounting* (the measured token prefix) is rebased here alongside
///     every mutation that changes it — `clear` resets it, `apply_compaction`
///     adopts `tokens_after`, `undo` rebases it, and plain appends leave it
///     alone because new messages are the unmeasured tail.
use crate::context::compaction_handoff::{
    build_context_compaction_shape, ContextCompactionShape, ContextCompactionShapeInput,
};
use crate::context::context_ops::{
    apply_undo, compute_undo_cut, format_undo_unavailable_message, precheck_undo,
    pop_swarm_mode_reminder, UndoCut, UndoPrecheck,
};
use crate::context::loop_event_fold::{
    fold_append_message, fold_loop_event, FoldCtx, LoopRecordedEvent, LoopToolOutput,
};
use crate::context::projector;
use crate::context::tokenizer;
use crate::context::types::*;

/// Token usage reported by a provider at the end of a step.
#[derive(Debug, Clone, Default)]
pub struct StepUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_read_tokens: Option<u32>,
    pub cache_creation_tokens: Option<u32>,
}

impl StepUsage {
    fn total(&self) -> u64 {
        self.input_tokens as u64
            + self.output_tokens as u64
            + self.cache_read_tokens.unwrap_or(0) as u64
            + self.cache_creation_tokens.unwrap_or(0) as u64
    }
}

/// Replacement payload for [`ContextMemory::replace_tool_result`].
pub struct ToolResultReplacement {
    pub output: LoopToolOutput,
    pub is_error: Option<bool>,
    pub note: Option<String>,
}

/// A splice applied to the history, published so subscribers observe the same
/// change regardless of which Op produced it (TS: the `context.spliced` event).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextSplice {
    pub start: usize,
    pub delete_count: usize,
    pub inserted_count: usize,
    pub tokens: Option<u64>,
}

pub struct ContextMemory {
    history: Vec<ContextMessage>,
    fold: FoldCtx,
    /// Token count for the measured prefix.
    token_count: u64,
    /// Length of the prefix `token_count` covers.
    token_count_covered_count: usize,
    /// Timestamp of the last assistant message pushed.
    last_assistant_at: Option<i64>,
}

impl ContextMemory {
    pub fn new() -> Self {
        Self {
            history: Vec::new(),
            fold: FoldCtx::new(),
            token_count: 0,
            token_count_covered_count: 0,
            last_assistant_at: None,
        }
    }

    // ── Getters ───────────────────────────────────────────────────────────

    pub fn token_count(&self) -> u64 {
        self.token_count
    }

    /// The measured prefix plus an estimate for the unmeasured tail.
    pub fn token_count_with_pending(&self) -> u64 {
        let covered = self.token_count_covered_count.min(self.history.len());
        self.token_count + tokenizer::estimate_messages_tokens(&self.history[covered..])
    }

    pub fn history(&self) -> &[ContextMessage] {
        &self.history
    }

    pub fn len(&self) -> usize {
        self.history.len()
    }

    pub fn is_empty(&self) -> bool {
        self.history.is_empty()
    }

    pub fn last_assistant_at(&self) -> Option<i64> {
        self.last_assistant_at
    }

    pub fn has_open_tool_exchange(&self) -> bool {
        self.fold.has_open_tool_exchange()
    }

    pub fn pending_tool_result_ids(&self) -> &[String] {
        self.fold.pending_ids()
    }

    pub fn data(&self) -> AgentContextData {
        AgentContextData { history: self.history.clone(), token_count: self.token_count }
    }

    // ── Appending ─────────────────────────────────────────────────────────

    /// Append a user message. An empty content list is ignored.
    pub fn append_user_message(&mut self, content: &[ContentPart], origin: MessageOrigin) {
        if content.is_empty() {
            return;
        }
        self.append_message(ContextMessage {
            role: "user".to_string(),
            content: content.to_vec(),
            tool_calls: vec![],
            origin: Some(origin),
            ..Default::default()
        });
    }

    /// Append a `<system-reminder>`-wrapped note as a user message.
    pub fn append_system_reminder(&mut self, content: &str, origin: MessageOrigin) {
        let text = format!("<system-reminder>\n{content}\n</system-reminder>");
        self.append_message(ContextMessage {
            role: "user".to_string(),
            content: vec![ContentPart::Text { text }],
            tool_calls: vec![],
            origin: Some(origin),
            ..Default::default()
        });
    }

    /// Append a message, deferring it when a tool exchange is still open.
    ///
    /// Returns the splice when the message landed in the history, `None` when
    /// it was deferred.
    pub fn append_message(&mut self, message: ContextMessage) -> Option<ContextSplice> {
        let start = self.history.len();
        let is_assistant = message.role == "assistant";
        let before = self.history.len();
        if !fold_append_message(&mut self.history, &mut self.fold, message) {
            return None;
        }
        if is_assistant {
            self.touch_last_assistant();
        }
        Some(ContextSplice {
            start,
            delete_count: 0,
            inserted_count: self.history.len() - before,
            tokens: None,
        })
    }

    /// Fold a loop event into the history. Returns `true` when it changed.
    pub fn append_loop_event(&mut self, event: &LoopRecordedEvent) -> bool {
        let changed = fold_loop_event(&mut self.history, &mut self.fold, event);
        if changed && matches!(event, LoopRecordedEvent::StepBegin { .. }) {
            self.touch_last_assistant();
        }
        changed
    }

    /// Adopt a provider-reported usage total as the measured prefix.
    ///
    /// Kept separate from the fold: the reduction must stay pure so that live
    /// dispatch and replay produce identical histories, while usage is only
    /// available on the live path.
    pub fn record_step_usage(&mut self, usage: &StepUsage) {
        let total = usage.total();
        if total > 0 {
            self.token_count = total;
        } else {
            let covered = self.token_count_covered_count.min(self.history.len());
            self.token_count += tokenizer::estimate_messages_tokens(&self.history[covered..]);
        }
        self.token_count_covered_count = self.history.len();
    }

    /// Replace a recorded tool result — used when a speculative prediction is
    /// superseded by the real result. Returns `true` when a result was found.
    pub fn replace_tool_result(
        &mut self,
        tool_call_id: &str,
        result: ToolResultReplacement,
    ) -> bool {
        let content = match result.output {
            LoopToolOutput::Text(text) => vec![ContentPart::Text { text }],
            LoopToolOutput::Parts(parts) => parts,
        };
        for message in self.history.iter_mut().rev() {
            if message.role == "tool" && message.tool_call_id.as_deref() == Some(tool_call_id) {
                message.content = content;
                message.tool_calls = Vec::new();
                message.is_error = result.is_error;
                message.note = result.note;
                return true;
            }
        }
        false
    }

    // ── History rewrites ──────────────────────────────────────────────────

    /// Drop the whole history and reset all accounting.
    pub fn clear(&mut self) -> Option<ContextSplice> {
        let delete_count = self.history.len();
        if delete_count == 0 {
            return None;
        }
        self.history.clear();
        self.fold.reset();
        self.token_count = 0;
        self.token_count_covered_count = 0;
        self.last_assistant_at = None;
        Some(ContextSplice { start: 0, delete_count, inserted_count: 0, tokens: Some(0) })
    }

    /// Where an undo of `count` turns would cut, without applying it.
    pub fn undo_cut(&self, count: usize) -> UndoCut {
        compute_undo_cut(&self.history, count)
    }

    /// Whether an undo of `count` turns can be satisfied in full.
    pub fn precheck_undo(&self, count: usize) -> UndoPrecheck {
        precheck_undo(&self.history, count)
    }

    /// Explain why an undo of `count` turns is unavailable, if it is.
    pub fn undo_unavailable_message(&self, count: usize) -> Option<String> {
        format_undo_unavailable_message(&self.precheck_undo(count))
    }

    /// Undo the last `count` user turns.
    ///
    /// All-or-nothing: when fewer than `count` turns are available, or the walk
    /// would cross a compaction boundary, the history is left untouched. The
    /// returned [`UndoCut`] always describes what *would* have happened, so
    /// callers can report the shortfall.
    pub fn undo(&mut self, count: usize) -> UndoCut {
        let cut = compute_undo_cut(&self.history, count);
        let Some(next) = apply_undo(&self.history, count) else {
            return cut;
        };
        let removed = self.history.len() - next.len();
        let cut_index = next.len();
        self.history = next;
        self.fold.reset();
        self.rebase_measured_prefix(cut_index);
        let _ = removed;
        cut
    }

    /// Drop a trailing swarm-mode reminder, if present.
    pub fn pop_swarm_mode_reminder(&mut self) -> Option<ContextSplice> {
        let next = pop_swarm_mode_reminder(&self.history)?;
        let start = next.len();
        self.history = next;
        self.fold.reset();
        self.rebase_measured_prefix(start);
        Some(ContextSplice { start, delete_count: 1, inserted_count: 0, tokens: None })
    }

    /// Rewrite the history into its post-compaction shape.
    pub fn apply_compaction(
        &mut self,
        input: &ContextCompactionShapeInput,
    ) -> ContextCompactionShape {
        let shape = build_context_compaction_shape(&self.history, input);
        let delete_count = self.history.len();
        self.history = shape.messages.clone();
        self.fold.reset();
        self.token_count = shape.tokens_after;
        self.token_count_covered_count = self.history.len();
        let _ = ContextSplice {
            start: 0,
            delete_count,
            inserted_count: self.history.len(),
            tokens: Some(shape.tokens_after),
        };
        shape
    }

    /// Import an external transcript as a single user message.
    pub fn import_context(
        &mut self,
        content: &str,
        source: &str,
        max_tokens: Option<u64>,
    ) -> Result<(), String> {
        if content.trim().is_empty() {
            return Err("Imported context cannot be empty".to_string());
        }
        if source.trim().is_empty() {
            return Err("Imported context source cannot be empty".to_string());
        }

        let message = ContextMessage {
            role: "user".to_string(),
            content: vec![
                ContentPart::Text {
                    text: format!(
                        "<system>The user has imported context from {source}. \
                         This is a prior conversation history that may be relevant to the current session. \
                         Please review this context and use it to inform your responses.</system>"
                    ),
                },
                ContentPart::Text {
                    text: format!("<imported_context source=\"{source}\">\n{content}\n</imported_context>"),
                },
            ],
            tool_calls: vec![],
            origin: Some(MessageOrigin::User),
            ..Default::default()
        };

        let import_tokens = tokenizer::estimate_message_tokens(&message);
        let total = self.token_count_with_pending() + import_tokens;
        if let Some(max) = max_tokens {
            if max > 0 && total > max {
                return Err(format!(
                    "import would exceed the context limit: {total} > {max}"
                ));
            }
        }
        self.append_message(message);
        self.update_token_count(total);
        Ok(())
    }

    /// Adopt an externally measured token count for the whole history.
    pub fn update_token_count(&mut self, token_count: u64) {
        self.token_count = token_count;
        self.token_count_covered_count = self.history.len();
    }

    // ── Projection ────────────────────────────────────────────────────────

    pub fn project(&self, options: &ProjectOptions) -> Vec<ContextMessage> {
        projector::project(&self.history, options)
    }

    pub fn messages(&self) -> Vec<ContextMessage> {
        self.project(&ProjectOptions { drop_orphan_results: true, ..Default::default() })
    }

    pub fn strict_messages(&self) -> Vec<ContextMessage> {
        self.project(&ProjectOptions {
            synthesize_missing: true,
            drop_orphan_results: true,
            dedupe_duplicate_tool_calls: true,
            drop_leading_non_user: true,
            merge_consecutive_assistants: true,
            ..Default::default()
        })
    }

    // ── Teardown ──────────────────────────────────────────────────────────

    /// Settle whatever the last session left open: close any dangling tool
    /// exchange and seal or drop the partial assistant.
    pub fn finish_resume(&mut self) {
        self.append_loop_event(&LoopRecordedEvent::StepEnd { uuid: String::new() });
    }

    /// Close an abandoned tool exchange at turn teardown, returning how many
    /// interrupted results were written.
    pub fn close_abandoned_tool_exchange(&mut self) -> usize {
        let pending = self.fold.pending_ids().len();
        if pending == 0 {
            return 0;
        }
        self.append_loop_event(&LoopRecordedEvent::StepEnd { uuid: String::new() });
        pending
    }

    // ── Private helpers ───────────────────────────────────────────────────

    fn touch_last_assistant(&mut self) {
        self.last_assistant_at = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        );
    }

    /// Re-measure the prefix after a truncation.
    ///
    /// TS only rebases when the measured aggregate actually extends past the
    /// cut (`sizeOpsForCut`); a measured prefix already shorter than the cut is
    /// still valid and re-estimating it would replace a real measurement with a
    /// heuristic.
    fn rebase_measured_prefix(&mut self, cut_index: usize) {
        if self.token_count_covered_count <= cut_index {
            return;
        }
        self.token_count_covered_count = cut_index;
        self.token_count = tokenizer::estimate_messages_tokens(&self.history[..cut_index]);
    }
}

impl Default for ContextMemory {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::loop_event_fold::{LoopToolResult, TOOL_INTERRUPTED_ON_RESUME_OUTPUT};

    fn text_part(text: &str) -> ContentPart {
        ContentPart::Text { text: text.to_string() }
    }

    fn text_of(message: &ContextMessage) -> String {
        message
            .content
            .iter()
            .filter_map(|p| match p {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }

    fn texts(ctx: &ContextMemory) -> Vec<String> {
        ctx.history().iter().map(text_of).collect()
    }

    fn roles(ctx: &ContextMemory) -> Vec<&str> {
        ctx.history().iter().map(|m| m.role.as_str()).collect()
    }

    fn user(ctx: &mut ContextMemory, text: &str) {
        ctx.append_user_message(&[text_part(text)], MessageOrigin::User);
    }

    fn begin(ctx: &mut ContextMemory, uuid: &str) {
        ctx.append_loop_event(&LoopRecordedEvent::StepBegin { uuid: uuid.to_string() });
    }

    fn end(ctx: &mut ContextMemory, uuid: &str) {
        ctx.append_loop_event(&LoopRecordedEvent::StepEnd { uuid: uuid.to_string() });
    }

    fn say(ctx: &mut ContextMemory, step: &str, text: &str) {
        ctx.append_loop_event(&LoopRecordedEvent::ContentPart {
            step_uuid: step.to_string(),
            part: text_part(text),
        });
    }

    fn call(ctx: &mut ContextMemory, step: &str, id: &str) {
        ctx.append_loop_event(&LoopRecordedEvent::ToolCall {
            step_uuid: step.to_string(),
            tool_call_id: id.to_string(),
            name: "read".to_string(),
            args: None,
            extras: None,
        });
    }

    fn tool_result(ctx: &mut ContextMemory, id: &str, body: &str) {
        ctx.append_loop_event(&LoopRecordedEvent::ToolResult {
            tool_call_id: id.to_string(),
            result: LoopToolResult {
                output: LoopToolOutput::Text(body.to_string()),
                is_error: None,
                note: None,
            },
        });
    }

    #[test]
    fn new_context_is_empty() {
        let ctx = ContextMemory::new();
        assert_eq!(ctx.token_count(), 0);
        assert!(ctx.is_empty());
        assert!(ctx.history().is_empty());
    }

    #[test]
    fn append_user_message_records_the_origin() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "hello");
        assert_eq!(ctx.len(), 1);
        assert_eq!(ctx.history()[0].role, "user");
        assert!(matches!(ctx.history()[0].origin, Some(MessageOrigin::User)));
    }

    #[test]
    fn append_user_message_ignores_empty_content() {
        let mut ctx = ContextMemory::new();
        ctx.append_user_message(&[], MessageOrigin::User);
        assert!(ctx.is_empty());
    }

    #[test]
    fn append_system_reminder_wraps_the_body() {
        let mut ctx = ContextMemory::new();
        ctx.append_system_reminder(
            "test reminder",
            MessageOrigin::Injection { variant: "test".to_string() },
        );
        assert_eq!(text_of(&ctx.history()[0]), "<system-reminder>\ntest reminder\n</system-reminder>");
    }

    #[test]
    fn append_returns_a_splice_and_defers_mid_exchange() {
        let mut ctx = ContextMemory::new();
        begin(&mut ctx, "s1");
        call(&mut ctx, "s1", "c1");
        let deferred = ctx.append_message(ContextMessage {
            role: "user".to_string(),
            content: vec![text_part("later")],
            ..Default::default()
        });
        assert!(deferred.is_none(), "a mid-exchange append must be deferred");
        assert_eq!(roles(&ctx), vec!["assistant"]);
        tool_result(&mut ctx, "c1", "body");
        assert_eq!(roles(&ctx), vec!["assistant", "tool", "user"]);
    }

    #[test]
    fn clear_resets_history_and_accounting() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "hello");
        ctx.update_token_count(500);
        let splice = ctx.clear().expect("clear splices");
        assert_eq!(splice, ContextSplice { start: 0, delete_count: 1, inserted_count: 0, tokens: Some(0) });
        assert!(ctx.is_empty());
        assert_eq!(ctx.token_count(), 0);
        assert!(ctx.clear().is_none(), "clearing an empty history is a no-op");
    }

    #[test]
    fn clear_resets_the_fold_so_later_appends_are_not_deferred() {
        let mut ctx = ContextMemory::new();
        begin(&mut ctx, "s1");
        call(&mut ctx, "s1", "c1");
        ctx.clear();
        assert!(!ctx.has_open_tool_exchange());
        assert!(ctx.append_message(ContextMessage { role: "user".to_string(), ..Default::default() }).is_some());
    }

    // ── undo ──────────────────────────────────────────────────────────────

    #[test]
    fn undo_removes_one_turn() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "first");
        begin(&mut ctx, "s1");
        say(&mut ctx, "s1", "reply");
        end(&mut ctx, "s1");
        user(&mut ctx, "second");
        let cut = ctx.undo(1);
        assert_eq!(cut.removed_count, 1);
        assert_eq!(texts(&ctx), vec!["first", "reply"]);
    }

    #[test]
    fn undo_is_all_or_nothing() {
        // Regression guard for the previous walk-and-delete implementation,
        // which removed what it could find and left a truncated history.
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "only");
        let before = texts(&ctx);
        let cut = ctx.undo(3);
        assert!(!crate::context::context_ops::is_fully_undoable(&cut, 3));
        assert_eq!(texts(&ctx), before, "history must be untouched");
    }

    #[test]
    fn undo_refuses_to_cross_a_compaction_boundary() {
        let mut ctx = ContextMemory::new();
        ctx.append_message(ContextMessage {
            role: "user".to_string(),
            content: vec![text_part("summary")],
            origin: Some(MessageOrigin::CompactionSummary),
            ..Default::default()
        });
        let before = texts(&ctx);
        let cut = ctx.undo(1);
        assert!(cut.stopped_at_compaction);
        assert_eq!(texts(&ctx), before);
    }

    #[test]
    fn undo_counts_slash_skill_prompts_as_turns() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "first");
        ctx.append_user_message(
            &[text_part("/do")],
            MessageOrigin::SkillActivation {
                activation_id: "a".to_string(),
                skill_name: "s".to_string(),
                skill_args: None,
                trigger: "user-slash".to_string(),
            },
        );
        ctx.undo(1);
        assert_eq!(texts(&ctx), vec!["first"]);
    }

    #[test]
    fn undo_rebases_the_measured_prefix() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "first");
        user(&mut ctx, "second");
        ctx.update_token_count(9_999);
        ctx.undo(1);
        assert_eq!(ctx.len(), 1);
        // the measured aggregate covered past the cut, so it was re-estimated
        assert_eq!(ctx.token_count(), tokenizer::estimate_messages_tokens(ctx.history()));
    }

    #[test]
    fn undo_keeps_a_measured_prefix_shorter_than_the_cut() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "first");
        ctx.update_token_count(123); // measures 1 message
        user(&mut ctx, "second");
        user(&mut ctx, "third");
        ctx.undo(1); // cuts to length 2 — the measured prefix (1) is still valid
        assert_eq!(ctx.token_count(), 123);
    }

    #[test]
    fn undo_message_explains_the_shortfall() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "only");
        assert_eq!(
            ctx.undo_unavailable_message(3).unwrap(),
            "Nothing to undo: only 1 of 3 requested turn(s) available"
        );
        assert_eq!(ctx.undo_unavailable_message(1), None);
    }

    // ── compaction ────────────────────────────────────────────────────────

    #[test]
    fn compaction_keeps_user_messages_and_appends_the_summary() {
        // Regression guard: the previous implementation replaced the whole
        // history with a lone summary message, discarding every user turn.
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "first");
        begin(&mut ctx, "s1");
        say(&mut ctx, "s1", "reply");
        end(&mut ctx, "s1");
        user(&mut ctx, "second");

        let shape = ctx.apply_compaction(&ContextCompactionShapeInput {
            summary: "what happened".to_string(),
            compacted_count: ctx.len(),
            tokens_before: 1000,
            ..Default::default()
        });

        assert_eq!(texts(&ctx), vec!["first", "second", "what happened"]);
        assert_eq!(shape.kept_user_message_count, 2);
        assert_eq!(ctx.token_count(), shape.tokens_after);
    }

    #[test]
    fn compaction_resets_the_fold() {
        let mut ctx = ContextMemory::new();
        begin(&mut ctx, "s1");
        call(&mut ctx, "s1", "c1");
        ctx.apply_compaction(&ContextCompactionShapeInput {
            summary: "s".to_string(),
            compacted_count: ctx.len(),
            ..Default::default()
        });
        assert!(!ctx.has_open_tool_exchange());
    }

    #[test]
    fn compaction_adopts_tokens_after_as_the_measured_prefix() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "first");
        ctx.apply_compaction(&ContextCompactionShapeInput {
            summary: "s".to_string(),
            compacted_count: 1,
            tokens_after: Some(77),
            ..Default::default()
        });
        assert_eq!(ctx.token_count(), 77);
        assert_eq!(ctx.token_count_with_pending(), 77);
    }

    // ── loop events ───────────────────────────────────────────────────────

    #[test]
    fn a_full_turn_folds_to_assistant_then_tool() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "do it");
        begin(&mut ctx, "s1");
        say(&mut ctx, "s1", "working");
        call(&mut ctx, "s1", "c1");
        tool_result(&mut ctx, "c1", "file body");
        end(&mut ctx, "s1");
        assert_eq!(roles(&ctx), vec!["user", "assistant", "tool"]);
        assert_eq!(ctx.history()[1].partial, None);
        assert_eq!(ctx.history()[1].tool_calls.len(), 1);
    }

    #[test]
    fn an_output_free_step_leaves_no_assistant_behind() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "do it");
        begin(&mut ctx, "s1");
        end(&mut ctx, "s1");
        assert_eq!(roles(&ctx), vec!["user"]);
    }

    #[test]
    fn record_step_usage_adopts_the_provider_total() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "hi");
        ctx.record_step_usage(&StepUsage {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: Some(5),
            cache_creation_tokens: None,
        });
        assert_eq!(ctx.token_count(), 125);
        assert_eq!(ctx.token_count_with_pending(), 125);
    }

    #[test]
    fn record_step_usage_estimates_when_the_provider_reports_nothing() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "hi");
        ctx.record_step_usage(&StepUsage::default());
        assert_eq!(ctx.token_count(), tokenizer::estimate_messages_tokens(ctx.history()));
    }

    #[test]
    fn finish_resume_closes_a_dangling_exchange() {
        let mut ctx = ContextMemory::new();
        begin(&mut ctx, "s1");
        say(&mut ctx, "s1", "partial");
        call(&mut ctx, "s1", "c1");
        ctx.finish_resume();
        assert_eq!(roles(&ctx), vec!["assistant", "tool"]);
        assert_eq!(text_of(&ctx.history()[1]), TOOL_INTERRUPTED_ON_RESUME_OUTPUT);
        assert_eq!(ctx.history()[1].is_error, Some(true));
        assert!(!ctx.has_open_tool_exchange());
    }

    #[test]
    fn close_abandoned_tool_exchange_reports_the_count() {
        let mut ctx = ContextMemory::new();
        begin(&mut ctx, "s1");
        say(&mut ctx, "s1", "partial");
        call(&mut ctx, "s1", "c1");
        call(&mut ctx, "s1", "c2");
        assert_eq!(ctx.close_abandoned_tool_exchange(), 2);
        assert_eq!(ctx.close_abandoned_tool_exchange(), 0);
    }

    // ── misc ──────────────────────────────────────────────────────────────

    #[test]
    fn replace_tool_result_overwrites_the_prediction() {
        let mut ctx = ContextMemory::new();
        begin(&mut ctx, "s1");
        call(&mut ctx, "s1", "c1");
        tool_result(&mut ctx, "c1", "prediction");
        let replaced = ctx.replace_tool_result(
            "c1",
            ToolResultReplacement {
                output: LoopToolOutput::Text("precise result".to_string()),
                is_error: Some(false),
                note: None,
            },
        );
        assert!(replaced);
        assert_eq!(text_of(&ctx.history()[1]), "precise result");
        assert!(!ctx.replace_tool_result("nope", ToolResultReplacement {
            output: LoopToolOutput::Text("x".to_string()),
            is_error: None,
            note: None,
        }));
    }

    #[test]
    fn import_context_validates_its_inputs() {
        let mut ctx = ContextMemory::new();
        assert!(ctx.import_context("", "test.txt", None).is_err());
        assert!(ctx.import_context("content", "  ", None).is_err());
        assert!(ctx.import_context("some content", "test.txt", None).is_ok());
        assert_eq!(ctx.len(), 1);
        assert!(text_of(&ctx.history()[0]).contains("<imported_context source=\"test.txt\">"));
    }

    #[test]
    fn pop_swarm_mode_reminder_drops_only_a_trailing_reminder() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "first");
        ctx.append_system_reminder(
            "swarm on",
            MessageOrigin::Injection { variant: "swarm_mode".to_string() },
        );
        assert!(ctx.pop_swarm_mode_reminder().is_some());
        assert_eq!(texts(&ctx), vec!["first"]);
        assert!(ctx.pop_swarm_mode_reminder().is_none());
    }

    #[test]
    fn last_assistant_at_is_stamped_on_step_begin() {
        let mut ctx = ContextMemory::new();
        assert!(ctx.last_assistant_at().is_none());
        begin(&mut ctx, "s1");
        assert!(ctx.last_assistant_at().is_some());
    }

    #[test]
    fn data_snapshots_history_and_tokens() {
        let mut ctx = ContextMemory::new();
        user(&mut ctx, "hi");
        ctx.update_token_count(42);
        let data = ctx.data();
        assert_eq!(data.history.len(), 1);
        assert_eq!(data.token_count, 42);
    }
}
