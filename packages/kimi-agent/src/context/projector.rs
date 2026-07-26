/// Message projection — transform stored context history into wire-valid messages.
///
/// Corresponds to `packages/agent-core/src/agent/context/projector.ts`.

use crate::context::types::*;
use crate::context::tool_result_render::{render_tool_result_for_model, RenderableToolResult, ToolResultOutput};
use sha2::{Digest, Sha256};

/// How many of the most recent media parts survive the media-degraded projection.
pub const MEDIA_DEGRADE_KEEP_RECENT: usize = 2;

const MEDIA_DEGRADED_PLACEHOLDER_IMAGE: &str =
    "[image omitted: dropped to fit the provider request size limit; re-read the file to view it]";
const MEDIA_DEGRADED_PLACEHOLDER_AUDIO: &str =
    "[audio omitted: dropped to fit the provider request size limit; re-read the file to hear it]";
const MEDIA_DEGRADED_PLACEHOLDER_VIDEO: &str =
    "[video omitted: dropped to fit the provider request size limit; re-read the file to view it]";

const MEDIA_STRIPPED_PLACEHOLDER_IMAGE: &str =
    "[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]";
const MEDIA_STRIPPED_PLACEHOLDER_AUDIO: &str =
    "[audio omitted for provider compatibility; re-read the file to hear it]";
const MEDIA_STRIPPED_PLACEHOLDER_VIDEO: &str =
    "[video omitted for provider compatibility; re-read the file to view it]";

/// Project stored context history into wire-valid messages.
pub fn project(history: &[ContextMessage], options: &ProjectOptions) -> Vec<ContextMessage> {
    let mut result = merge_adjacent_user_messages(history, options);

    if options.dedupe_duplicate_tool_calls {
        result = dedupe_duplicate_tool_calls(&result, options);
    }

    result = repair_tool_exchange_adjacency(&result, options);

    if options.merge_consecutive_assistants {
        result = merge_consecutive_assistant_messages(&result, options);
    }

    if options.drop_orphan_results {
        result = drop_orphan_tool_results(&result, options);
    }

    if options.drop_leading_non_user {
        result = drop_leading_non_user_messages(&result, options);
    }

    result
}

/// Merge adjacent user messages into one.
fn merge_adjacent_user_messages(
    history: &[ContextMessage],
    options: &ProjectOptions,
) -> Vec<ContextMessage> {
    let mut out: Vec<ContextMessage> = Vec::new();

    for source in history {
        let Some(message) = prepare_message_for_projection(source, options) else {
            continue;
        };

        if let Some(previous) = out.last_mut() {
            if can_merge_user_message(&message) && can_merge_user_message(previous) {
                *previous = merge_two_user_messages(previous, &message);
                continue;
            }
        }
        out.push(message);
    }

    out.into_iter().map(strip_context_metadata).collect()
}

