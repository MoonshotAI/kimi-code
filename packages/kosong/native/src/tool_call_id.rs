//! Tool call ID utilities.
//! Mirrors `packages/kosong/src/providers/tool-call-id.ts`.

/// Sanitize a tool call ID to a maximum length.
pub fn sanitize_tool_call_id(id: &str, max_len: usize) -> String {
    if id.len() <= max_len {
        id.to_string()
    } else {
        id[..max_len].to_string()
    }
}

/// Normalize tool call IDs in a list of messages for a given provider policy.
///
/// Returns the messages with tool call IDs sanitized.
pub fn normalize_tool_call_ids(
    messages: Vec<crate::message::Message>,
    max_id_len: usize,
) -> Vec<crate::message::Message> {
    messages
        .into_iter()
        .map(|mut msg| {
            for tc in &mut msg.tool_calls {
                tc.id = sanitize_tool_call_id(&tc.id, max_id_len);
            }
            msg
        })
        .collect()
}