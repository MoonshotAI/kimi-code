//! Session-history rendering — rebuild the transcript from the engine's
//! context when resuming an existing session (TS `session-replay.ts`
//! `hydrateFromReplay` parity). Pure function over the wire shape, so it is
//! unit-testable without a running engine.

use crate::app::TranscriptLine;

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
/// `{ history: […], token_count }`) as transcript lines. User prompts become
/// `▶` lines, assistant text becomes assistant lines (prefixed by a tool
/// line per `tool_calls`), tool messages become `⚙` lines. Empty text and
/// system framing are skipped.
pub fn render_history(data: &serde_json::Value) -> Vec<TranscriptLine> {
    let mut lines = Vec::new();
    let Some(history) = data.get("history").and_then(|h| h.as_array()) else {
        return lines;
    };
    for message in history {
        let role = message["role"].as_str().unwrap_or("");
        match role {
            "user" => {
                let text = text_content(message);
                if !text.is_empty() {
                    lines.push(TranscriptLine::user(text));
                }
            }
            "assistant" => {
                // Tool calls first (if any), then the assistant text — the
                // order the turn produced them in.
                if let Some(calls) = message["tool_calls"].as_array() {
                    for call in calls {
                        let name = call["name"].as_str().unwrap_or("tool");
                        lines.push(TranscriptLine::tool(format!("{name}(…)")));
                    }
                }
                let text = text_content(message);
                if !text.is_empty() {
                    lines.push(TranscriptLine::assistant(text));
                }
            }
            "tool" => {
                let text = text_content(message);
                if !text.is_empty() {
                    lines.push(TranscriptLine::tool(text));
                }
            }
            _ => {}
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::TranscriptKind;

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
        assert_eq!(lines[0].kind, TranscriptKind::User);
        assert_eq!(lines[0].text, "hi");
        assert_eq!(lines[1].kind, TranscriptKind::Assistant);
        assert_eq!(lines[1].text, "hello");
        assert_eq!(lines[2].kind, TranscriptKind::User);
        assert_eq!(lines[2].text, "again");
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
        assert_eq!(lines[1].kind, TranscriptKind::Tool);
        assert_eq!(lines[1].text, "Bash(…)");
        assert_eq!(lines[2].text, "done");
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
        assert_eq!(lines[1].kind, TranscriptKind::Tool);
        assert_eq!(lines[1].text, "ok");
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
