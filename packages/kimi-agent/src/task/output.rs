/// `task` domain — the bounded output retention ring.
///
/// Ports the output handling in
/// `packages/agent-core-v2/src/agent/task/taskService.ts`
/// (`appendRetainedOutput` / `getOutputSnapshot` / `retainedOutputTail`).
///
/// A task's *total* output is unbounded and streamed to persistence; what the
/// service keeps in memory is a byte-bounded tail. The two counters are
/// deliberately distinct: `output_size_bytes` is everything the task ever
/// produced (it drives the 16 MiB kill switch and the `truncated` flag), while
/// `retained_bytes` is only what the ring still holds.
use crate::task::types::TaskOutputSnapshot;

/// How much output is retained in memory per task.
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

/// How much of the retained output rides along on the `task.terminated` record.
pub const TERMINAL_OUTPUT_TAIL_BYTES: usize = 4 * 1024;

/// Total output a process task may produce before it is killed.
pub const MAX_TASK_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

pub fn output_limit_reason() -> String {
    let mib = MAX_TASK_OUTPUT_BYTES / (1024 * 1024);
    format!(
        "Output limit exceeded: the command produced more than {mib} MiB and was terminated. \
         Redirect large output to a file (e.g. `command > out.txt`) and inspect it in slices instead."
    )
}

/// The longest suffix of `text` that fits in `max_bytes`, snapped to a char
/// boundary.
///
/// TS slices a `Buffer`, which can cut a multi-byte sequence in half and emit a
/// replacement character. Rust cannot index off a boundary at all, so the cut
/// moves forward to the next boundary — at most three bytes shorter, and never
/// producing mojibake.
fn suffix_within_bytes(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut start = text.len() - max_bytes;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

#[derive(Debug, Default)]
pub struct OutputRetention {
    chunks: Vec<String>,
    /// Everything the task has ever produced.
    output_size_bytes: usize,
    /// What the ring currently holds.
    retained_bytes: usize,
}

impl OutputRetention {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn output_size_bytes(&self) -> usize {
        self.output_size_bytes
    }

    pub fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }

    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }

    pub fn clear(&mut self) {
        self.chunks.clear();
        self.output_size_bytes = 0;
        self.retained_bytes = 0;
    }

    /// Record a chunk. Returns the chunk's byte length.
    pub fn append(&mut self, chunk: &str) -> usize {
        let chunk_bytes = chunk.len();
        self.output_size_bytes += chunk_bytes;

        // A single oversized chunk replaces the whole ring with its own tail —
        // evicting older chunks one at a time would be O(n) for no benefit.
        if chunk_bytes >= MAX_OUTPUT_BYTES {
            let retained = suffix_within_bytes(chunk, MAX_OUTPUT_BYTES).to_string();
            self.retained_bytes = retained.len();
            self.chunks.clear();
            self.chunks.push(retained);
            return chunk_bytes;
        }

        self.chunks.push(chunk.to_string());
        self.retained_bytes += chunk_bytes;
        while self.retained_bytes > MAX_OUTPUT_BYTES {
            let Some(removed) = (!self.chunks.is_empty()).then(|| self.chunks.remove(0)) else {
                break;
            };
            self.retained_bytes -= removed.len();
        }
        chunk_bytes
    }

    /// Everything still held in the ring.
    pub fn retained(&self) -> String {
        self.chunks.concat()
    }

    /// The bounded tail attached to a `task.terminated` record.
    pub fn terminal_tail(&self) -> Option<String> {
        if self.chunks.is_empty() {
            return None;
        }
        let retained = self.retained();
        Some(suffix_within_bytes(&retained, TERMINAL_OUTPUT_TAIL_BYTES).to_string())
    }

    /// Build the in-memory snapshot, used when no persisted log exists.
    ///
    /// `preview_bytes` is capped by all three of the caller's limit, what the
    /// ring actually holds, and the total the task produced; `truncated`
    /// compares against the *total*, so a task whose early output was evicted
    /// still reports truncation even when the whole ring fits the preview.
    pub fn snapshot(&self, max_preview_bytes: usize) -> TaskOutputSnapshot {
        let available = self.retained();
        let preview_bytes =
            max_preview_bytes.min(available.len()).min(self.output_size_bytes);
        let preview = suffix_within_bytes(&available, preview_bytes).to_string();
        TaskOutputSnapshot {
            output_path: None,
            output_size_bytes: self.output_size_bytes,
            preview_bytes,
            truncated: self.output_size_bytes > preview_bytes,
            full_output_available: false,
            preview,
        }
    }
}

