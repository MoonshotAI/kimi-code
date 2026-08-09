//! Wire-shape renderers: engine events -> progress lines, session context ->
//! transcript text. Ported from the kimi-cli binary so the future TUI can
//! share them.

/// Cap for a tool event's rendered argument / result preview.
const TOOL_PREVIEW_CAP: usize = 80;

/// Bullet + indent prefixes for the prompt transcript block (TS
/// `PromptBlockWriter` parity: `• ` bullet, `  ` continuation indent).
const PROMPT_BLOCK_BULLET: &str = "• ";
const PROMPT_BLOCK_INDENT: &str = "  ";

/// Render assistant text as a bullet block: a `• ` marker, `  ` indentation
/// on every line, and optional terminal-width wrapping (TS
/// `PromptBlockWriter` parity). `columns` is the terminal width; `None`
/// disables wrapping.
pub fn render_prompt_block(text: &str, columns: Option<u16>) -> String {
    let wrap_width = columns
        .map(|c| c as usize)
        .filter(|c| *c > PROMPT_BLOCK_INDENT.len() + 1);
    let mut out = String::new();
    let mut started = false;
    let mut at_line_start = false;
    let mut line_width = 0usize;
    for ch in text.chars() {
        if !started {
            out.push_str(PROMPT_BLOCK_BULLET);
            started = true;
            at_line_start = false;
            line_width = PROMPT_BLOCK_BULLET.chars().count();
        }
        if at_line_start && ch != '\n' {
            out.push_str(PROMPT_BLOCK_INDENT);
            at_line_start = false;
            line_width = PROMPT_BLOCK_INDENT.chars().count();
        }
        let char_width = if ch == '\t' { 4 } else { 1 };
        if let Some(ww) = wrap_width {
            if !at_line_start && ch != '\n' && line_width + char_width > ww {
                out.push('\n');
                out.push_str(PROMPT_BLOCK_INDENT);
                line_width = PROMPT_BLOCK_INDENT.chars().count();
            }
        }
        out.push(ch);
        if ch == '\n' {
            at_line_start = true;
            line_width = 0;
        } else {
            line_width += char_width;
        }
    }
    if !started {
        return out;
    }
    out.push_str(if at_line_start { "\n" } else { "\n\n" });
    out
}

/// Compact a tool event payload (arguments or result content) into a single
/// short line. Strings pass through; objects/arrays serialize to JSON; the
/// result is truncated to `TOOL_PREVIEW_CAP` chars with an ellipsis.
fn compact_event_value(value: Option<&serde_json::Value>) -> String {
    let Some(value) = value else { return String::new() };
    let raw = match value {
        serde_json::Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    };
    let single = raw.replace('\n', " ");
    let trimmed = single.trim().to_string();
    if trimmed.chars().count() > TOOL_PREVIEW_CAP {
        let mut out: String = trimmed.chars().take(TOOL_PREVIEW_CAP).collect();
        out.push('…');
        out
    } else {
        trimmed
    }
}

