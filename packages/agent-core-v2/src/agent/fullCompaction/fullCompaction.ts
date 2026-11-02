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

export interface FullCompactionRequest {
  readonly id: string;
  readonly instruction?: string;
}

export interface QueuedFullCompaction {
  readonly id: string;
  readonly instruction?: string;
  readonly createdAt: string;
}

export interface FullCompactionTask {
  readonly abortController: AbortController;
  readonly promise: Promise<CompactionResult>;
  readonly trigger: CompactionSource;
  readonly tokenCount: number;
  readonly requestId?: string;
}

export interface IAgentFullCompactionService {
  readonly _serviceBrand: undefined;

  readonly compacting: FullCompactionTask | null;
  readonly queued: QueuedFullCompaction | undefined;
  readonly onDidChangeQueued: Event<void>;
  begin(input: FullCompactionInput): boolean;
  request(input: FullCompactionRequest): 'compact' | 'queue';
  cancelQueued(id: string): boolean;
  cancel(): void;

  readonly hooks: Hooks<{
    onWillCompact: FullCompactionTask;
  }>;

  readonly onDidFinishCompaction: Event<FullCompactionTask>;
}

export const IAgentFullCompactionService = createDecorator<IAgentFullCompactionService>('agentFullCompactionService');
