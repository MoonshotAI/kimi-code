import type { CompactionResult as ProtocolCompactionResult } from '@moonshot-ai/protocol';

export interface CompactionResult extends ProtocolCompactionResult {
  summary: string;
  contextSummary?: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  keptUserMessageCount?: number;
  keptHeadUserMessageCount?: number;
  droppedCount?: number;
}

export type CompactionSource = 'manual' | 'auto';

export interface CompactionBeginData {
  instruction?: string;
  source: CompactionSource;
}
