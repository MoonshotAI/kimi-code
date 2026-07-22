import type {
  CompactionResult,
  CompactionSource,
} from './types';
import { createDecorator } from "#/_base/di/instantiation";
import type { Event } from '#/_base/event';
import type { Hooks } from '#/hooks';

export interface FullCompactionInput {
  readonly source: CompactionSource;
  readonly instruction?: string;
}

export interface FullCompactionTask {
  readonly abortController: AbortController;
  readonly promise: Promise<CompactionResult>;
  readonly trigger: CompactionSource;
  readonly tokenCount: number;
  readonly traceId?: string;
}

export interface IAgentFullCompactionService {
  readonly _serviceBrand: undefined;

  readonly compacting: FullCompactionTask | null;
  begin(input: FullCompactionInput): boolean;
  /**
   * Abort the in-flight compaction (if any) and wait for it to settle.
   * A no-op when idle. Used by the rewind pipeline's quiesce step so a
   * compaction can never apply a pre-rewind summary onto post-rewind context.
   */
  cancel(): Promise<void>;

  readonly hooks: Hooks<{
    onWillCompact: FullCompactionTask;
  }>;

  readonly onDidFinishCompaction: Event<FullCompactionTask>;
}

export const IAgentFullCompactionService = createDecorator<IAgentFullCompactionService>('agentFullCompactionService');
