//! Streaming — live assistant/thinking text accumulation into the transcript
//! (G-4 chatwidget component tree, step 3). Extracted from `app.rs` so the
//! streaming semantics are unit-testable in isolation.

use crate::app::{TranscriptEntry, TranscriptKind, TranscriptLine};

/// The trailing plain line, if the transcript ends on one (tool cards don't
/// accumulate streamed text).
fn last_line_mut(transcript: &mut [TranscriptEntry]) -> Option<&mut TranscriptLine> {
    transcript.last_mut().and_then(|e| match e {
        TranscriptEntry::Line(line) => Some(line),
        _ => None,
    })
}

/// Append a streaming delta to the trailing streaming line (or start one).
pub fn append_stream(transcript: &mut Vec<TranscriptEntry>, delta: &str) {
    if let Some(last) = last_line_mut(transcript) {
        if last.kind == TranscriptKind::Streaming {
            last.text.push_str(delta);
            return;
        }
    }
    transcript.push(TranscriptEntry::Line(TranscriptLine::streaming(
        delta.to_string(),
    )));
}

/// Append a thinking delta to the trailing thinking line (same accumulate
/// semantics as `append_stream`).
pub fn append_thinking(transcript: &mut Vec<TranscriptEntry>, delta: &str) {
    if let Some(last) = last_line_mut(transcript) {
        if last.kind == TranscriptKind::Thinking {
            last.text.push_str(delta);
            return;
        }
    }
    transcript.push(TranscriptEntry::Line(TranscriptLine::thinking(
        delta.to_string(),
    )));
}

/// Drop trailing transient thinking lines (reasoning never enters the
/// transcript once the turn closes).
pub fn drop_trailing_thinking(transcript: &mut Vec<TranscriptEntry>) {
    while transcript.last().is_some_and(
        |e| matches!(e, TranscriptEntry::Line(l) if l.kind == TranscriptKind::Thinking),
    ) {
        transcript.pop();
    }
}

/// Update a running tool card's argument preview from a streamed
/// `llm.delta` tool_call part. Only cards whose call id matches and that
/// are still running (no settled result) are updated — a settled card keeps
/// the final arguments from `session.tool.started`.
pub fn update_tool_args(transcript: &mut [TranscriptEntry], call_id: &str, args: &str) {
    if let Some(entry) = transcript.iter_mut().find_map(|e| match e {
        TranscriptEntry::ToolCall(tc) if tc.tool_call_id == call_id && tc.result.is_none() => {
            Some(tc)
        }
        _ => None,
    }) {
        entry.args = args.to_string();
    }
}

/// Close a streaming turn: replace the trailing streaming line with the final
/// assistant text (or push it when nothing streamed). Returns whether a line
/// was replaced.
pub fn finish_stream(transcript: &mut Vec<TranscriptEntry>, final_text: String) -> bool {
    if let Some(last) = last_line_mut(transcript) {
        if last.kind == TranscriptKind::Streaming {
            last.kind = TranscriptKind::Assistant;
            last.text = final_text;
            return true;
        }
    }
    transcript.push(TranscriptEntry::Line(TranscriptLine::assistant(final_text)));
    false
}

