/// The generation driver — orchestrates `ChatProvider::generate()` and
/// normalizes the event stream.
///
/// Corresponds to `kosong/contract/generate.ts`.
use futures_util::StreamExt;
use std::collections::HashMap;

use super::errors::ChatProviderError;
use super::message::{
    self, is_tool_call_part, merge_in_place, ContentPart, Message, StreamedMessagePart, ToolCall,
};
use super::provider::{ChatProvider, FinishReason, GenerateOptions};
use super::tool::Tool;
use super::usage::TokenUsage;

/// Result of a complete generation.
#[derive(Debug, Clone)]
pub struct GenerateResult {
    pub id: Option<String>,
    pub message: Message,
    pub usage: Option<TokenUsage>,
    pub finish_reason: Option<FinishReason>,
    pub raw_finish_reason: Option<String>,
    pub trace_id: Option<String>,
}

/// Callbacks during generation.
pub struct GenerateCallbacks {
    pub on_message_part: Option<Box<dyn Fn(StreamedMessagePart) + Send + Sync>>,
    pub on_tool_call: Option<Box<dyn Fn(ToolCall) + Send + Sync>>,
}

/// Drive one LLM generation through the provider, streaming and merging deltas.
pub async fn generate(
    provider: &dyn ChatProvider,
    system_prompt: &str,
    tools: &[Tool],
    history: &[Message],
    callbacks: Option<&GenerateCallbacks>,
    options: &GenerateOptions,
) -> Result<GenerateResult, ChatProviderError> {
    // Check for pre-abort
    if let Some(ref signal) = options.signal {
        if *signal.borrow() {
            return Err(ChatProviderError::Provider("The operation was aborted.".to_string()));
        }
    }

    // Filter deferred tools for the wire
    let wire_tools: Vec<Tool> = if tools.iter().any(|t| t.deferred) {
        tools.iter().filter(|t| !t.deferred).cloned().collect()
    } else {
        tools.to_vec()
    };

    // Call on_request_start
    if let Some(cb) = &options.on_request_start {
        (cb)();
    }

    let mut stream = provider.generate(system_prompt, &wire_tools, history, options).await?;

    // Forward trace id
    if let Some(ref trace_id) = stream.trace_id {
        if let Some(cb) = &options.on_trace_id {
            (cb)(Some(trace_id.clone()));
        }
    }

    let mut message: Message = Message {
        role: message::Role::Assistant,
        content: Vec::new(),
        tool_calls: Vec::new(),
        name: None,
        tool_call_id: None,
        partial: false,
        tools: None,
    };
    let mut pending_part: Option<StreamedMessagePart> = None;
    let mut tool_call_index_map: HashMap<serde_json::Value, usize> = HashMap::new();

    let mut server_decode_ms: u64 = 0;
    let mut client_consume_ms: u64 = 0;
    let mut first_part_at: Option<u64> = None;
    let mut last_resume_at: u64 = 0;

    // Helper to get current time in ms
    let now_ms = || -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    };

    while let Some(part) = stream.next().await {
        let arrived_at = now_ms();
        if first_part_at.is_none() {
            first_part_at = Some(arrived_at);
        } else {
            server_decode_ms += arrived_at.saturating_sub(last_resume_at);
        }

        // Check for abort
        if let Some(ref signal) = options.signal {
            if *signal.borrow() {
                return Err(ChatProviderError::Provider("The operation was aborted.".to_string()));
            }
        }

        // Forward the part to callbacks
        if let Some(ref cbs) = callbacks {
            if let Some(ref on_part) = cbs.on_message_part {
                (on_part)(part.clone());
            }
        }

        // Handle tool call part index remapping
        if is_tool_call_part(&part) {
            if let StreamedMessagePart::ToolCallPart(ref tcp) = part {
                if let Some(ref idx) = tcp.index {
                    if !is_pending_tool_call_at_index(&pending_part, idx) {
                        if let Some(&array_idx) = tool_call_index_map.get(idx) {
                            if let Some(target) = message.tool_calls.get_mut(array_idx) {
                                if let Some(ref ap) = tcp.arguments_part {
                                    target.arguments = match target.arguments.take() {
                                        Some(existing) => Some(existing + ap),
                                        None => Some(ap.clone()),
                                    };
                                }
                                continue;
                            }
                        }
                    }
                }
            }
        }

        // Merge or flush
        match pending_part.take() {
            None => {
                pending_part = Some(part.clone());
            }
            Some(mut prev) => {
                if !merge_in_place(&mut prev, &part) {
                    flush_part(&mut message, prev, &mut tool_call_index_map);
                    pending_part = Some(part.clone());
                } else {
                    pending_part = Some(prev);
                }
            }
        }

        last_resume_at = now_ms();
        client_consume_ms += last_resume_at.saturating_sub(arrived_at);
    }

    // Check abort after stream ends
    if let Some(ref signal) = options.signal {
        if *signal.borrow() {
            return Err(ChatProviderError::Provider("The operation was aborted.".to_string()));
        }
    }

    // Final timing
    if let Some(_first) = first_part_at {
        server_decode_ms += now_ms().saturating_sub(last_resume_at);
    }
    if let Some(ref cb) = options.on_stream_end {
        let stats = first_part_at.map(|_| super::provider::StreamDecodeStats {
            server_decode_ms,
            client_consume_ms,
        });
        (cb)(stats);
    }

    // Flush remaining pending part
    if let Some(part) = pending_part {
        flush_part(&mut message, part, &mut tool_call_index_map);
    }

    // Validate response
    if message.content.is_empty() && message.tool_calls.is_empty() {
        return Err(ChatProviderError::ApiEmptyResponse {
            message: format!(
                "The API returned an empty response. Provider: {}, model: {}",
                provider.name(),
                provider.model_name()
            ),
            finish_reason: stream.finish_reason.map(|f| format!("{:?}", f)),
            raw_finish_reason: stream.raw_finish_reason.clone(),
        });
    }

    let has_think = message.content.iter().any(|p| matches!(p, ContentPart::Think { .. }));
    let has_text = message
        .content
        .iter()
        .any(|p| {
            if let ContentPart::Text { text } = p {
                !text.trim().is_empty()
            } else {
                false
            }
        });
    let has_tool_calls = !message.tool_calls.is_empty();

    if has_think && !has_text && !has_tool_calls {
        return Err(ChatProviderError::ApiEmptyResponse {
            message: format!(
                "The API returned a response containing only thinking content. Provider: {}, model: {}",
                provider.name(),
                provider.model_name()
            ),
            finish_reason: stream.finish_reason.map(|f| format!("{:?}", f)),
            raw_finish_reason: stream.raw_finish_reason.clone(),
        });
    }

    // Forward tool calls to callback
    if let Some(ref cbs) = callbacks {
        if let Some(ref on_tool_call) = cbs.on_tool_call {
            for tool_call in &message.tool_calls {
                (on_tool_call)(tool_call.clone());
            }
        }
    }

    Ok(GenerateResult {
        id: stream.id,
        message,
        usage: stream.usage,
        finish_reason: stream.finish_reason,
        raw_finish_reason: stream.raw_finish_reason,
        trace_id: stream.trace_id,
    })
}

