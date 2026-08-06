//! Streaming — live assistant/thinking text accumulation into the transcript
//! (G-4 chatwidget component tree, step 3). Extracted from `app.rs` so the
//! streaming semantics are unit-testable in isolation.

use crate::app::{TranscriptKind, TranscriptLine};

/// Append a streaming delta to the trailing streaming line (or start one).
pub fn append_stream(transcript: &mut Vec<TranscriptLine>, delta: &str) {
    if let Some(last) = transcript.last_mut() {
        if last.kind == TranscriptKind::Streaming {
            last.text.push_str(delta);
            return;
        }
    }
    transcript.push(TranscriptLine::streaming(delta.to_string()));
}

/// Append a thinking delta to the trailing thinking line (same accumulate
/// semantics as `append_stream`).
pub fn append_thinking(transcript: &mut Vec<TranscriptLine>, delta: &str) {
    if let Some(last) = transcript.last_mut() {
        if last.kind == TranscriptKind::Thinking {
            last.text.push_str(delta);
            return;
        }
    }
    transcript.push(TranscriptLine::thinking(delta.to_string()));
}

/// Drop trailing transient thinking lines (reasoning never enters the
/// transcript once the turn closes).
pub fn drop_trailing_thinking(transcript: &mut Vec<TranscriptLine>) {
    while transcript.last().is_some_and(|l| l.kind == TranscriptKind::Thinking) {
        transcript.pop();
    }
}

/// Close a streaming turn: replace the trailing streaming line with the final
/// assistant text (or push it when nothing streamed). Returns whether a line
/// was replaced.
pub fn finish_stream(transcript: &mut Vec<TranscriptLine>, final_text: String) -> bool {
    if let Some(last) = transcript.last_mut() {
        if last.kind == TranscriptKind::Streaming {
            last.kind = TranscriptKind::Assistant;
            last.text = final_text;
            return true;
        }
    }
    transcript.push(TranscriptLine::assistant(final_text));
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_accumulates_and_drops() {
        let mut t = Vec::new();
        append_thinking(&mut t, "hmm");
        append_thinking(&mut t, " ok");
        assert_eq!(t.last().map(|l| l.text.as_str()), Some("hmm ok"));
        append_stream(&mut t, "visible");
        drop_trailing_thinking(&mut t);
        // Thinking is transient — dropping only affects trailing thinking.
        assert_eq!(t.last().map(|l| l.kind), Some(TranscriptKind::Streaming));
        assert_eq!(t.iter().filter(|l| l.kind == TranscriptKind::Thinking).count(), 1);
    }

    #[test]
    fn stream_replaced_by_final() {
        let mut t = Vec::new();
        append_stream(&mut t, "hello");
        let replaced = finish_stream(&mut t, "hello world".into());
        assert!(replaced);
        assert_eq!(t.last().map(|l| l.kind), Some(TranscriptKind::Assistant));
        assert_eq!(t.last().map(|l| l.text.as_str()), Some("hello world"));
    }

    #[test]
    fn finish_without_stream_pushes() {
        let mut t = Vec::new();
        let replaced = finish_stream(&mut t, "direct".into());
        assert!(!replaced);
        assert_eq!(t.last().map(|l| l.kind), Some(TranscriptKind::Assistant));
    }
}
