import type { StepUsage } from './turn';

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

export interface GoalMeta {
  readonly objective: string;
  readonly status: GoalStatus;
  readonly completionCriterion?: string;
  readonly budgetUsed?: number;
  readonly budgetLimit?: number;
}

export interface ModesMeta {
  readonly plan?: { readonly reviewPath?: string; readonly version?: number };
  readonly swarm?: { readonly trigger?: string };
  readonly tower?: Record<string, never>;
}

export interface ModesMetaMerge {
  readonly plan?: { readonly reviewPath?: string; readonly version?: number } | null;
  readonly swarm?: { readonly trigger?: string } | null;
  readonly tower?: Record<string, never> | null;
}

export type ActivityMeta = 'idle' | 'turn' | 'disposing' | 'unknown';

export type TurnEndReasonMeta = 'completed' | 'cancelled' | 'failed' | 'blocked';

export type AgentPhaseMeta =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly since: number;
    }
  | {
      readonly kind: 'streaming';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly stream: 'assistant' | 'thinking' | 'tool_call';
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly since: number;
    }
  | {
      readonly kind: 'tool_call';
      readonly turnId: number;
      readonly step: number;
      readonly toolCallId: string;
      readonly name: string;
      readonly since: number;
    }
  | {
      readonly kind: 'retrying';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly failedAttempt: number;
      readonly nextAttempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly errorName?: string;
      readonly statusCode?: number;
      readonly since: number;
    }
  | {
      readonly kind: 'awaiting_approval';
      readonly turnId: number;
      readonly step?: number;
      readonly approval?: unknown;
      readonly since: number;
    }
  | {
      readonly kind: 'interrupted';
      readonly turnId: number;
      readonly step?: number;
      readonly reason: 'aborted' | 'max_steps' | 'error';
      readonly message?: string;
      readonly at: number;
    }
  | {
      readonly kind: 'ended';
      readonly turnId: number;
      readonly reason: TurnEndReasonMeta;
      readonly durationMs?: number;
      readonly at: number;
    };

export interface AgentUsageMeta {
  readonly byModel?: Readonly<Record<string, StepUsage>>;
  readonly currentTurn?: StepUsage;
  readonly total?: StepUsage;
}

export interface AgentStatusMeta {
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly usage?: AgentUsageMeta;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly contextUsage?: number;
  readonly permission?: 'manual' | 'yolo' | 'auto';
  readonly phase?: AgentPhaseMeta;
}

export interface TranscriptMeta {
  readonly goal?: GoalMeta;
  readonly modes?: ModesMeta;
  readonly activity?: ActivityMeta;
  readonly agent?: AgentStatusMeta;
}

export type TranscriptMetaMerge = Omit<TranscriptMeta, 'modes' | 'goal'> & {
  readonly modes?: ModesMetaMerge;
  readonly goal?: GoalMeta | null;
};
