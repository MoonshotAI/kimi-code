import type {
  CompactionResult,
  CompactionSource,
} from './types';
import { createDecorator } from "#/_base/di";
import type { Hooks } from '#/hooks';

export type FullCompactionCompleteData = Omit<CompactionResult, 'summary'>;

export interface CompactInput {
  readonly source: CompactionSource;
  readonly instruction?: string;
}

export interface FullCompactionWillCompactContext {
  readonly trigger: CompactionSource;
  readonly tokenCount: number;
  readonly signal: AbortSignal;
}

export interface FullCompactionDidCompactContext {
  readonly trigger: CompactionSource;
  readonly estimatedTokenCount: number;
}

export interface IAgentFullCompactionService {
  readonly _serviceBrand: undefined;

  readonly isCompacting: boolean;
  begin(input: CompactInput): boolean;
  cancel(): void;

  readonly hooks: Hooks<{
    onWillCompact: FullCompactionWillCompactContext;
  }>;
}

export const IAgentFullCompactionService = createDecorator<IAgentFullCompactionService>('agentFullCompactionService');