/// Check if the pending part is a tool call at the given stream index.
fn is_pending_tool_call_at_index(
    pending: &Option<StreamedMessagePart>,
    index: &serde_json::Value,
) -> bool {
    match pending {
        Some(StreamedMessagePart::ToolCall(tc)) => {
            tc._stream_index.as_ref().map_or(false, |si| si == index)
        }
        _ => false,
    }
}

/// Flush a completed part into the message.
fn flush_part(
    message: &mut Message,
    part: StreamedMessagePart,
    tool_call_index_map: &mut HashMap<serde_json::Value, usize>,
) {
    match part {
        StreamedMessagePart::Content(content) => {
            message.content.push(content);
        }
        StreamedMessagePart::ToolCall(tc) => {
            let stream_index = tc._stream_index.clone();
            let ordinal = message.tool_calls.len();
            message.tool_calls.push(tc);
            if let Some(idx) = stream_index {
                tool_call_index_map.insert(idx, ordinal);
            }
        }
        StreamedMessagePart::ToolCallPart(_) => {
            // Orphaned tool call part (shouldn't happen in practice)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kosong::contract::message::create_user_message;
    use crate::rpc::types::BoxFuture;

    /// A mock provider for testing the generate driver.
    struct MockProvider {
        name: String,
        model_name: String,
    }

    impl ChatProvider for MockProvider {
        fn name(&self) -> &str {
            &self.name
        }
        fn model_name(&self) -> &str {
            &self.model_name
        }
        fn thinking_effort(&self) -> Option<&super::super::provider::ThinkingEffort> {
            None
        }
        fn max_completion_tokens(&self) -> Option<u32> {
            None
        }
        fn generate(
            &self,
            _system_prompt: &str,
            _tools: &[Tool],
            _history: &[Message],
            _options: &GenerateOptions,
        ) -> BoxFuture<'_, Result<super::super::provider::StreamedMessage, ChatProviderError>> {
            use futures_util::stream;
            use crate::kosong::contract::provider::StreamedMessage;
            let parts = vec![
                StreamedMessagePart::Content(ContentPart::Text {
                    text: "Hello!".to_string(),
                }),
            ];
            Box::pin(async {
                Ok(StreamedMessage::new(Box::pin(stream::iter(parts))))
            })
        }
    }

    #[tokio::test]
    async fn test_generate_basic() {
        let provider = MockProvider {
            name: "test".to_string(),
            model_name: "test-model".to_string(),
        };
        let history = vec![create_user_message("hi")];
        let result = generate(
            &provider,
            "",
            &[],
            &history,
            None,
            &GenerateOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(result.message.role, message::Role::Assistant);
        assert!(message::get_text_content(&result.message).contains("Hello!"));
    }
}