import type {
  CompactionBeginData,
  CompactionResult,
  CompactionSource,
} from '../../../agent/compaction';
import { createDecorator } from '../../../di';
import type { OrderedHookSlot } from '../hooks';

export interface CompactInput {
  readonly source: CompactionSource;
  readonly instruction?: string;
  readonly customInstruction?: string;
  readonly signal?: AbortSignal;
}

export interface PreCompactContext {
  readonly trigger: CompactionSource;
  readonly tokenCount: number;
  readonly signal: AbortSignal;
}

export interface PostCompactContext {
  readonly trigger: CompactionSource;
  readonly estimatedTokenCount: number;
  readonly result: CompactionResult;
}

export interface FullCompactionHooks {
  readonly preCompact: OrderedHookSlot<PreCompactContext>;
  readonly postCompact: OrderedHookSlot<PostCompactContext>;
}

export interface IFullCompaction {
  readonly isCompacting: boolean;
  readonly hooks: FullCompactionHooks;

  begin(input: CompactInput): boolean;
  compact(input: CompactInput): Promise<void>;
  cancel(): void;
  markCompleted(): void;
  resetForTurn(): void;
  handleOverflowError(signal: AbortSignal, error: unknown, turnId?: string): Promise<void>;
  beforeStep(signal: AbortSignal, turnId?: string): Promise<void>;
  afterStep(): Promise<void>;
}

type CompactionTelemetryEvent = 'compaction_finished' | 'compaction_failed';
type CompactionTelemetryProperties = Record<string, string | number | boolean | undefined>;

declare module '../types' {
  interface AgentEventMap {
    'compaction.started': {
      trigger: CompactionSource;
      instruction?: string;
    };
    'compaction.blocked': {
      turnId: string;
    };
    'compaction.cancelled': {};
    'compaction.completed': {
      result: CompactionResult;
    };
    'compaction.failed': {
      source: CompactionSource;
      instruction?: string;
      error: {
        code: string | undefined;
        name: string | undefined;
        message: string;
      };
    };
    'compaction.telemetry': {
      event: CompactionTelemetryEvent;
      properties: CompactionTelemetryProperties;
    };
  }

  interface WireRecordMap {
    'full_compaction.begin': CompactionBeginData;
    'full_compaction.cancel': {};
    'full_compaction.complete': {};
  }
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IFullCompaction = createDecorator<IFullCompaction>('agentFullCompactionService');