/// Take the last `tail` characters, mirroring `String.prototype.slice(-tail)`.
///
/// TS slices the preview string by UTF-16 code units; counting Rust `char`s is
/// the closest total equivalent and agrees exactly for the BMP.
pub fn tail_chars(text: &str, tail: usize) -> &str {
    if tail == 0 {
        return "";
    }
    match text.char_indices().nth_back(tail.saturating_sub(1)) {
        Some((index, _)) => &text[index..],
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_accumulates_both_counters() {
        let mut ring = OutputRetention::new();
        ring.append("hello ");
        ring.append("world");
        assert_eq!(ring.output_size_bytes(), 11);
        assert_eq!(ring.retained_bytes(), 11);
        assert_eq!(ring.retained(), "hello world");
    }

    #[test]
    fn ring_evicts_oldest_chunks_past_the_cap() {
        let mut ring = OutputRetention::new();
        let chunk = "a".repeat(MAX_OUTPUT_BYTES / 2);
        ring.append(&chunk);
        ring.append(&chunk);
        ring.append("tail");
        // The third append pushed past the cap, evicting the first chunk.
        assert_eq!(ring.output_size_bytes(), MAX_OUTPUT_BYTES + 4);
        assert!(ring.retained_bytes() <= MAX_OUTPUT_BYTES);
        assert!(ring.retained().ends_with("tail"));
    }

    #[test]
    fn an_oversized_chunk_replaces_the_whole_ring() {
        let mut ring = OutputRetention::new();
        ring.append("earlier output");
        let huge = "b".repeat(MAX_OUTPUT_BYTES + 100);
        ring.append(&huge);
        assert_eq!(ring.retained_bytes(), MAX_OUTPUT_BYTES);
        assert!(!ring.retained().contains("earlier"));
        assert_eq!(ring.output_size_bytes(), 14 + MAX_OUTPUT_BYTES + 100);
    }

    #[test]
    fn eviction_never_splits_a_multibyte_char() {
        let mut ring = OutputRetention::new();
        // A single oversized chunk of 3-byte code points: the cut lands
        // mid-sequence and must snap forward rather than panic.
        let huge = "中".repeat(MAX_OUTPUT_BYTES);
        ring.append(&huge);
        let retained = ring.retained();
        assert!(retained.len() <= MAX_OUTPUT_BYTES);
        assert!(retained.chars().all(|c| c == '中'));
    }

    #[test]
    fn terminal_tail_is_bounded() {
        let mut ring = OutputRetention::new();
        ring.append(&"x".repeat(TERMINAL_OUTPUT_TAIL_BYTES * 2));
        let tail = ring.terminal_tail().expect("has output");
        assert_eq!(tail.len(), TERMINAL_OUTPUT_TAIL_BYTES);
    }

    #[test]
    fn terminal_tail_is_none_without_output() {
        assert_eq!(OutputRetention::new().terminal_tail(), None);
    }

    #[test]
    fn terminal_tail_returns_short_output_whole() {
        let mut ring = OutputRetention::new();
        ring.append("short");
        assert_eq!(ring.terminal_tail().as_deref(), Some("short"));
    }

    #[test]
    fn snapshot_of_short_output_is_not_truncated() {
        let mut ring = OutputRetention::new();
        ring.append("hello world\n");
        let snapshot = ring.snapshot(50);
        assert_eq!(snapshot.preview, "hello world\n");
        assert_eq!(snapshot.output_size_bytes, 12);
        assert_eq!(snapshot.preview_bytes, 12);
        assert!(!snapshot.truncated);
        assert!(!snapshot.full_output_available);
    }

    #[test]
    fn snapshot_keeps_the_newest_bytes_when_limited() {
        let mut ring = OutputRetention::new();
        ring.append("0123456789");
        let snapshot = ring.snapshot(4);
        assert_eq!(snapshot.preview, "6789");
        assert_eq!(snapshot.preview_bytes, 4);
        assert!(snapshot.truncated);
        assert_eq!(snapshot.output_size_bytes, 10);
    }

    #[test]
    fn snapshot_reports_truncation_after_eviction_even_when_the_ring_fits() {
        let mut ring = OutputRetention::new();
        ring.append(&"a".repeat(MAX_OUTPUT_BYTES));
        ring.append("tail");
        // The ring holds at most the cap, but the task produced more.
        let snapshot = ring.snapshot(usize::MAX);
        assert!(snapshot.truncated);
        assert_eq!(snapshot.output_size_bytes, MAX_OUTPUT_BYTES + 4);
        assert!(snapshot.preview_bytes < snapshot.output_size_bytes);
    }

    #[test]
    fn snapshot_of_an_empty_ring() {
        let snapshot = OutputRetention::new().snapshot(100);
        assert_eq!(snapshot.preview, "");
        assert_eq!(snapshot.preview_bytes, 0);
        assert!(!snapshot.truncated);
    }

    #[test]
    fn snapshot_with_a_zero_limit_reports_the_total() {
        let mut ring = OutputRetention::new();
        ring.append("some output");
        let snapshot = ring.snapshot(0);
        assert_eq!(snapshot.preview, "");
        assert_eq!(snapshot.preview_bytes, 0);
        assert!(snapshot.truncated);
        assert_eq!(snapshot.output_size_bytes, 11);
    }

    #[test]
    fn clear_resets_both_counters() {
        let mut ring = OutputRetention::new();
        ring.append("data");
        ring.clear();
        assert_eq!(ring.output_size_bytes(), 0);
        assert_eq!(ring.retained_bytes(), 0);
        assert!(ring.is_empty());
    }

    #[test]
    fn tail_chars_takes_the_last_n() {
        assert_eq!(tail_chars("0123456789", 4), "6789");
        assert_eq!(tail_chars("abc", 10), "abc");
        assert_eq!(tail_chars("abc", 0), "");
    }

    #[test]
    fn tail_chars_counts_code_points_not_bytes() {
        assert_eq!(tail_chars("中文测试", 2), "测试");
    }

    #[test]
    fn output_limit_reason_names_the_ceiling() {
        assert!(output_limit_reason().contains("16 MiB"));
    }
}
