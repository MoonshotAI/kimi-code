/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { TurnEndReason } from '#/agent/loop/turnEvents';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { AgentEvent2 } from '#/app/event/event2';

import type { UsageStatus } from './usage';

export interface AgentStatusUpdatedPayload {
  readonly agentId: string;
  usage?: UsageStatus;
  swarmMode?: boolean;
  towerMode?: boolean;
  planMode?: boolean;
  model?: string;
  thinkingEffort?: string;
  maxContextTokens?: number;
  contextTokens?: number;
}

export class AgentStatusUpdated extends AgentEvent2<AgentStatusUpdatedPayload> {
  static override readonly type = 'agent.status.updated';
  static override readonly observable = true;
}
export interface AgentStatusUpdated extends AgentStatusUpdatedPayload {}

export type AgentPhase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
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
      readonly reason: TurnEndReason;
      readonly durationMs?: number;
      readonly at: number;
    };

export interface AgentStatusUpdatedEvent {
  readonly type: 'agent.status.updated';
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly contextUsage?: number;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly towerMode?: boolean;
  readonly permission?: PermissionMode;
  readonly usage?: UsageStatus;
  readonly phase?: AgentPhase;
}
