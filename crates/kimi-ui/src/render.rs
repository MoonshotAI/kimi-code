//! Wire-shape renderers: engine events -> progress lines, session context ->
//! transcript text. Ported from the kimi-cli binary so the future TUI can
//! share them.

/// Render an engine event as a compact human-readable progress line. Returns
/// `None` for unknown event types so the caller can fall back to raw output.
pub fn render_event(event: &serde_json::Value) -> Option<String> {
    let r#type = event.get("type")?.as_str()?;
    // Field accessor tolerant of both string and number payloads (turn_id,
    // task_id are numbers; tool_name, session_id are strings).
    let field = |name: &str| -> String {
        match event.get(name) {
            Some(v) if v.is_string() => v.as_str().unwrap_or("").to_string(),
            Some(v) if v.is_number() => v.to_string(),
            Some(v) => v.to_string(),
            None => String::new(),
        }
    };
    match r#type {
        "session.turn.started" => {
            Some(format!("turn {} started (session {})", field("turn_id"), field("session_id")))
        }
        "session.turn.ended" => {
            Some(format!("turn {} ended (session {})", field("turn_id"), field("session_id")))
        }
        "session.tool.started" => Some(format!("tool {} started", field("tool_name"))),
        "session.tool.settled" => {
            let ok = !event.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
            let label = if ok { "ok" } else { "error" };
            Some(format!("tool {} -> {label}", field("tool_name")))
        }
        "session.usage.updated" => {
            let total = event.get("total_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            Some(format!("usage: {total} tokens"))
        }
        "session.task.started" => Some(format!("task {} started", field("task_id"))),
        "session.task.terminated" => Some(format!("task {} terminated", field("task_id"))),
        "session.shell.output" => {
            let text = field("content");
            let text = if text.len() > 80 { format!("{}…", &text[..80]) } else { text.to_string() };
            Some(format!("shell: {text}"))
        }
        "session.compaction.started" => Some("context compaction started".to_string()),
        "session.approval.requested" => Some("approval requested".to_string()),
        "session.goal.updated" => Some("goal updated".to_string()),
        "session.hook.result" => Some(format!("hook ran: {}", field("name"))),
        _ => None,
    }
}

/// Extract the last assistant message's text from a `session/get_context`
/// result (print-mode parity: the CLI renders the transcript, not the RPC
/// envelope). Returns `None` when the context has no assistant text.
pub fn last_assistant_text(context: &serde_json::Value) -> Option<String> {
    let history = context["history"].as_array()?;
    for message in history.iter().rev() {
        if message["role"].as_str() != Some("assistant") {
            continue;
        }
        let text: String = message["content"]
            .as_array()?
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("");
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{last_assistant_text, render_event};

    #[test]
    fn render_known_event_types() {
        let cases = [
            (
                serde_json::json!({ "type": "session.turn.started", "session_id": "s1", "turn_id": 3 }),
                "turn 3 started (session s1)",
            ),
            (
                serde_json::json!({ "type": "session.turn.ended", "session_id": "s1", "turn_id": 3 }),
                "turn 3 ended (session s1)",
            ),
            (
                serde_json::json!({ "type": "session.tool.started", "tool_name": "Read" }),
                "tool Read started",
            ),
            (
                serde_json::json!({ "type": "session.tool.settled", "tool_name": "Read", "is_error": true }),
                "tool Read -> error",
            ),
            (
                serde_json::json!({ "type": "session.usage.updated", "total_tokens": 42 }),
                "usage: 42 tokens",
            ),
            (
                serde_json::json!({ "type": "session.compaction.started" }),
                "context compaction started",
            ),
        ];
        for (event, expected) in cases {
            assert_eq!(render_event(&event).as_deref(), Some(expected), "event: {event}");
        }
    }

    #[test]
    fn render_unknown_event_passes_through() {
        let event = serde_json::json!({ "type": "mystery.thing", "x": 1 });
        assert_eq!(render_event(&event), None);
    }

    #[test]
    fn last_assistant_text_extracts_transcript() {
        let context = serde_json::json!({
            "history": [
                { "role": "user", "content": [{ "type": "text", "text": "hi" }] },
                { "role": "assistant", "content": [{ "type": "text", "text": "hello " }, { "type": "text", "text": "world" }] },
                { "role": "user", "content": [{ "type": "text", "text": "again" }] },
                { "role": "assistant", "content": [] },
            ],
            "token_count": 10,
        });
        assert_eq!(
            last_assistant_text(&context).as_deref(),
            Some("hello world"),
            "joins text parts of the last assistant message with text"
        );
    }

    #[test]
    fn last_assistant_text_none_when_no_text() {
        assert_eq!(last_assistant_text(&serde_json::json!({ "history": [] })), None);
        let context = serde_json::json!({
            "history": [{ "role": "user", "content": [{ "type": "text", "text": "hi" }] }]
        });
        assert_eq!(last_assistant_text(&context), None);
    }
}
