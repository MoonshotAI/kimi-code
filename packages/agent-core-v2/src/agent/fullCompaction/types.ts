export interface CompactionResult {
  summary: string;
  contextSummary?: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  /**
   * Number of real user messages kept verbatim ahead of the summary in the
   * post-compaction live context. Recorded so the wire-transcript reducer can
   * reproduce the live folded length without re-deriving it from the full
   * transcript (which still holds the untruncated originals of messages the
   * live context may have truncated, so the two would otherwise diverge).
   * Optional for backward compatibility with older wire records.
   */
  keptUserMessageCount?: number;
  /**
   * Of `keptUserMessageCount`, how many messages form the head segment (the
   * oldest user input kept when the pool overflowed the budget). Present iff
   * the selection split into head + tail, in which case the live context also
   * holds one elision-marker message between the segments. Optional for
   * backward compatibility with older wire records.
   */
  keptHeadUserMessageCount?: number;
  /**
   * Oldest messages trimmed from the summarizer input when the compaction
   * request overflowed the model window; not covered by the produced summary.
   * Mirrors agent-core's `CompactionResult.droppedCount`; optional for backward
   * compatibility.
   */
  droppedCount?: number;
}

export type CompactionSource = 'manual' | 'auto';

export interface CompactionBeginData {
  instruction?: string;
  source: CompactionSource;
}
