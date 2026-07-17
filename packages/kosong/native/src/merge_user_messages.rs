//! Merge consecutive user messages (required by strict Anthropic-compatible backends).
//! Mirrors `packages/kosong/src/providers/merge-user-messages.ts`.

use crate::message::Message;

/// Merge consecutive user messages into one.
/// Anthropic-compatible backends reject consecutive user messages with HTTP 400.
pub fn merge_consecutive_user_messages(messages: Vec<Message>) -> Vec<Message> {
    let mut result: Vec<Message> = Vec::with_capacity(messages.len());

    for msg in messages {
        if msg.role == "user" {
            if let Some(last) = result.last_mut() {
                if last.role == "user" {
                    // Merge content
                    last.content.extend(msg.content);
                    if !msg.tool_calls.is_empty() {
                        last.tool_calls.extend(msg.tool_calls);
                    }
                    if msg.tool_call_id.is_some() {
                        last.tool_call_id = msg.tool_call_id;
                    }
                    continue;
                }
            }
        }
        result.push(msg);
    }

    result
}