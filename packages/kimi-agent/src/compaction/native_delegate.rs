//! Native-LLM compaction delegate.
//!
//! [`FullCompaction`](super::FullCompaction) is delegate-driven: the state
//! machine decides *when* and *how much* to compact, but the actual
//! summarization is a host responsibility. In the standalone engine there is
//! no JS host to answer it, so this delegate produces the summary itself by
//! calling the session's native-LLM provider directly.
//!
//! The [`CompactionDelegate::compact`] contract is synchronous, while the LLM
//! transport is async, so the call is bridged with `block_in_place` +
//! `Handle::block_on` — the same pattern the MCP registration path uses. This
//! is only ever invoked from inside the multi-threaded tokio runtime (the RPC
//! handler / turn loop), where `block_in_place` is legal.

use crate::compaction::utils::collect_summary;
use crate::compaction::{CompactionAttempt, CompactionDelegate, CompactionRequest, CompactionResult};
use crate::context::compaction_handoff::build_compaction_summary_text;
use crate::context::types::ContentPart;
use crate::llm::http::NativeHttpLlm;
use crate::rpc::types::NativeLlmConfig;
use crate::turn_loop::types::{LLMChatParams, LLMMessage, LLM};

/// System prompt handed to the summarizer. Kept terse and model-agnostic; the
/// per-request user instruction (below) carries the task specifics.
const COMPACTION_SYSTEM_PROMPT: &str = "You are compacting a coding assistant's \
conversation to free up context. Produce a dense, faithful working summary of \
the conversation so far: the task and its goal, decisions made, files and \
symbols touched, commands run and their outcomes, and any open threads or \
next steps. Preserve concrete identifiers (paths, function names, error text) \
verbatim. Do not invent progress — describe only what actually happened.";

/// The base user instruction appended after the messages being summarized.
const COMPACTION_USER_INSTRUCTION: &str =
    "Summarize the conversation above as working notes to continue the task.";

/// Map a completed [`CompactionResult`] onto the context-rewrite input. Pure
/// field transfer; `tokens_after` is left `None` so the context shaper
/// re-estimates from the rewritten history. Kept a free function so the
/// write-back mapping is unit-testable without an LLM or an Agent.
pub fn compaction_result_to_shape_input(
    result: &CompactionResult,
) -> crate::context::compaction_handoff::ContextCompactionShapeInput {
    crate::context::compaction_handoff::ContextCompactionShapeInput {
        summary: result.summary.clone(),
        context_summary: result.context_summary.clone(),
        compacted_count: result.compacted_count,
        tokens_before: result.tokens_before,
        tokens_after: None,
        kept_user_message_count: result.kept_user_message_count,
        kept_head_user_message_count: result.kept_head_user_message_count,
        dropped_count: result.dropped_count,
        ..Default::default()
    }
}

/// A [`CompactionDelegate`] that summarizes via the session's native-LLM
/// provider. Holds the provider config plus the pre-compaction token count so
/// the produced [`CompactionResult`] can report `tokens_before` accurately.
pub struct NativeLlmCompactionDelegate {
    config: NativeLlmConfig,
    tokens_before: u64,
}

impl NativeLlmCompactionDelegate {
    pub fn new(config: NativeLlmConfig, tokens_before: u64) -> Self {
        Self { config, tokens_before }
    }
}

/// Project a context message to a summarizer-facing LLM message: text parts
/// joined, non-text parts (images) noted as a placeholder so the summary can
/// still mention them without shipping bytes to the summarizer.
fn project_for_summary(message: &crate::context::types::ContextMessage) -> LLMMessage {
    let mut content = String::new();
    for part in &message.content {
        let text = match part {
            ContentPart::Text { text } => text.clone(),
            ContentPart::ImageUrl { .. } => "[image]".to_string(),
            _ => continue,
        };
        if !content.is_empty() {
            content.push('\n');
        }
        content.push_str(&text);
    }
    LLMMessage { role: message.role.clone(), content, ..Default::default() }
}

