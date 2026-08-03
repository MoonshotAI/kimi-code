//! Stream generation and merging logic.
//! Mirrors `packages/kosong/src/generate.ts`.

use crate::message::*;

/// Merge a new streamed part into a pending part, or return false if they cannot merge.
pub fn merge_in_place(pending: &mut StreamedMessagePart, next: &StreamedMessagePart) -> bool {
    match (pending.part_type.as_str(), next.part_type.as_str()) {
        ("text", "text") => {
            if let (Some(ref mut t), Some(ref n)) = (&mut pending.text, &next.text) {
                t.push_str(n);
                return true;
            }
            false
        }
        ("think", "think") => {
            if let (Some(ref mut t), Some(ref n)) = (&mut pending.think, &next.think) {
                t.push_str(n);
                return true;
            }
            false
        }
        ("function", "tool_call_part") => {
            // Merge tool call argument deltas into the pending tool call
            if let (Some(ref mut args), Some(ref part)) =
                (&mut pending.arguments, &next.arguments_part)
            {
                args.push_str(part);
                return true;
            }
            false
        }
        _ => false,
    }
}

/// Flush a pending part into the message content or tool calls.
pub fn flush_part(
    message: &mut Message,
    part: StreamedMessagePart,
) {
    match part.part_type.as_str() {
        "text" | "think" | "image_url" | "audio_url" | "video_url" => {
            message.content.push(ContentPart {
                part_type: part.part_type,
                text: part.text,
                image_url: part.image_url,
                audio_url: part.audio_url,
                video_url: part.video_url,
                think: part.think,
                encrypted: part.encrypted,
            });
        }
        "function" => {
            message.tool_calls.push(ToolCall {
                id: part.id.unwrap_or_default(),
                name: part.name.unwrap_or_default(),
                arguments: part.arguments,
            });
        }
        _ => {
            // tool_call_part — orphaned delta, ignored
        }
    }
}