/// Prepare a message for projection: render tool results, drop empty text blocks.
fn prepare_message_for_projection(
    message: &ContextMessage,
    options: &ProjectOptions,
) -> Option<ContextMessage> {
    if message.partial == Some(true) {
        return None;
    }

    // Render tool results for model consumption.
    let source = if message.role == "tool" {
        let rendered = render_tool_result_for_model(RenderableToolResult {
            output: ToolResultOutput::Parts(message.content.clone()),
            note: message.note.clone(),
            is_error: message.is_error.unwrap_or(false),
        });
        let mut m = message.clone();
        m.content = rendered;
        m
    } else {
        message.clone()
    };

    // Filter out whitespace-only text blocks.
    let mut content: Vec<ContentPart> = Vec::new();
    let mut had_whitespace = false;
    let mut had_empty = false;

    for part in &source.content {
        if let ContentPart::Text { text } = part {
            if text.trim().is_empty() {
                if text.len() > 0 {
                    had_whitespace = true;
                }
                had_empty = true;
                continue;
            }
        }
        content.push(part.clone());
    }

    let next = if had_empty {
        let mut m = source;
        m.content = content;
        m
    } else {
        source
    };

    if had_whitespace {
        if let Some(ref on_anomaly) = options.on_anomaly {
            on_anomaly(ProjectionAnomaly::WhitespaceTextDropped {
                role: next.role.clone(),
            });
        }
    }

    // Tool result with empty content after filtering is an error.
    if next.role == "tool" && next.content.is_empty() {
        return None; // This maps to the KimiError thrown in TS
    }

    // Messages with tools definitions survive even if content is empty.
    if next.tools.as_ref().is_some_and(|t| !t.is_empty()) {
        return Some(next);
    }
    if !next.tool_calls.is_empty() {
        return Some(next);
    }
    if next.content.is_empty() {
        return None;
    }

    // Check for vacuous messages (every part is empty text/thinking).
    if next.content.iter().all(|p| is_vacuous_content_part(p)) {
        if let Some(ref on_anomaly) = options.on_anomaly {
            on_anomaly(ProjectionAnomaly::VacuousMessageDropped {
                role: next.role.clone(),
            });
        }
        return None;
    }

    Some(next)
}

/// Check if a content part is vacuous (empty text or thinking).
fn is_vacuous_content_part(part: &ContentPart) -> bool {
    match part {
        ContentPart::Text { text } => text.trim().is_empty(),
        ContentPart::Think { think, encrypted, .. } => {
            encrypted.is_none() && think.as_ref().map_or(true, |t| t.trim().is_empty())
        }
        _ => false,
    }
}

/// Check if a user message can be merged (real user input).
fn can_merge_user_message(message: &ContextMessage) -> bool {
    message.role == "user"
        && message.origin.as_ref().map_or(false, |o| matches!(o, MessageOrigin::User))
}

/// Merge two user messages into one.
fn merge_two_user_messages(a: &ContextMessage, b: &ContextMessage) -> ContextMessage {
    let a_text = extract_text_only(a);
    let b_text = extract_text_only(b);
    let non_text_parts: Vec<ContentPart> = a.content.iter()
        .filter(|p| !matches!(p, ContentPart::Text { .. }))
        .chain(b.content.iter().filter(|p| !matches!(p, ContentPart::Text { .. })))
        .cloned()
        .collect();

    let mut content = vec![ContentPart::Text {
        text: format!("{a_text}\n\n{b_text}"),
    }];
    content.extend(non_text_parts);

    ContextMessage {
        role: "user".to_string(),
        content,
        tool_calls: vec![],
        origin: a.origin.clone(),
        ..Default::default()
    }
}

