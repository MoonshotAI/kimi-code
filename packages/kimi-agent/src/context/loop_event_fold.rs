/// `contextMemory` loop-event fold — reduction of `context.append_loop_event`
/// records into folded `ContextMessage`s.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts`.
///
/// Both loops stream a turn as `context.append_loop_event` records
/// (`step.begin` / `content.part` / `tool.call` / `tool.result` / `step.end`)
/// and never write a folded assistant message. This fold turns them into
/// assistant / tool messages — at live dispatch time and again on replay:
///   - `step.begin`   → open an assistant message (`partial: true`); first
///                      settle the step left open by a failed attempt
///   - `content.part` → append to the open assistant's content
///   - `tool.call`    → append to the open assistant's `tool_calls`, mark pending
///   - `tool.result`  → push a `tool` message, clear its pending id
///   - `step.end`     → settle the assistant
///
/// "Settle" closes any tool exchange left open (interrupted result messages),
/// then drops the partial assistant when nothing sendable was recorded (no tool
/// calls; every content part vacuous — an output-free assistant only trips
/// provider message validation) and seals it (`partial: None`) when it carries
/// output. A message appended while a tool exchange is still open is deferred
/// and flushed once the exchange closes, so strict-provider assistant↔tool
/// adjacency is preserved.
///
/// TS carries the fold state in a `WeakMap` keyed by each evolving state array
/// purely so the public `wire.getModel(ContextModel)` view stays a plain
/// `ContextMessage[]`. Rust has no such constraint, so the state rides in an
/// explicit [`FoldCtx`] threaded alongside the message vector. Each entry point
/// returns `true` when the visible message list changed, reproducing the
/// same-reference-on-no-op contract the TS wire's equality gate relies on.
use crate::context::types::{ContentPart, ContextMessage, ToolCall};
use crate::context::vacuous_content::is_vacuous_content_part;

pub const TOOL_INTERRUPTED_ON_RESUME_OUTPUT: &str =
    "Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.";

/// Output of a tool, as recorded on a `tool.result` event.
#[derive(Debug, Clone)]
pub enum LoopToolOutput {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl LoopToolOutput {
    fn into_content(self) -> Vec<ContentPart> {
        match self {
            LoopToolOutput::Text(text) => vec![ContentPart::Text { text }],
            LoopToolOutput::Parts(parts) => parts,
        }
    }
}

/// The result payload carried by a `tool.result` event.
#[derive(Debug, Clone)]
pub struct LoopToolResult {
    pub output: LoopToolOutput,
    pub is_error: Option<bool>,
    pub note: Option<String>,
}

/// A loop event recorded on the wire and folded into the history.
///
/// Only the fields the fold actually reads are modelled; the transport-level
/// bookkeeping TS carries (`turnId`, `step`, timing fields on `step.end`) does
/// not affect the reduction and is deliberately omitted.
#[derive(Debug, Clone)]
pub enum LoopRecordedEvent {
    StepBegin { uuid: String },
    StepEnd { uuid: String },
    ContentPart { step_uuid: String, part: ContentPart },
    ToolCall {
        step_uuid: String,
        tool_call_id: String,
        name: String,
        args: Option<serde_json::Value>,
        extras: Option<serde_json::Value>,
    },
    ToolResult { tool_call_id: String, result: LoopToolResult },
    ToolsDispatched { step_uuid: String, tool_names: Vec<String>, count: u32 },
}

/// Fold state carried across records within one replay.
#[derive(Debug, Clone, Default)]
pub struct FoldCtx {
    /// The uuid of the step currently open, if any.
    pub open_step_uuid: Option<String>,
    /// Tool call ids awaiting a result. Insertion-ordered set — TS uses a
    /// `Set<string>`, whose iteration order is insertion order, and
    /// `close_pending` pushes interrupted results in exactly that order.
    pending: Vec<String>,
    /// Messages appended while a tool exchange was open, flushed once it closes.
    deferred: Vec<ContextMessage>,
}

impl FoldCtx {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn has_open_tool_exchange(&self) -> bool {
        !self.pending.is_empty()
    }