/// Render an engine event as a compact human-readable progress line. Returns
/// `None` for unknown event types so the caller can fall back to raw output.
pub fn render_event(event: &serde_json::Value) -> Option<String> {
    // Most events carry `type`; the cron scheduler emits `kind` (CronFireEvent).
    let r#type = event
        .get("type")
        .or_else(|| event.get("kind"))
        .and_then(|v| v.as_str())?;
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
        "llm.step.begin" => {
            let model = field("model");
            if model.is_empty() {
                Some("llm step started".to_string())
            } else {
                Some(format!("llm: {model} started"))
            }
        }
        "llm.step.end" => {
            let total = event
                .get("usage")
                .and_then(|u| u.get("total_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let tool_calls = event
                .get("tool_calls")
                .and_then(|v| v.as_array())
                .map_or(0, |a| a.len());
            let reason = event.get("finish_reason").and_then(|v| v.as_str()).unwrap_or("");
            if reason.is_empty() {
                Some(format!("llm: {total} tokens, {tool_calls} tool calls"))
            } else {
                Some(format!("llm: {total} tokens, {tool_calls} tool calls ({reason})"))
            }
        }
        "session.tool.started" => {
            let name = field("tool_name");
            let args = compact_event_value(event.get("arguments"));
            if args.is_empty() {
                Some(format!("tool {name} started"))
            } else {
                Some(format!("tool {name}({args})"))
            }
        }
        "session.tool.settled" => {
            let ok = !event.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
            let label = if ok { "ok" } else { "error" };
            let content = compact_event_value(event.get("content"));
            if content.is_empty() {
                Some(format!("tool {} -> {label}", field("tool_name")))
            } else {
                Some(format!("tool {} -> {label}: {content}", field("tool_name")))
            }
        }
        "session.usage.updated" => {
            let total = event.get("total_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            Some(format!("usage: {total} tokens"))
        }
        "session.task.started" => {
            let description = field("description");
            let kind = field("kind");
            if description.is_empty() {
                Some(format!("task {} ({kind}) started", field("task_id")))
            } else {
                Some(format!("task {} ({kind}) started: {description}", field("task_id")))
            }
        }
        "session.task.terminated" => {
            let status = field("status");
            let description = field("description");
            if description.is_empty() {
                Some(format!("task {} {status}", field("task_id")))
            } else {
                Some(format!("task {} {status}: {description}", field("task_id")))
            }
        }
        "tool.native" => {
            // A native tool's final result (the engine executed it in
            // process): render like a settled tool call.
            let ok = !event.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
            let label = if ok { "ok" } else { "error" };
            let content = compact_event_value(event.get("content"));
            if content.is_empty() {
                Some(format!("tool {} -> {label}", field("tool_name")))
            } else {
                Some(format!("tool {} -> {label}: {content}", field("tool_name")))
            }
        }
        "session.shell.output" => {
            let text = field("content");
            let text = if text.len() > 80 { format!("{}…", &text[..80]) } else { text.to_string() };
            Some(format!("shell: {text}"))
        }
        "session.compaction.started" => Some("context compaction started".to_string()),
        "session.approval.requested" => {
            let name = field("tool_name");
            let args = compact_event_value(event.get("arguments"));
            if args.is_empty() {
                Some(format!("approval requested: {name}"))
            } else {
                Some(format!("approval requested: {name}({args})"))
            }
        }
        "session.goal.updated" => {
            // `snapshot` carries the full goal or null; `status` is a quick
            // diagnostic string. Render status + objective when available.
            let status = field("status");
            let snapshot = event.get("snapshot");
            let objective = snapshot
                .and_then(|s| s.get("objective"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if snapshot.is_none() || snapshot.is_some_and(|s| s.is_null()) {
                Some(if status.is_empty() { "goal cleared".to_string() } else { format!("goal: {status}") })
            } else if objective.is_empty() {
                Some(format!("goal: {status}"))
            } else {
                Some(format!("goal: {status} — {objective}"))
            }
        }
        "cron.fired" => {
            let job = field("job_id");
            let schedule = field("cron");
            let prompt = compact_event_value(event.get("prompt"));
            if prompt.is_empty() {
                Some(format!("cron {job} fired ({schedule})"))
            } else {
                Some(format!("cron {job} fired ({schedule}): {prompt}"))
            }
        }
        "session.hook.result" => Some(format!("hook ran: {}", field("name"))),
        _ => None,
    }
}

/// Extract the visible text delta from an `llm.delta` stream event (the
/// engine's native-LLM path forwards provider token deltas this way). Returns
/// `None` for thinking deltas and non-stream events, so hosts can render
/// only what belongs in the assistant transcript.
pub fn stream_delta(event: &serde_json::Value) -> Option<&str> {
    if event.get("type").and_then(|t| t.as_str()) != Some("llm.delta") {
        return None;
    }
    let part = event.get("part")?;
    if part.get("type").and_then(|t| t.as_str()) != Some("text") {
        return None;
    }
    part.get("text").and_then(|t| t.as_str())
}

/// Extract a thinking delta from an `llm.delta` stream event (the model's
/// chain-of-thought — rendered separately, never part of the transcript).
pub fn stream_thinking(event: &serde_json::Value) -> Option<&str> {
    if event.get("type").and_then(|t| t.as_str()) != Some("llm.delta") {
        return None;
    }
    let part = event.get("part")?;
    if part.get("type").and_then(|t| t.as_str()) != Some("think") {
        return None;
    }
    part.get("think").and_then(|t| t.as_str())
}

/// A tool-call argument preview streamed via `llm.delta` (`part.type ==
/// "tool_call"`): `(id, name, args)` with `args` the accumulated partial
/// JSON so far — hosts replace the running preview, never append.
pub fn stream_tool_call(event: &serde_json::Value) -> Option<(&str, &str, &str)> {
    if event.get("type").and_then(|t| t.as_str()) != Some("llm.delta") {
        return None;
    }
    let part = event.get("part")?;
    if part.get("type").and_then(|t| t.as_str()) != Some("tool_call") {
        return None;
    }
    Some((
        part.get("id")?.as_str()?,
        part.get("name")?.as_str()?,
        part.get("args")?.as_str()?,
    ))
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
    use super::{
        last_assistant_text, render_event, render_prompt_block, stream_delta, stream_thinking,
        stream_tool_call,
    };

    #[test]
    fn prompt_block_bullets_and_indents() {
        assert_eq!(render_prompt_block("hello", None), "• hello\n\n");
        assert_eq!(render_prompt_block("line1\nline2", None), "• line1\n  line2\n\n");
        // Empty input renders nothing.
        assert_eq!(render_prompt_block("", None), "");
    }

    #[test]
    fn prompt_block_wraps_at_terminal_width() {
        // Width 10: the bullet (2 chars) + 8 chars fit; the 9th wraps.
        let rendered = render_prompt_block("123456789012", Some(10));
        assert!(
            rendered.contains("\n  9012"),
            "wraps with indent: {rendered:?}"
        );
        assert!(rendered.starts_with("• 12345678"), "first line: {rendered:?}");
        assert!(rendered.ends_with("9012\n\n"), "wrapped tail: {rendered:?}");
    }

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
                serde_json::json!({ "type": "session.tool.started", "tool_name": "Read", "arguments": { "path": "/tmp/a.txt" } }),
                r#"tool Read({"path":"/tmp/a.txt"})"#,
            ),
            (
                serde_json::json!({ "type": "session.tool.started", "tool_name": "Grep" }),
                "tool Grep started",
            ),
            (
                serde_json::json!({ "type": "session.tool.settled", "tool_name": "Read", "is_error": true, "content": "no such file" }),
                "tool Read -> error: no such file",
            ),
            (
                serde_json::json!({ "type": "session.tool.settled", "tool_name": "Read", "is_error": false, "content": "file contents" }),
                "tool Read -> ok: file contents",
            ),
            (
                serde_json::json!({ "type": "tool.native", "tool_name": "Bash", "is_error": true, "content": "boom" }),
                "tool Bash -> error: boom",
            ),
            (
                serde_json::json!({ "type": "session.task.started", "task_id": "t1", "kind": "agent", "description": "review the diff" }),
                "task t1 (agent) started: review the diff",
            ),
            (
                serde_json::json!({ "type": "session.task.terminated", "task_id": "t1", "kind": "agent", "status": "completed" }),
                "task t1 completed",
            ),
            (
                serde_json::json!({
                    "type": "session.approval.requested",
                    "tool_name": "Write",
                    "arguments": { "path": "/tmp/x" },
                }),
                r#"approval requested: Write({"path":"/tmp/x"})"#,
            ),
            (
                serde_json::json!({
                    "type": "session.goal.updated",
                    "status": "Active",
                    "snapshot": { "objective": "fix the bug", "status": "Active" },
                }),
                "goal: Active — fix the bug",
            ),
            (
                serde_json::json!({ "type": "session.goal.updated", "status": "none", "snapshot": null }),
                "goal: none",
            ),
            (
                serde_json::json!({
                    "kind": "cron.fired",
                    "job_id": "j1",
                    "cron": "0 9 * * *",
                    "prompt": "morning reminder",
                }),
                "cron j1 fired (0 9 * * *): morning reminder",
            ),
            (
                serde_json::json!({ "kind": "cron.fired", "job_id": "j2", "cron": "* * * * *" }),
                "cron j2 fired (* * * * *)",
            ),
            (
                serde_json::json!({ "type": "session.usage.updated", "total_tokens": 42 }),
                "usage: 42 tokens",
            ),
            (
                serde_json::json!({ "type": "session.compaction.started" }),
                "context compaction started",
            ),
            (
                serde_json::json!({ "type": "llm.step.begin", "model": "kimi-k2" }),
                "llm: kimi-k2 started",
            ),
            (
                serde_json::json!({
                    "type": "llm.step.end",
                    "content": [],
                    "tool_calls": [1, 2],
                    "finish_reason": "tool_use",
                    "usage": { "input_tokens": 10, "output_tokens": 20, "total_tokens": 30 },
                }),
                "llm: 30 tokens, 2 tool calls (tool_use)",
            ),
            (
                serde_json::json!({ "type": "llm.step.begin" }),
                "llm step started",
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
    fn stream_delta_extracts_text_only() {
        // Text deltas surface as the visible stream.
        let delta = serde_json::json!({ "type": "llm.delta", "part": { "type": "text", "text": "hello " } });
        assert_eq!(stream_delta(&delta), Some("hello "));
        // Thinking deltas never enter the assistant transcript.
        let think = serde_json::json!({ "type": "llm.delta", "part": { "type": "think", "think": "hmm" } });
        assert_eq!(stream_delta(&think), None);
        // Non-stream events and malformed payloads are ignored.
        assert_eq!(stream_delta(&serde_json::json!({ "type": "session.turn.started" })), None);
        assert_eq!(stream_delta(&serde_json::json!({ "type": "llm.delta" })), None);
    }

    #[test]
    fn stream_tool_call_extracts_tool_call_part_only() {
        let tc = serde_json::json!({
            "type": "llm.delta",
            "part": { "type": "tool_call", "id": "call_1", "name": "Read", "args": "{\"path\":" }
        });
        assert_eq!(
            stream_tool_call(&tc),
            Some(("call_1", "Read", "{\"path\":"))
        );
        // Text / think / non-delta events are not tool-call previews.
        assert_eq!(
            stream_tool_call(&serde_json::json!({ "type": "llm.delta", "part": { "type": "text", "text": "hi" } })),
            None
        );
        assert_eq!(
            stream_tool_call(&serde_json::json!({ "type": "llm.delta", "part": { "type": "think", "think": "hmm" } })),
            None
        );
        assert_eq!(stream_tool_call(&serde_json::json!({ "type": "session.turn.started" })), None);
        // A tool_call part missing a field is malformed → None.
        assert_eq!(
            stream_tool_call(&serde_json::json!({ "type": "llm.delta", "part": { "type": "tool_call", "id": "x", "name": "Read" } })),
            None
        );
    }

    #[test]
    fn stream_thinking_extracts_think_only() {
        let think = serde_json::json!({ "type": "llm.delta", "part": { "type": "think", "think": "hmm " } });
        assert_eq!(stream_thinking(&think), Some("hmm "));
        // Text deltas and non-stream events yield no thinking.
        let text = serde_json::json!({ "type": "llm.delta", "part": { "type": "text", "text": "hi" } });
        assert_eq!(stream_thinking(&text), None);
        assert_eq!(stream_thinking(&serde_json::json!({ "type": "turn.started" })), None);
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
