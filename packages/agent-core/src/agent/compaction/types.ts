export interface CompactionResult {
  /** Human-facing summary text produced by the compaction model. */
  summary: string;
  /**
   * Exact summary message stored in the live model context. It includes the
   * compaction prefix that tells the next model this is handoff context rather
   * than a real user prompt. Optional for backward compatibility with older
   * wire records, where `summary` was also the model-context text.
   */
  contextSummary?: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  /**
   * Number of real user messages kept verbatim ahead of the summary in the
   * post-compaction live context. Written by `ContextMemory.applyCompaction`
   * (the single derivation point for the post-compaction shape) so the
   * wire-transcript reducer can reproduce the live folded length without
   * re-deriving it from the full transcript. Optional for backward
   * compatibility with older wire records.
   */
  keptUserMessageCount?: number;
  /**
   * Number of oldest messages trimmed from the summarizer input when the
   * compaction request itself overflowed the model window. These messages are
   * not covered by the produced summary — a real-user message among them may
   * still be retained verbatim in the live context via `keptUserMessageCount`,
   * but assistant/tool messages are lost. Surfacing the count lets records and
   * telemetry report the summary's blind spot honestly. Optional for backward
   * compatibility with older wire records.
   */
  droppedCount?: number;
}

/**
 * Inputs `ContextMemory.applyCompaction` needs to derive a `CompactionResult`.
 * `tokensAfter` / `keptUserMessageCount` / `droppedCount` are optional: the live
 * path fills in what it knows, while restore passes the persisted record so its
 * historical values are preserved verbatim.
 */
export type CompactionInput = Pick<CompactionResult, 'summary' | 'compactedCount' | 'tokensBefore'> &
  Partial<Pick<CompactionResult, 'contextSummary' | 'tokensAfter' | 'keptUserMessageCount' | 'droppedCount'>>;

export type CompactionSource = 'manual' | 'auto';

export interface CompactionBeginData {
  instruction?: string;
  source: CompactionSource;
}
