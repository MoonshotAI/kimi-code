export interface CompactionResult {
  summary: string;
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
}

/**
 * Inputs `ContextMemory.applyCompaction` needs to derive a `CompactionResult`.
 * `tokensAfter` / `keptUserMessageCount` are optional: the live path omits them
 * (they are derived from the current history), while restore passes the
 * persisted record so its historical values are preserved verbatim.
 */
export type CompactionInput = Pick<CompactionResult, 'summary' | 'compactedCount' | 'tokensBefore'> &
  Partial<Pick<CompactionResult, 'tokensAfter' | 'keptUserMessageCount'>>;

export type CompactionSource = 'manual' | 'auto';

export interface CompactionBeginData {
  instruction?: string;
  source: CompactionSource;
}
