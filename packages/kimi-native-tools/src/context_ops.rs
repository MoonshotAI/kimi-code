/// Context Ops — pure context operations for v2 migration.
///
/// Pure functions for undo, precheck, and utility operations on
/// context message arrays. The TS side retains wire integration.
///
/// Corresponds to `packages/agent-core-v2/src/agent/contextMemory/contextOps.ts`.
use napi_derive::napi;

// ── Result types ────────────────────────────────────────────────────────

/// Result of computeUndoCut.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct NativeUndoCut {
    pub cut_index: i32,
    pub removed_count: i32,
    pub stopped_at_compaction: bool,
}

/// Result of precheckUndo.
#[napi(object)]
pub struct NativeUndoPrecheck {
    pub ok: bool,
    pub reason: String,
    pub requested: i32,
    pub undoable: i32,
}

// ── Pure functions ──────────────────────────────────────────────────────

/// Check if a value is a ContextMessage (has role: string, content: array).
#[napi]
pub fn native_is_context_message(value_json: String) -> bool {
    let value: serde_json::Value =
        serde_json::from_str(&value_json).unwrap_or(serde_json::Value::Null);
    if !value.is_object() {
        return false;
    }
    let role = value.get("role").and_then(|r| r.as_str());
    let content = value.get("content").and_then(|c| c.as_array());
    role.is_some() && content.is_some()
}

/// Extract text content from a message (all text parts concatenated).
#[napi]
pub fn native_text_of(message_json: String) -> String {
    let message: serde_json::Value =
        serde_json::from_str(&message_json).unwrap_or(serde_json::Value::Null);
    let mut text = String::new();
    if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
        for part in content {
            if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                    text.push_str(t);
                }
            }
        }
    }
    text
}

/// Check if a message is a real user prompt (can be undone).
#[napi]
pub fn native_is_real_user_prompt(message_json: String) -> bool {
    let msg: serde_json::Value =
        serde_json::from_str(&message_json).unwrap_or(serde_json::Value::Null);
    if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
        return false;
    }
    let origin = msg.get("origin");
    match origin.and_then(|o| o.get("kind")).and_then(|k| k.as_str()) {
        None | Some("user") => true,
        Some("skill_activation") | Some("plugin_command") => origin
            .and_then(|o| o.get("trigger"))
            .and_then(|t| t.as_str())
            == Some("user-slash"),
        _ => false,
    }
}

/// Compute an undo cut: find where to cut the message array.
/// messages_json: JSON array of ContextMessage objects.
/// count: number of user turns to undo.
/// Returns NativeUndoCut.
#[napi]
pub fn native_compute_undo_cut(messages_json: String, count: i32) -> NativeUndoCut {
    let messages: Vec<serde_json::Value> =
        serde_json::from_str(&messages_json).unwrap_or_default();

    let mut remaining = count;
    let mut cut_index: i32 = -1;
    let mut removed_count: i32 = 0;
    let mut stopped_at_compaction = false;

    let mut i = messages.len() as i32 - 1;
    while i >= 0 && remaining > 0 {
        let msg = &messages[i as usize];
        let origin_kind = msg
            .get("origin")
            .and_then(|o| o.get("kind"))
            .and_then(|k| k.as_str());

        // Skip injection messages
        if origin_kind == Some("injection") {
            i -= 1;
            continue;
        }

        // Stop at compaction boundary
        if origin_kind == Some("compaction_summary") {
            stopped_at_compaction = true;
            break;
        }

        // Check if this is a real user prompt
        if is_real_user_prompt_value(msg) {
            remaining -= 1;
            removed_count += 1;
            cut_index = i;
        }

        i -= 1;
    }

    NativeUndoCut {
        cut_index,
        removed_count,
        stopped_at_compaction,
    }
}

fn is_real_user_prompt_value(msg: &serde_json::Value) -> bool {
    if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
        return false;
    }
    let origin = msg.get("origin");
    match origin.and_then(|o| o.get("kind")).and_then(|k| k.as_str()) {
        None | Some("user") => true,
        Some("skill_activation") | Some("plugin_command") => origin
            .and_then(|o| o.get("trigger"))
            .and_then(|t| t.as_str())
            == Some("user-slash"),
        _ => false,
    }
}

/// Check if a cut is fully undoable.
#[napi]
pub fn native_is_fully_undoable(cut_index: i32, removed_count: i32, count: i32) -> bool {
    cut_index >= 0 && removed_count >= count
}

/// Pre-check if undo is available and return a structured result.
#[napi]
pub fn native_precheck_undo(messages_json: String, count: i32) -> NativeUndoPrecheck {
    let cut = native_compute_undo_cut(messages_json, count);
    if native_is_fully_undoable(cut.cut_index, cut.removed_count, count) {
        return NativeUndoPrecheck {
            ok: true,
            reason: String::new(),
            requested: count,
            undoable: cut.removed_count,
        };
    }
    let reason = if cut.stopped_at_compaction {
        "compaction_boundary"
    } else if cut.removed_count == 0 {
        "empty"
    } else {
        "insufficient"
    };
    NativeUndoPrecheck {
        ok: false,
        reason: reason.to_string(),
        requested: count,
        undoable: cut.removed_count,
    }
}