    pub fn pending_ids(&self) -> &[String] {
        &self.pending
    }

    pub fn deferred_len(&self) -> usize {
        self.deferred.len()
    }

    fn pending_contains(&self, id: &str) -> bool {
        self.pending.iter().any(|p| p == id)
    }

    fn pending_add(&mut self, id: &str) {
        if !self.pending_contains(id) {
            self.pending.push(id.to_string());
        }
    }

    fn pending_remove(&mut self, id: &str) {
        self.pending.retain(|p| p != id);
    }

    /// Reset to the initial state — the `resetFold` entry point, applied after
    /// any whole-history rewrite (clear / undo / compaction / swarm pop).
    pub fn reset(&mut self) {
        self.open_step_uuid = None;
        self.pending.clear();
        self.deferred.clear();
    }
}

/// Reduce a plain `context.append_message` record.
///
/// Returns `true` when `state` changed. A message arriving mid-tool-exchange is
/// deferred rather than appended, leaving `state` untouched.
pub fn fold_append_message(
    state: &mut Vec<ContextMessage>,
    ctx: &mut FoldCtx,
    message: ContextMessage,
) -> bool {
    if ctx.has_open_tool_exchange() {
        ctx.deferred.push(message);
        return false;
    }
    state.push(message);
    true
}

/// Reduce a `context.append_loop_event` record. Returns `true` when `state`
/// changed.
pub fn fold_loop_event(
    state: &mut Vec<ContextMessage>,
    ctx: &mut FoldCtx,
    event: &LoopRecordedEvent,
) -> bool {
    match event {
        LoopRecordedEvent::StepBegin { uuid } => {
            settle_open_step(state, ctx);
            state.push(ContextMessage {
                role: "assistant".to_string(),
                content: Vec::new(),
                tool_calls: Vec::new(),
                partial: Some(true),
                ..Default::default()
            });
            ctx.open_step_uuid = Some(uuid.clone());
            true
        }
        LoopRecordedEvent::StepEnd { .. } => {
            ctx.open_step_uuid = None;
            let settled = settle_open_step(state, ctx);
            let flushed = flush_deferred(state, ctx);
            settled || flushed
        }
        LoopRecordedEvent::ContentPart { part, .. } => {
            match find_open_assistant_index(state) {
                Some(index) => {
                    state[index].content.push(part.clone());
                    true
                }
                None => false,
            }
        }
        LoopRecordedEvent::ToolCall { tool_call_id, name, args, extras, .. } => {
            let call = ToolCall {
                r#type: "function".to_string(),
                id: tool_call_id.clone(),
                name: name.clone(),
                // TS: `args === undefined ? null : JSON.stringify(args)`. This
                // crate models arguments as a `Value` rather than the
                // stringified form, so an absent payload is `Value::Null`.
                arguments: args.clone().unwrap_or(serde_json::Value::Null),
                extras: extras.clone(),
            };
            // TS marks the call pending before `appendToOpenAssistant`, so a
            // `tool.call` with no open assistant still registers as pending and
            // its later result is accepted. Preserve that ordering.
            ctx.pending_add(tool_call_id);
            match find_open_assistant_index(state) {
                Some(index) => {
                    state[index].tool_calls.push(call);
                    true
                }
                None => false,
            }
        }
        LoopRecordedEvent::ToolResult { tool_call_id, result } => {
            if !ctx.pending_contains(tool_call_id) {
                return false;
            }
            state.push(tool_message(tool_call_id, result.clone()));
            ctx.pending_remove(tool_call_id);
            flush_deferred(state, ctx);
            true
        }
        LoopRecordedEvent::ToolsDispatched { tool_names, count, .. } => {
            state.push(speculative_dispatch_message(tool_names, *count));
            true
        }
    }
}

/// Build the `[Speculative] …` system nudge for a `tools.dispatched` event.
fn speculative_dispatch_message(tool_names: &[String], count: u32) -> ContextMessage {
    // `[...new Set(toolNames)]` — de-duplicate, preserving first-seen order.
    let mut names: Vec<&str> = Vec::new();
    for name in tool_names {
        if !names.contains(&name.as_str()) {
            names.push(name.as_str());
        }
    }
    let list = names.join(", ");
    let tool_word = if count == 1 { "tool is" } else { "tools are" };
    let text = format!(
        "[Speculative] {count} {tool_word} running: {list}. Based on what you expect to find, start preparing your analysis while results arrive."
    );
    ContextMessage {
        role: "system".to_string(),
        content: vec![ContentPart::Text { text }],
        tool_calls: Vec::new(),
        ..Default::default()
    }
}

fn tool_message(tool_call_id: &str, result: LoopToolResult) -> ContextMessage {
    ContextMessage {
        role: "tool".to_string(),
        content: result.output.into_content(),
        tool_calls: Vec::new(),
        tool_call_id: Some(tool_call_id.to_string()),
        is_error: result.is_error,
        note: result.note,
        ..Default::default()
    }
}

fn interrupted_tool_message(tool_call_id: &str) -> ContextMessage {
    ContextMessage {
        role: "tool".to_string(),
        content: vec![ContentPart::Text {
            text: TOOL_INTERRUPTED_ON_RESUME_OUTPUT.to_string(),
        }],
        tool_calls: Vec::new(),
        tool_call_id: Some(tool_call_id.to_string()),
        is_error: Some(true),
        ..Default::default()
    }
}

/// The index of the assistant message left open (`partial == Some(true)`),
/// searching from the end.
///
/// TS scans backwards for `partial === true` rather than reading the last
/// element: a `tool.result` pushes a `tool` message after the open assistant,
/// so "last message" is not the open step once any tool has resolved.
pub fn find_open_assistant_index(state: &[ContextMessage]) -> Option<usize> {
    state.iter().rposition(|m| m.partial == Some(true))
}

/// Close the open step: settle any dangling tool exchange, then drop or seal
/// the partial assistant. Returns `true` when `state` changed.
fn settle_open_step(state: &mut Vec<ContextMessage>, ctx: &mut FoldCtx) -> bool {
    let closed = close_pending(state, ctx);
    let Some(index) = find_open_assistant_index(state) else {
        return closed;
    };
    let open = &state[index];
    // An assistant with no tool calls and only vacuous content has nothing the
    // provider wire can represent — dropping it is what makes a retried attempt
    // (its own `step.begin`) replay to the history the live loop folded.
    if open.tool_calls.is_empty() && open.content.iter().all(is_vacuous_content_part) {
        state.remove(index);
    } else {
        state[index].partial = None;
    }
    true
}

/// Push an interrupted result for every still-pending tool call, then flush.
/// Returns `true` when `state` changed.
fn close_pending(state: &mut Vec<ContextMessage>, ctx: &mut FoldCtx) -> bool {
    if ctx.pending.is_empty() {
        return false;
    }
    let ids = std::mem::take(&mut ctx.pending);
    for tool_call_id in &ids {
        state.push(interrupted_tool_message(tool_call_id));
    }
    flush_deferred(state, ctx);
    true
}

/// Append any deferred messages once no tool exchange is open. Returns `true`
/// when `state` changed.
fn flush_deferred(state: &mut Vec<ContextMessage>, ctx: &mut FoldCtx) -> bool {
    if ctx.has_open_tool_exchange() || ctx.deferred.is_empty() {
        return false;
    }
    state.append(&mut ctx.deferred);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(text: &str) -> ContentPart {
        ContentPart::Text { text: text.to_string() }
    }

    fn user(text_body: &str) -> ContextMessage {
        ContextMessage {
            role: "user".to_string(),
            content: vec![text(text_body)],
            ..Default::default()
        }
    }

    fn begin(uuid: &str) -> LoopRecordedEvent {
        LoopRecordedEvent::StepBegin { uuid: uuid.to_string() }
    }

    fn end(uuid: &str) -> LoopRecordedEvent {
        LoopRecordedEvent::StepEnd { uuid: uuid.to_string() }
    }

    fn part(step: &str, body: &str) -> LoopRecordedEvent {
        LoopRecordedEvent::ContentPart {
            step_uuid: step.to_string(),
            part: text(body),
        }
    }

    fn call(step: &str, id: &str, name: &str) -> LoopRecordedEvent {
        LoopRecordedEvent::ToolCall {
            step_uuid: step.to_string(),
            tool_call_id: id.to_string(),
            name: name.to_string(),
            args: Some(serde_json::json!({ "path": "/a" })),
            extras: None,
        }
    }

    fn result(id: &str, body: &str) -> LoopRecordedEvent {
        LoopRecordedEvent::ToolResult {
            tool_call_id: id.to_string(),
            result: LoopToolResult {
                output: LoopToolOutput::Text(body.to_string()),
                is_error: None,
                note: None,
            },
        }
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

    struct Fold {
        state: Vec<ContextMessage>,
        ctx: FoldCtx,
    }

    impl Fold {
        fn new() -> Self {
            Self { state: Vec::new(), ctx: FoldCtx::new() }
        }
        fn ev(&mut self, event: LoopRecordedEvent) -> bool {
            fold_loop_event(&mut self.state, &mut self.ctx, &event)
        }
        fn msg(&mut self, message: ContextMessage) -> bool {
            fold_append_message(&mut self.state, &mut self.ctx, message)
        }
        fn roles(&self) -> Vec<&str> {
            self.state.iter().map(|m| m.role.as_str()).collect()
        }
    }

    #[test]
    fn step_begin_opens_a_partial_assistant() {
        let mut f = Fold::new();
        assert!(f.ev(begin("s1")));
        assert_eq!(f.state.len(), 1);
        assert_eq!(f.state[0].role, "assistant");
        assert_eq!(f.state[0].partial, Some(true));
        assert_eq!(f.ctx.open_step_uuid.as_deref(), Some("s1"));
    }

    #[test]
    fn content_part_appends_to_the_open_assistant() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        assert!(f.ev(part("s1", "hello")));
        assert_eq!(text_of(&f.state[0]), "hello");
    }

    #[test]
    fn content_part_without_an_open_assistant_is_a_no_op() {
        let mut f = Fold::new();
        assert!(!f.ev(part("s1", "orphan")));
        assert!(f.state.is_empty());
    }

    #[test]
    fn step_end_seals_an_assistant_that_produced_output() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(part("s1", "hello"));
        assert!(f.ev(end("s1")));
        assert_eq!(f.state.len(), 1);
        assert_eq!(f.state[0].partial, None);
        assert!(f.ctx.open_step_uuid.is_none());
    }