impl CompactionDelegate for NativeLlmCompactionDelegate {
    fn compact(&self, request: &CompactionRequest<'_>) -> Result<CompactionAttempt, String> {
        let head_len = request.compacted_count.min(request.messages.len());
        if head_len == 0 {
            return Err("nothing to summarize".to_string());
        }

        // The messages the summary must cover, plus the instruction turn.
        let mut messages: Vec<LLMMessage> =
            request.messages[..head_len].iter().map(project_for_summary).collect();
        let instruction = match request.instruction.as_deref().map(str::trim) {
            Some(extra) if !extra.is_empty() => {
                format!("{COMPACTION_USER_INSTRUCTION}\n\nAdditional instruction: {extra}")
            }
            _ => COMPACTION_USER_INSTRUCTION.to_string(),
        };
        messages.push(LLMMessage { role: "user".into(), content: instruction, ..Default::default() });

        let llm = NativeHttpLlm::new(self.config.clone(), COMPACTION_SYSTEM_PROMPT.to_string());
        let params = LLMChatParams { messages, tools: Vec::new() };

        // Bridge the async transport into the synchronous delegate contract.
        let response = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(llm.chat(params))
        })
        .map_err(|e| e.to_string())?;

        // The transport returns plain text; wrap it as a single text part so
        // the shared `collect_summary` (truncation / empty-response guards)
        // applies exactly as on the host path.
        let content = [ContentPart::Text { text: response.content }];
        let summary = collect_summary(response.finish_reason.as_deref(), &content)
            .map_err(|e| e.to_string())?;

        Ok(CompactionAttempt::Done(CompactionResult {
            context_summary: Some(build_compaction_summary_text(&summary)),
            summary,
            compacted_count: head_len,
            tokens_before: self.tokens_before,
            // Left for the context shaper to estimate from the rewritten
            // history (it recomputes when the input's `tokens_after` is None).
            tokens_after: 0,
            kept_user_message_count: None,
            kept_head_user_message_count: None,
            dropped_count: None,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::context_memory::ContextMemory;
    use crate::context::types::{ContentPart, ContextMessage, MessageOrigin};

    fn user(text: &str) -> ContextMessage {
        ContextMessage {
            role: "user".into(),
            content: vec![ContentPart::Text { text: text.into() }],
            origin: Some(MessageOrigin::User),
            ..Default::default()
        }
    }

    fn assistant(text: &str) -> ContextMessage {
        ContextMessage {
            role: "assistant".into(),
            content: vec![ContentPart::Text { text: text.into() }],
            ..Default::default()
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
            .join("\n")
    }

    /// The write-back the old inline call dropped: applying a compaction result
    /// must rewrite the head into a summary message while keeping the verbatim
    /// user messages and reporting the summary text back.
    #[test]
    fn apply_compaction_result_rewrites_head_into_a_summary() {
        let mut context = ContextMemory::new();
        for message in [
            user("first user message about ALPHA"),
            assistant("assistant reply one"),
            user("second user message about BETA"),
            assistant("assistant reply two"),
        ] {
            let _ = context.append_message(message);
        }
        let before = context.history().len();

        let result = CompactionResult {
            summary: "WORKING_SUMMARY".into(),
            context_summary: Some(build_compaction_summary_text("WORKING_SUMMARY")),
            compacted_count: before,
            tokens_before: 100,
            tokens_after: 0,
            kept_user_message_count: None,
            kept_head_user_message_count: None,
            dropped_count: None,
        };

        let input = compaction_result_to_shape_input(&result);
        let shape = context.apply_compaction(&input);

        // The rewritten history ends with a CompactionSummary-origin message
        // carrying the summary text.
        let history = context.history();
        let summary_msg = history
            .iter()
            .find(|m| matches!(m.origin, Some(MessageOrigin::CompactionSummary)))
            .expect("a compaction summary message must be present");
        assert!(
            text_of(summary_msg).contains("WORKING_SUMMARY"),
            "summary message must carry the summary text: {}",
            text_of(summary_msg)
        );
        // The verbatim user messages survive the rewrite.
        assert!(
            history.iter().any(|m| text_of(m).contains("ALPHA")),
            "the first user message must be kept verbatim"
        );
        assert!(
            history.iter().any(|m| text_of(m).contains("BETA")),
            "the second user message must be kept verbatim"
        );
        // The shaper reported the summary back and re-estimated tokens_after.
        assert_eq!(shape.summary, "WORKING_SUMMARY");
        assert!(shape.tokens_after > 0, "tokens_after must be re-estimated");
    }

    #[test]
    fn shape_input_leaves_tokens_after_for_reestimation() {
        let result = CompactionResult {
            summary: "s".into(),
            context_summary: None,
            compacted_count: 3,
            tokens_before: 42,
            tokens_after: 999, // must be ignored by the mapping
            kept_user_message_count: Some(2),
            kept_head_user_message_count: Some(1),
            dropped_count: Some(4),
        };
        let input = compaction_result_to_shape_input(&result);
        assert_eq!(input.tokens_before, 42);
        assert_eq!(input.tokens_after, None, "tokens_after must be left for re-estimation");
        assert_eq!(input.compacted_count, 3);
        assert_eq!(input.kept_user_message_count, Some(2));
        assert_eq!(input.dropped_count, Some(4));
    }
}