/// Format an undo unavailable message.
#[napi]
pub fn native_format_undo_unavailable_message(reason: String, undoable: i32, requested: i32) -> String {
    match reason.as_str() {
        "empty" => "Nothing to undo: no user message to undo".to_string(),
        "compaction_boundary" => {
            "Nothing to undo: would cross a compaction boundary".to_string()
        }
        "insufficient" => {
            format!(
                "Nothing to undo: only {} of {} requested turn(s) available",
                undoable, requested
            )
        }
        _ => format!("Nothing to undo: reason unknown"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_msg(content: &str, kind: Option<&str>) -> serde_json::Value {
        let mut msg = serde_json::json!({
            "role": "user",
            "content": [{"type": "text", "text": content}],
            "toolCalls": [],
        });
        if let Some(k) = kind {
            msg["origin"] = serde_json::json!({"kind": k});
        }
        msg
    }

    fn assistant_msg(content: &str) -> serde_json::Value {
        serde_json::json!({
            "role": "assistant",
            "content": [{"type": "text", "text": content}],
            "toolCalls": [],
        })
    }

    fn injection_msg() -> serde_json::Value {
        serde_json::json!({
            "role": "assistant",
            "content": [{"type": "text", "text": "injected"}],
            "toolCalls": [],
            "origin": {"kind": "injection", "variant": "system"},
        })
    }

    fn compaction_msg() -> serde_json::Value {
        serde_json::json!({
            "role": "user",
            "content": [{"type": "text", "text": "compacted history"}],
            "toolCalls": [],
            "origin": {"kind": "compaction_summary"},
        })
    }

    #[test]
    fn test_is_context_message() {
        assert!(native_is_context_message(
            r#"{"role":"user","content":[]}"#.to_string()
        ));
        assert!(!native_is_context_message(
            r#"{"role":"user"}"#.to_string()
        ));
        assert!(!native_is_context_message(r#"null"#.to_string()));
    }

    #[test]
    fn test_text_of() {
        let msg = serde_json::json!({
            "role": "user",
            "content": [
                {"type": "text", "text": "Hello "},
                {"type": "text", "text": "World"},
            ],
        });
        assert_eq!(native_text_of(msg.to_string()), "Hello World");
    }

    #[test]
    fn test_is_real_user_prompt() {
        assert!(native_is_real_user_prompt(user_msg("hi", None).to_string()));
        assert!(native_is_real_user_prompt(user_msg("hi", Some("user")).to_string()));
        let skill_msg = serde_json::json!({
            "role": "user",
            "content": [{"type": "text", "text": "/commit"}],
            "toolCalls": [],
            "origin": {"kind": "skill_activation", "trigger": "user-slash"},
        });
        assert!(native_is_real_user_prompt(skill_msg.to_string()));
        assert!(!native_is_real_user_prompt(assistant_msg("hello").to_string()));
    }

    #[test]
    fn test_compute_undo_cut_simple() {
        let msgs = serde_json::json!([
            user_msg("first", None),
            assistant_msg("response"),
            user_msg("second", None),
        ]);
        let cut = native_compute_undo_cut(msgs.to_string(), 1);
        assert!(cut.cut_index >= 0);
        assert_eq!(cut.removed_count, 1);
        assert!(!cut.stopped_at_compaction);
    }

    #[test]
    fn test_compute_undo_cut_skips_injections() {
        let msgs = serde_json::json!([
            user_msg("first", None),
            assistant_msg("response"),
            injection_msg(),
            user_msg("second", None),
        ]);
        let cut = native_compute_undo_cut(msgs.to_string(), 1);
        assert!(cut.cut_index >= 0);
        assert_eq!(cut.removed_count, 1);
    }

    #[test]
    fn test_compute_undo_cut_stops_at_compaction() {
        // Compaction is at the end, so iterating backwards hits it first
        let msgs = serde_json::json!([
            user_msg("first", None),
            assistant_msg("response"),
            compaction_msg(),
        ]);
        let cut = native_compute_undo_cut(msgs.to_string(), 1);
        assert!(cut.stopped_at_compaction);
        assert_eq!(cut.removed_count, 0);
    }

    #[test]
    fn test_precheck_undo() {
        let msgs = serde_json::json!([
            user_msg("first", None),
            assistant_msg("response"),
        ]);
        let check = native_precheck_undo(msgs.to_string(), 1);
        assert!(check.ok);

        let check = native_precheck_undo(msgs.to_string(), 5);
        assert!(!check.ok);
        assert_eq!(check.reason, "insufficient");
    }

    #[test]
    fn test_format_undo_unavailable() {
        let msg = native_format_undo_unavailable_message("empty".to_string(), 0, 1);
        assert!(msg.contains("Nothing to undo"));
        let msg = native_format_undo_unavailable_message("insufficient".to_string(), 2, 5);
        assert!(msg.contains("2"));
        assert!(msg.contains("5"));
    }
}