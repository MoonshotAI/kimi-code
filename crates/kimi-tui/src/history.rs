//! Session-history rendering — rebuild the transcript from the engine's
//! context when resuming an existing session (TS `session-replay.ts`
//! `hydrateFromReplay` parity). Pure function over the wire shape, so it is
//! unit-testable without a running engine.

use crate::app::{ToolCallEntry, TranscriptEntry, TranscriptLine};

/// Join the text parts of an engine message's `content` array
/// (`[{"type":"text","text":…}, …]`).
fn text_content(message: &serde_json::Value) -> String {
    message["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| {
                    if p["type"].as_str() == Some("text") {
                        p["text"].as_str().map(str::to_string)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

/// Render the engine context data (`session/get_context` → `data()`:
/// `{ history: […], token_count }`) as transcript entries. User prompts
/// become `✨` lines, assistant text becomes assistant lines, and assistant
/// `tool_calls` / `tool` messages become structured `ToolCall` cards (TS
/// `session-replay` parity). Empty text and system framing are skipped.
pub fn render_history(data: &serde_json::Value) -> Vec<TranscriptEntry> {
    let mut entries = Vec::new();
    let Some(history) = data.get("history").and_then(|h| h.as_array()) else {
        return entries;
    };
    for message in history {
        let role = message["role"].as_str().unwrap_or("");
        match role {
            "user" => {
                let text = text_content(message);
                if !text.is_empty() {
                    entries.push(TranscriptEntry::Line(TranscriptLine::user(text)));
                }
            }
            "assistant" => {
                // Tool calls first (if any), then the assistant text — the
                // order the turn produced them in.
                if let Some(calls) = message["tool_calls"].as_array() {
                    for call in calls {
                        let tool_call_id = call["id"].as_str().unwrap_or("").to_string();
                        let tool_name = call["name"].as_str().unwrap_or("tool").to_string();
                        let args = serde_json::to_string(&call["arguments"]).unwrap_or_default();
                        let collapsed = args.chars().count() > crate::app::TOOL_COLLAPSE_THRESHOLD;
                        let is_question = tool_name == "AskUserQuestion";
                        entries.push(TranscriptEntry::ToolCall(ToolCallEntry {
                            tool_call_id,
                            tool_name,
                            args,
                            result: None,
                            is_error: false,
                            is_question,
                            duration: None,
                            collapsed,
                        }));
                    }
                }
                let text = text_content(message);
                if !text.is_empty() {
                    entries.push(TranscriptEntry::Line(TranscriptLine::assistant(text)));
                }
            }
            "tool" => {
                // A tool-result message renders as a tool line (the matching
                // ToolCall card carries the full result when it exists).
                let text = text_content(message);
                if !text.is_empty() {
                    entries.push(TranscriptEntry::Line(TranscriptLine::tool(text)));
                }
            }
            _ => {}
        }
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{TranscriptEntry, TranscriptKind, TranscriptLine};

    /// Unwrap a plain Line entry (test helper).
    fn line(entry: &TranscriptEntry) -> &TranscriptLine {
        match entry {
            TranscriptEntry::Line(l) => l,
            TranscriptEntry::ToolCall(_) => panic!("expected a Line entry"),
        }
    }

    #[test]
    fn renders_user_and_assistant_in_order() {
        let data = serde_json::json!({
            "history": [
                { "role": "user", "content": [{ "type": "text", "text": "hi" }] },
                { "role": "assistant", "content": [{ "type": "text", "text": "hello" }] },
                { "role": "user", "content": [{ "type": "text", "text": "again" }] },
            ],
            "token_count": 10,
        });
        let lines = render_history(&data);
        assert_eq!(lines.len(), 3, "three visible messages: {lines:?}");
        assert_eq!(line(&lines[0]).kind, TranscriptKind::User);
        assert_eq!(line(&lines[0]).text, "hi");
        assert_eq!(line(&lines[1]).kind, TranscriptKind::Assistant);
        assert_eq!(line(&lines[1]).text, "hello");
        assert_eq!(line(&lines[2]).kind, TranscriptKind::User);
        assert_eq!(line(&lines[2]).text, "again");
    }

    #[test]
    fn assistant_tool_calls_render_as_tool_lines() {
        let data = serde_json::json!({
            "history": [
                { "role": "user", "content": [{ "type": "text", "text": "run" }] },
                {
                    "role": "assistant",
                    "content": [],
                    "tool_calls": [{ "name": "Bash", "arguments": { "command": "ls" } }],
                },
                { "role": "assistant", "content": [{ "type": "text", "text": "done" }] },
            ],
        });
        let lines = render_history(&data);
        assert_eq!(lines.len(), 3, "user + tool + assistant: {lines:?}");
        // Assistant tool_calls now render as structured ToolCall cards.
        assert!(
            matches!(lines[1], TranscriptEntry::ToolCall(_)),
            "tool card: {lines:?}"
        );
        assert_eq!(line(&lines[2]).text, "done");
    }

    #[test]
    fn tool_messages_render_as_tool_lines() {
        let data = serde_json::json!({
            "history": [
                { "role": "user", "content": [{ "type": "text", "text": "go" }] },
                { "role": "tool", "content": [{ "type": "text", "text": "ok" }] },
            ],
        });
        let lines = render_history(&data);
        assert_eq!(lines.len(), 2);
        assert_eq!(line(&lines[1]).kind, TranscriptKind::Tool);
        assert_eq!(line(&lines[1]).text, "ok");
    }

    #[test]
    fn empty_and_system_messages_are_skipped() {
        let data = serde_json::json!({
            "history": [
                { "role": "system", "content": [{ "type": "text", "text": "ignored" }] },
                { "role": "user", "content": [] },
                { "role": "assistant", "content": [{ "type": "image", "url": "x" }] },
            ],
        });
        assert!(render_history(&data).is_empty(), "no renderable content");
    }
}
