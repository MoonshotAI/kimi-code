import type {
  CompactionBeginData,
  CompactionResult,
  CompactionSource,
} from '../../../agent/compaction';
import { createDecorator } from "#/_base/di";

export type FullCompactionCompleteData = Omit<CompactionResult, 'summary'>;

export interface CompactInput {
  readonly source: CompactionSource;
  readonly instruction?: string;
  readonly customInstruction?: string;
  readonly signal?: AbortSignal;
}

export interface IFullCompaction {
  readonly isCompacting: boolean;

  begin(input: CompactInput): boolean;
  cancel(): void;
  handleOverflowError(signal: AbortSignal, error: unknown, turnId?: number): Promise<void>;
}

declare module '../types' {
  interface WireRecordMap {
    'full_compaction.begin': CompactionBeginData;
    'full_compaction.cancel': {};
    'full_compaction.complete': FullCompactionCompleteData;
  }
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IFullCompaction = createDecorator<IFullCompaction>('agentFullCompactionService');