/// Finalize a side-agent (btw) turn in place: the streamed line IS the final
/// answer (the side agent's context is not the session's, so there is no
/// transcript to read back) — promote it to an assistant line keeping its
/// accumulated text. Returns whether a streamed line was promoted.
pub fn finish_side_turn(transcript: &mut [TranscriptEntry]) -> bool {
    if let Some(last) = last_line_mut(transcript) {
        if last.kind == TranscriptKind::Streaming {
            last.kind = TranscriptKind::Assistant;
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::TranscriptEntry;

    fn last_line(t: &[TranscriptEntry]) -> Option<&crate::app::TranscriptLine> {
        t.last().and_then(|e| match e {
            TranscriptEntry::Line(l) => Some(l),
            _ => None,
        })
    }

    #[test]
    fn thinking_accumulates_and_drops() {
        let mut t = Vec::new();
        append_thinking(&mut t, "hmm");
        append_thinking(&mut t, " ok");
        assert_eq!(last_line(&t).map(|l| l.text.as_str()), Some("hmm ok"));
        append_stream(&mut t, "visible");
        drop_trailing_thinking(&mut t);
        // Thinking is transient — dropping only affects trailing thinking.
        assert_eq!(
            last_line(&t).map(|l| l.kind),
            Some(TranscriptKind::Streaming)
        );
        assert_eq!(
            t.iter()
                .filter(
                    |e| matches!(e, TranscriptEntry::Line(l) if l.kind == TranscriptKind::Thinking)
                )
                .count(),
            1
        );
    }

    #[test]
    fn stream_replaced_by_final() {
        let mut t = Vec::new();
        append_stream(&mut t, "hello");
        let replaced = finish_stream(&mut t, "hello world".into());
        assert!(replaced);
        assert_eq!(
            last_line(&t).map(|l| l.kind),
            Some(TranscriptKind::Assistant)
        );
        assert_eq!(last_line(&t).map(|l| l.text.as_str()), Some("hello world"));
    }

    #[test]
    fn finish_without_stream_pushes() {
        let mut t = Vec::new();
        let replaced = finish_stream(&mut t, "direct".into());
        assert!(!replaced);
        assert_eq!(
            last_line(&t).map(|l| l.kind),
            Some(TranscriptKind::Assistant)
        );
    }

    #[test]
    fn side_turn_finalizes_stream_in_place() {
        // A btw (side-agent) turn has no session transcript to read back —
        // the streamed line IS the answer and must keep its text.
        let mut t = Vec::new();
        append_stream(&mut t, "side answer");
        let promoted = finish_side_turn(&mut t);
        assert!(promoted);
        assert_eq!(
            last_line(&t).map(|l| l.kind),
            Some(TranscriptKind::Assistant)
        );
        assert_eq!(last_line(&t).map(|l| l.text.as_str()), Some("side answer"));

        // No streamed line → nothing to promote, transcript untouched.
        let mut t2 = vec![TranscriptEntry::Line(crate::app::TranscriptLine::status("ok"))];
        assert!(!finish_side_turn(&mut t2));
        assert_eq!(t2.len(), 1);
    }

    #[test]
    fn tool_args_preview_updates_running_card_only() {
        use crate::app::ToolCallEntry;
        let mut t = vec![TranscriptEntry::ToolCall(ToolCallEntry {
            tool_call_id: "call_1".into(),
            tool_name: "Read".into(),
            args: "".into(),
            result: None,
            is_error: false,
            is_question: false,
            duration: None,
            collapsed: false,
        })];
        // A streamed args delta replaces the running card's preview.
        update_tool_args(&mut t, "call_1", "{\"path\": \"a.txt\"}");
        if let TranscriptEntry::ToolCall(tc) = &t[0] {
            assert_eq!(tc.args, "{\"path\": \"a.txt\"}");
        } else {
            panic!("expected tool card");
        }
        // A settled card is left alone (final args come from tool.started).
        t[0] = TranscriptEntry::ToolCall(ToolCallEntry {
            tool_call_id: "call_1".into(),
            tool_name: "Read".into(),
            args: "{\"path\": \"a.txt\"}".into(),
            result: Some("ok".into()),
            is_error: false,
            is_question: false,
            duration: None,
            collapsed: false,
        });
        update_tool_args(&mut t, "call_1", "{\"path\": \"changed\"}");
        if let TranscriptEntry::ToolCall(tc) = &t[0] {
            assert_eq!(tc.args, "{\"path\": \"a.txt\"}");
        } else {
            panic!("expected tool card");
        }
        // Unknown ids are a no-op.
        update_tool_args(&mut t, "nope", "x");
    }
}