/// Extract text content from a message.
fn extract_text_only(message: &ContextMessage) -> String {
    message.content
        .iter()
        .filter_map(|p| {
            if let ContentPart::Text { text } = p {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("")
}

/// Strip context metadata from a message (origin, is_error, etc.) for provider output.
fn strip_context_metadata(message: ContextMessage) -> ContextMessage {
    ContextMessage {
        role: message.role,
        name: message.name,
        content: message.content,
        tool_calls: message.tool_calls,
        tool_call_id: message.tool_call_id,
        ..Default::default()
    }
}

/// Repair tool exchange adjacency: move tool results next to their calls.
fn repair_tool_exchange_adjacency(
    messages: &[ContextMessage],
    options: &ProjectOptions,
) -> Vec<ContextMessage> {
    // Find the last non-tool message index.
    let mut last_non_tool_index = messages.len().saturating_sub(1);
    while last_non_tool_index > 0 && messages.get(last_non_tool_index).map_or(false, |m| m.role == "tool") {
        last_non_tool_index -= 1;
    }

    let mut out: Vec<ContextMessage> = Vec::new();
    let mut consumed: Vec<bool> = vec![false; messages.len()];
    let mut anomaly_fn = |anomaly: ProjectionAnomaly| {
        if let Some(ref on_anomaly) = options.on_anomaly {
            on_anomaly(anomaly);
        }
    };

    for i in 0..messages.len() {
        if consumed[i] {
            continue;
        }
        let Some(message) = messages.get(i) else { continue; };

        if message.role != "assistant" || message.tool_calls.is_empty() {
            out.push(message.clone());
            continue;
        }

        out.push(message.clone());
        let mut pending: Vec<String> = message.tool_calls.iter().map(|tc| tc.id.clone()).collect();
        let mut foreign_between = false;

        for j in (i + 1)..messages.len() {
            if j >= consumed.len() || consumed[j] || pending.is_empty() {
                continue;
            }
            let Some(next) = messages.get(j) else { continue; };
            if next.role == "tool" {
                if let Some(ref tool_call_id) = next.tool_call_id {
                    if let Some(pos) = pending.iter().position(|id| id == tool_call_id) {
                        out.push(next.clone());
                        consumed[j] = true;
                        pending.remove(pos);
                        if foreign_between {
                            anomaly_fn(ProjectionAnomaly::ToolResultReordered {
                                tool_call_id: tool_call_id.clone(),
                            });
                        }
                        continue;
                    }
                }
            }
            foreign_between = true;
        }

        // Synthesize missing results.
        let is_mid_history = i < last_non_tool_index;
        if options.synthesize_missing || is_mid_history {
            for missing_id in &pending {
                out.push(make_synthetic_tool_result(missing_id));
                anomaly_fn(ProjectionAnomaly::ToolResultSynthesized {
                    tool_call_id: missing_id.clone(),
                    trailing: !is_mid_history,
                });
            }
        }
    }

    out
}

/// Create a synthetic tool result message.
fn make_synthetic_tool_result(tool_call_id: &str) -> ContextMessage {
    ContextMessage {
        role: "tool".to_string(),
        content: vec![ContentPart::Text {
            text: SYNTHETIC_TOOL_RESULT_TEXT.to_string(),
        }],
        tool_calls: vec![],
        tool_call_id: Some(tool_call_id.to_string()),
        ..Default::default()
    }
}

/// Deduplicate duplicate tool call ids.
fn dedupe_duplicate_tool_calls(
    messages: &[ContextMessage],
    options: &ProjectOptions,
) -> Vec<ContextMessage> {
    let mut seen_tool_call_ids: Vec<String> = Vec::new();
    let mut seen_tool_result_ids: Vec<String> = Vec::new();
    let mut out: Vec<ContextMessage> = Vec::new();

    for message in messages {
        if message.role == "assistant" && !message.tool_calls.is_empty() {
            let kept: Vec<ToolCall> = message.tool_calls.iter()
                .filter(|tc| {
                    if seen_tool_call_ids.contains(&tc.id) {
                        if let Some(ref on_anomaly) = options.on_anomaly {
                            on_anomaly(ProjectionAnomaly::DuplicateToolCallDropped {
                                tool_call_id: tc.id.clone(),
                            });
                        }
                        false
                    } else {
                        seen_tool_call_ids.push(tc.id.clone());
                        true
                    }
                })
                .cloned()
                .collect();

            if kept.len() == message.tool_calls.len() {
                out.push(message.clone());
            } else if !kept.is_empty() || !message.content.iter().all(|p| is_vacuous_content_part(p)) {
                let mut m = message.clone();
                m.tool_calls = kept;
                out.push(m);
            } else if !message.content.is_empty() {
                if let Some(ref on_anomaly) = options.on_anomaly {
                    on_anomaly(ProjectionAnomaly::VacuousMessageDropped {
                        role: message.role.clone(),
                    });
                }
            }
            continue;
        }

        if message.role == "tool" {
            if let Some(ref tool_call_id) = message.tool_call_id {
                if seen_tool_result_ids.contains(tool_call_id) {
                    if let Some(ref on_anomaly) = options.on_anomaly {
                        on_anomaly(ProjectionAnomaly::DuplicateToolResultDropped {
                            tool_call_id: tool_call_id.clone(),
                        });
                    }
                    continue;
                }
                seen_tool_result_ids.push(tool_call_id.clone());
            }
        }

        out.push(message.clone());
    }

    out
}

/// Drop orphan tool results (no matching call).
fn drop_orphan_tool_results(
    messages: &[ContextMessage],
    options: &ProjectOptions,
) -> Vec<ContextMessage> {
    let tool_use_ids: Vec<String> = messages.iter()
        .filter(|m| m.role == "assistant")
        .flat_map(|m| m.tool_calls.iter().map(|tc| tc.id.clone()))
        .collect();

    messages.iter().filter(|message| {
        if message.role != "tool" {
            return true;
        }
        if let Some(ref tool_call_id) = message.tool_call_id {
            if tool_use_ids.contains(tool_call_id) {
                return true;
            }
            if let Some(ref on_anomaly) = options.on_anomaly {
                on_anomaly(ProjectionAnomaly::OrphanToolResultDropped {
                    tool_call_id: tool_call_id.clone(),
                });
            }
            return false;
        }
        true
    }).cloned().collect()
}

/// Merge consecutive assistant messages.
fn merge_consecutive_assistant_messages(
    messages: &[ContextMessage],
    options: &ProjectOptions,
) -> Vec<ContextMessage> {
    let mut out: Vec<ContextMessage> = Vec::new();

    for message in messages {
        if let Some(previous) = out.last_mut() {
            if previous.role == "assistant" && message.role == "assistant" {
                let mut merged = previous.clone();
                merged.content.extend(message.content.clone());
                merged.tool_calls.extend(message.tool_calls.clone());
                *previous = merged;
                if let Some(ref on_anomaly) = options.on_anomaly {
                    on_anomaly(ProjectionAnomaly::ConsecutiveAssistantsMerged);
                }
                continue;
            }
        }
        out.push(message.clone());
    }

    out
}

/// Drop leading non-user messages.
fn drop_leading_non_user_messages(
    messages: &[ContextMessage],
    options: &ProjectOptions,
) -> Vec<ContextMessage> {
    let mut start = 0;
    while start < messages.len() && messages[start].role != "user" {
        if let Some(ref on_anomaly) = options.on_anomaly {
            on_anomaly(ProjectionAnomaly::LeadingNonUserDropped {
                role: messages[start].role.clone(),
            });
        }
        start += 1;
    }
    if start == 0 {
        messages.to_vec()
    } else {
        messages[start..].to_vec()
    }
}

/// Trim trailing open tool exchange (remove dangling tool calls without results).
pub fn trim_trailing_open_tool_exchange(history: &[ContextMessage]) -> Vec<ContextMessage> {
    let mut last_non_tool_index = history.len().saturating_sub(1);
    while last_non_tool_index > 0
        && history.get(last_non_tool_index).map_or(false, |m| m.role == "tool")
    {
        last_non_tool_index -= 1;
    }

    let Some(assistant) = history.get(last_non_tool_index) else {
        return vec![];
    };
    if assistant.role != "assistant" || assistant.tool_calls.is_empty() {
        return history.to_vec();
    }

    let trailing_tool_call_ids: Vec<String> = history[last_non_tool_index + 1..]
        .iter()
        .filter_map(|m| m.tool_call_id.clone())
        .collect();

    let all_closed = assistant.tool_calls.iter()
        .all(|tc| trailing_tool_call_ids.contains(&tc.id));

    if all_closed {
        history.to_vec()
    } else {
        history[..last_non_tool_index].to_vec()
    }
}

/// Capture the provider-visible media content identity snapshot.
pub fn capture_media_strip_snapshot(messages: &[ContextMessage]) -> MediaStripSnapshot {
    let mut snapshot = Vec::new();
    for message in messages {
        for part in &message.content {
            if let Some(key) = media_strip_key(part) {
                snapshot.push(key);
            }
        }
    }
    snapshot
}

/// Strip media parts by snapshot (replace with text markers).
pub fn strip_media_parts_by_snapshot(
    messages: &[ContextMessage],
    snapshot: &MediaStripSnapshot,
) -> Vec<ContextMessage> {
    let mut changed = false;
    let result: Vec<ContextMessage> = messages.iter().map(|message| {
        let mut message_changed = false;
        let content: Vec<ContentPart> = message.content.iter().map(|part| {
            if let Some(key) = media_strip_key(part) {
                if snapshot.contains(&key) {
                    changed = true;
                    message_changed = true;
                    return media_stripped_placeholder(part);
                }
            }
            part.clone()
        }).collect();
        if message_changed {
            let mut m = message.clone();
            m.content = content;
            m
        } else {
            message.clone()
        }
    }).collect();

    if changed { result } else { messages.to_vec() }
}

/// Degrade older media parts to text markers.
pub fn degrade_older_media_parts(
    messages: &[ContextMessage],
    keep_recent: usize,
) -> Vec<ContextMessage> {
    let media_count: usize = messages.iter()
        .flat_map(|m| &m.content)
        .filter(|p| is_degradable_media_part(p))
        .count();

    let mut to_degrade = media_count.saturating_sub(keep_recent);
    if to_degrade == 0 {
        return messages.to_vec();
    }

    messages.iter().map(|message| {
        if to_degrade == 0 || !message.content.iter().any(|p| is_degradable_media_part(p)) {
            return message.clone();
        }
        let content: Vec<ContentPart> = message.content.iter().map(|part| {
            if to_degrade == 0 || !is_degradable_media_part(part) {
                return part.clone();
            }
            to_degrade -= 1;
            media_degraded_placeholder(part)
        }).collect();
        let mut m = message.clone();
        m.content = content;
        m
    }).collect()
}

/// Check if a content part is a degradable media type.
fn is_degradable_media_part(part: &ContentPart) -> bool {
    matches!(part, ContentPart::ImageUrl { .. } | ContentPart::AudioUrl { .. } | ContentPart::VideoUrl { .. })
}

/// Get the media strip key for a content part (SHA-256 digest).
fn media_strip_key(part: &ContentPart) -> Option<String> {
    match part {
        ContentPart::ImageUrl { image_url } => {
            let mut hasher = Sha256::new();
            hasher.update(b"image_url\0");
            hasher.update(image_url.id.as_deref().unwrap_or(""));
            hasher.update(b"\0");
            hasher.update(&image_url.url);
            Some(hex::encode(hasher.finalize()))
        }
        ContentPart::AudioUrl { audio_url } => {
            let mut hasher = Sha256::new();
            hasher.update(b"audio_url\0");
            hasher.update(audio_url.id.as_deref().unwrap_or(""));
            hasher.update(b"\0");
            hasher.update(&audio_url.url);
            Some(hex::encode(hasher.finalize()))
        }
        ContentPart::VideoUrl { video_url } => {
            let mut hasher = Sha256::new();
            hasher.update(b"video_url\0");
            hasher.update(video_url.id.as_deref().unwrap_or(""));
            hasher.update(b"\0");
            hasher.update(&video_url.url);
            Some(hex::encode(hasher.finalize()))
        }
        _ => None,
    }
}

/// Create a media-degraded placeholder text part.
fn media_degraded_placeholder(part: &ContentPart) -> ContentPart {
    let text = match part {
        ContentPart::ImageUrl { .. } => MEDIA_DEGRADED_PLACEHOLDER_IMAGE,
        ContentPart::AudioUrl { .. } => MEDIA_DEGRADED_PLACEHOLDER_AUDIO,
        ContentPart::VideoUrl { .. } => MEDIA_DEGRADED_PLACEHOLDER_VIDEO,
        _ => return part.clone(),
    };
    ContentPart::Text { text: text.to_string() }
}

/// Create a media-stripped placeholder text part.
fn media_stripped_placeholder(part: &ContentPart) -> ContentPart {
    let text = match part {
        ContentPart::ImageUrl { .. } => MEDIA_STRIPPED_PLACEHOLDER_IMAGE,
        ContentPart::AudioUrl { .. } => MEDIA_STRIPPED_PLACEHOLDER_AUDIO,
        ContentPart::VideoUrl { .. } => MEDIA_STRIPPED_PLACEHOLDER_VIDEO,
        _ => return part.clone(),
    };
    ContentPart::Text { text: text.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_msg(text: &str, role: &str) -> ContextMessage {
        ContextMessage {
            role: role.to_string(),
            content: vec![ContentPart::Text { text: text.to_string() }],
            tool_calls: vec![],
            ..Default::default()
        }
    }

    fn user_msg(text: &str) -> ContextMessage {
        ContextMessage {
            role: "user".to_string(),
            content: vec![ContentPart::Text { text: text.to_string() }],
            tool_calls: vec![],
            origin: Some(MessageOrigin::User),
            ..Default::default()
        }
    }

    fn assistant_msg(text: &str) -> ContextMessage {
        text_msg(text, "assistant")
    }

    #[test]
    fn test_project_empty_history() {
        let result = project(&[], &ProjectOptions::default());
        assert!(result.is_empty());
    }

    #[test]
    fn test_project_single_user_message() {
        let history = vec![user_msg("hello")];
        let result = project(&history, &ProjectOptions::default());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].role, "user");
    }

    #[test]
    fn test_project_merge_adjacent_user_messages() {
        let history = vec![
            user_msg("first"),
            user_msg("second"),
            assistant_msg("response"),
        ];
        let result = project(&history, &ProjectOptions::default());
        assert_eq!(result.len(), 2);
        // First two user messages should be merged
        assert_eq!(result[0].role, "user");
        let text = extract_text_only(&result[0]);
        assert!(text.contains("first"));
        assert!(text.contains("second"));
        assert_eq!(result[1].role, "assistant");
    }

    #[test]
    fn test_trim_trailing_open_tool_exchange_no_tools() {
        let history = vec![user_msg("hello"), assistant_msg("world")];
        let result = trim_trailing_open_tool_exchange(&history);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_trim_trailing_open_tool_exchange_closed() {
        let mut assistant = assistant_msg("thinking");
        assistant.tool_calls = vec![ToolCall {
            r#type: "function".to_string(),
            id: "call_1".to_string(),
            name: "read".to_string(),
            arguments: serde_json::json!({}),
            extras: None,
        }];

        let tool_result = ContextMessage {
            role: "tool".to_string(),
            content: vec![ContentPart::Text { text: "result".to_string() }],
            tool_calls: vec![],
            tool_call_id: Some("call_1".to_string()),
            ..Default::default()
        };

        let history = vec![user_msg("hello"), assistant, tool_result];
        let result = trim_trailing_open_tool_exchange(&history);
        assert_eq!(result.len(), 3); // All kept, exchange is closed
    }

    #[test]
    fn test_trim_trailing_open_tool_exchange_open() {
        let mut assistant = assistant_msg("thinking");
        assistant.tool_calls = vec![ToolCall {
            r#type: "function".to_string(),
            id: "call_1".to_string(),
            name: "read".to_string(),
            arguments: serde_json::json!({}),
            extras: None,
        }];

        let history = vec![user_msg("hello"), assistant];
        let result = trim_trailing_open_tool_exchange(&history);
        assert_eq!(result.len(), 1); // Open exchange trimmed
    }

    #[test]
    fn test_degrade_older_media_parts_none() {
        let history = vec![user_msg("hello")];
        let result = degrade_older_media_parts(&history, 2);
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_degrade_older_media_parts_keeps_recent() {
        let history = vec![
            ContextMessage {
                role: "user".to_string(),
                content: vec![
                    ContentPart::ImageUrl {
                        image_url: MediaContainer {
                            url: "data:image/png;base64,abc".to_string(),
                            id: None,
                        },
                    },
                ],
                tool_calls: vec![],
                ..Default::default()
            },
        ];
        let result = degrade_older_media_parts(&history, 2);
        // With keep_recent=2 and only 1 image, no degradation needed
        if let ContentPart::ImageUrl { .. } = &result[0].content[0] {
            // good, not degraded
        } else {
            panic!("expected image to be kept");
        }
    }

    #[test]
    fn test_capture_media_strip_snapshot() {
        let history = vec![
            ContextMessage {
                role: "user".to_string(),
                content: vec![
                    ContentPart::ImageUrl {
                        image_url: MediaContainer {
                            url: "data:image/png;base64,abc".to_string(),
                            id: None,
                        },
                    },
                ],
                tool_calls: vec![],
                ..Default::default()
            },
        ];
        let snapshot = capture_media_strip_snapshot(&history);
        assert_eq!(snapshot.len(), 1);
    }

    #[test]
    fn test_drop_orphan_tool_results() {
        let history = vec![
            user_msg("hello"),
            ContextMessage {
                role: "tool".to_string(),
                content: vec![ContentPart::Text { text: "result".to_string() }],
                tool_calls: vec![],
                tool_call_id: Some("orphan_call".to_string()),
                ..Default::default()
            },
        ];

        let options = ProjectOptions {
            drop_orphan_results: true,
            ..Default::default()
        };
        let result = project(&history, &options);
        assert_eq!(result.len(), 1); // orphan dropped
        assert_eq!(result[0].role, "user");
    }

    #[test]
    fn test_merge_consecutive_assistant_messages() {
        let history = vec![
            assistant_msg("first"),
            assistant_msg("second"),
            user_msg("hello"),
        ];

        let options = ProjectOptions {
            merge_consecutive_assistants: true,
            ..Default::default()
        };
        let result = project(&history, &options);
        assert_eq!(result.len(), 2); // Two assistants merged into one
        assert_eq!(result[0].role, "assistant");
    }

    #[test]
    fn test_drop_leading_non_user_messages() {
        let history = vec![
            assistant_msg("first"),
            user_msg("hello"),
        ];

        let options = ProjectOptions {
            drop_leading_non_user: true,
            ..Default::default()
        };
        let result = project(&history, &options);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].role, "user");
    }

    #[test]
    fn test_synthetic_tool_result() {
        let result = make_synthetic_tool_result("call_1");
        assert_eq!(result.role, "tool");
        assert_eq!(result.tool_call_id, Some("call_1".to_string()));
        assert!(
            if let ContentPart::Text { text } = &result.content[0] {
                text.contains("not available")
            } else {
                false
            }
        );
    }

    /// Test: repair_tool_exchange_adjacency moves displaced results
    #[test]
    fn test_repair_tool_exchange_adjacency() {
        let mut assistant = assistant_msg("thinking");
        assistant.tool_calls = vec![ToolCall {
            r#type: "function".to_string(),
            id: "call_1".to_string(),
            name: "read".to_string(),
            arguments: serde_json::json!({}),
            extras: None,
        }];

        let tool_result = ContextMessage {
            role: "tool".to_string(),
            content: vec![ContentPart::Text { text: "result".to_string() }],
            tool_calls: vec![],
            tool_call_id: Some("call_1".to_string()),
            ..Default::default()
        };

        // Result is displaced by a user message
        let history = vec![user_msg("hello"), assistant, user_msg("interrupt"), tool_result];

        let options = ProjectOptions {
            synthesize_missing: false,
            ..Default::default()
        };
        let result = project(&history, &options);
        // Should have 4 messages: user, assistant+tool_result, user, tool or user, assistant, tool, user
        // The tool_result gets pulled up next to the assistant
        assert_eq!(result.len(), 4);
        assert_eq!(result[0].role, "user");
        assert_eq!(result[1].role, "assistant");
        // The tool result should be at index 2, followed by the interrupt user
    }
}