    #[test]
    fn step_end_drops_an_output_free_assistant() {
        // No tool calls and no content at all — nothing the provider wire can
        // represent, so the partial assistant must not survive.
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(end("s1"));
        assert!(f.state.is_empty());
    }

    #[test]
    fn step_end_drops_an_assistant_whose_content_is_all_vacuous() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(part("s1", "   "));
        f.ev(part("s1", "\n"));
        f.ev(end("s1"));
        assert!(f.state.is_empty());
    }

    #[test]
    fn step_end_keeps_a_tool_only_assistant_with_vacuous_content() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(part("s1", "  "));
        f.ev(call("s1", "c1", "read"));
        f.ev(result("c1", "body"));
        f.ev(end("s1"));
        // assistant survives on the strength of its tool call
        assert_eq!(f.roles(), vec!["assistant", "tool"]);
        assert_eq!(f.state[0].partial, None);
    }

    #[test]
    fn signed_thinking_keeps_an_otherwise_empty_assistant() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(LoopRecordedEvent::ContentPart {
            step_uuid: "s1".to_string(),
            part: ContentPart::Think {
                think: Some(String::new()),
                encrypted: Some("opaque".to_string()),
                signature: None,
            },
        });
        f.ev(end("s1"));
        assert_eq!(f.state.len(), 1);
        assert_eq!(f.state[0].partial, None);
    }

    #[test]
    fn tool_call_marks_pending_and_result_clears_it() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(call("s1", "c1", "read"));
        assert_eq!(f.ctx.pending_ids(), ["c1"]);
        assert!(f.ev(result("c1", "body")));
        assert!(f.ctx.pending_ids().is_empty());
        assert_eq!(f.roles(), vec!["assistant", "tool"]);
        assert_eq!(f.state[1].tool_call_id.as_deref(), Some("c1"));
        assert_eq!(text_of(&f.state[1]), "body");
    }

    #[test]
    fn tool_result_for_an_unknown_call_is_ignored() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        assert!(!f.ev(result("nope", "body")));
        assert_eq!(f.state.len(), 1);
    }

    #[test]
    fn tool_result_is_ignored_twice() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(call("s1", "c1", "read"));
        assert!(f.ev(result("c1", "body")));
        assert!(!f.ev(result("c1", "again")));
        assert_eq!(f.roles(), vec!["assistant", "tool"]);
    }

    #[test]
    fn content_part_after_a_tool_result_still_finds_the_open_assistant() {
        // Regression guard: the open assistant is no longer the last element
        // once a tool message has been pushed.
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(call("s1", "c1", "read"));
        f.ev(result("c1", "body"));
        assert!(f.ev(part("s1", "after")));
        assert_eq!(text_of(&f.state[0]), "after");
        assert_eq!(f.state[0].role, "assistant");
    }

    #[test]
    fn append_during_an_open_tool_exchange_is_deferred_then_flushed() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(call("s1", "c1", "read"));
        assert!(!f.msg(user("interjection")));
        assert_eq!(f.roles(), vec!["assistant"]);
        assert_eq!(f.ctx.deferred_len(), 1);
        f.ev(result("c1", "body"));
        // flushed after the exchange closed, behind the tool message
        assert_eq!(f.roles(), vec!["assistant", "tool", "user"]);
        assert_eq!(f.ctx.deferred_len(), 0);
    }

    #[test]
    fn append_outside_a_tool_exchange_goes_straight_in() {
        let mut f = Fold::new();
        assert!(f.msg(user("hi")));
        assert_eq!(f.roles(), vec!["user"]);
    }

    #[test]
    fn deferred_messages_flush_in_order_behind_all_tool_results() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(call("s1", "c1", "a"));
        f.ev(call("s1", "c2", "b"));
        f.msg(user("first"));
        f.msg(user("second"));
        f.ev(result("c1", "r1"));
        // c2 still pending → nothing flushed yet
        assert_eq!(f.roles(), vec!["assistant", "tool"]);
        f.ev(result("c2", "r2"));
        assert_eq!(f.roles(), vec!["assistant", "tool", "tool", "user", "user"]);
        assert_eq!(text_of(&f.state[3]), "first");
        assert_eq!(text_of(&f.state[4]), "second");
    }

    #[test]
    fn step_begin_settles_a_step_left_open_by_a_failed_attempt() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(part("s1", "partial output"));
        f.ev(call("s1", "c1", "read"));
        // retry: a new step.begin with c1 never resolved
        f.ev(begin("s2"));
        // the abandoned call is closed with an interrupted result, the first
        // assistant sealed, and a fresh partial opened
        assert_eq!(f.roles(), vec!["assistant", "tool", "assistant"]);
        assert_eq!(f.state[0].partial, None);
        assert_eq!(f.state[1].is_error, Some(true));
        assert_eq!(text_of(&f.state[1]), TOOL_INTERRUPTED_ON_RESUME_OUTPUT);
        assert_eq!(f.state[2].partial, Some(true));
        assert!(f.ctx.pending_ids().is_empty());
    }

    #[test]
    fn step_begin_drops_an_empty_failed_attempt() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(begin("s2"));
        // the first attempt produced nothing and is dropped, not stacked
        assert_eq!(f.state.len(), 1);
        assert_eq!(f.state[0].partial, Some(true));
    }

    #[test]
    fn interrupted_results_are_pushed_in_call_order() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(call("s1", "c1", "a"));
        f.ev(call("s1", "c2", "b"));
        f.ev(call("s1", "c3", "c"));
        f.ev(end("s1"));
        let ids: Vec<_> = f.state[1..].iter().filter_map(|m| m.tool_call_id.clone()).collect();
        assert_eq!(ids, vec!["c1", "c2", "c3"]);
    }

    #[test]
    fn closing_a_dangling_exchange_flushes_deferred_messages() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(call("s1", "c1", "read"));
        f.msg(user("interjection"));
        f.ev(end("s1"));
        assert_eq!(f.roles(), vec!["assistant", "tool", "user"]);
        assert_eq!(f.ctx.deferred_len(), 0);
    }

    #[test]
    fn duplicate_tool_call_ids_register_once() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(call("s1", "c1", "read"));
        f.ev(call("s1", "c1", "read"));
        assert_eq!(f.ctx.pending_ids(), ["c1"]);
    }

    #[test]
    fn tools_dispatched_pushes_a_speculative_system_message() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        assert!(f.ev(LoopRecordedEvent::ToolsDispatched {
            step_uuid: "s1".to_string(),
            tool_names: vec!["read".to_string(), "grep".to_string()],
            count: 2,
        }));
        assert_eq!(f.state[1].role, "system");
        assert_eq!(
            text_of(&f.state[1]),
            "[Speculative] 2 tools are running: read, grep. Based on what you expect to find, start preparing your analysis while results arrive."
        );
    }

    #[test]
    fn tools_dispatched_singular_wording_and_dedupe() {
        let mut f = Fold::new();
        f.ev(LoopRecordedEvent::ToolsDispatched {
            step_uuid: "s1".to_string(),
            tool_names: vec!["read".to_string(), "read".to_string()],
            count: 1,
        });
        assert_eq!(
            text_of(&f.state[0]),
            "[Speculative] 1 tool is running: read. Based on what you expect to find, start preparing your analysis while results arrive."
        );
    }

    #[test]
    fn tool_result_carries_error_and_note() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(call("s1", "c1", "read"));
        f.ev(LoopRecordedEvent::ToolResult {
            tool_call_id: "c1".to_string(),
            result: LoopToolResult {
                output: LoopToolOutput::Parts(vec![text("boom")]),
                is_error: Some(true),
                note: Some("check the path".to_string()),
            },
        });
        assert_eq!(f.state[1].is_error, Some(true));
        assert_eq!(f.state[1].note.as_deref(), Some("check the path"));
        assert_eq!(text_of(&f.state[1]), "boom");
    }

    #[test]
    fn reset_clears_all_fold_state() {
        let mut f = Fold::new();
        f.ev(begin("s1"));
        f.ev(call("s1", "c1", "read"));
        f.msg(user("deferred"));
        f.ctx.reset();
        assert!(f.ctx.open_step_uuid.is_none());
        assert!(f.ctx.pending_ids().is_empty());
        assert_eq!(f.ctx.deferred_len(), 0);
        // a subsequent append is no longer held back
        assert!(f.msg(user("now")));
    }

    #[test]
    fn full_turn_folds_to_assistant_then_tool() {
        let mut f = Fold::new();
        f.msg(user("do it"));
        f.ev(begin("s1"));
        f.ev(part("s1", "working"));
        f.ev(call("s1", "c1", "read"));
        f.ev(result("c1", "file body"));
        f.ev(end("s1"));
        assert_eq!(f.roles(), vec!["user", "assistant", "tool"]);
        assert_eq!(f.state[1].partial, None);
        assert_eq!(f.state[1].tool_calls.len(), 1);
    }
}
