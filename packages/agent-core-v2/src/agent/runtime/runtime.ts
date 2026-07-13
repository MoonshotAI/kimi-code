/**
 * `runtime` domain (L4) — Agent-scope live phase contract.
 *
 * Defines the public contract of the agent's whole live phase: the `AgentPhase`
 * discriminated union (each variant carries its own ancillary fields) and the
 * `IAgentRuntimeService` used to read the current phase via `phase()`. The
 * phase is the agent-level, fine-grained counterpart of the session-level
 * `sessionActivity` status: it splits `running` into waiting / streaming /
 * tool_call / retrying and adds `interrupted` / `ended`. Agent-scoped — one
 * instance per agent.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { TurnEndedEvent } from '@moonshot-ai/protocol';

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
      readonly approval: unknown;
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
      readonly reason: TurnEndedEvent['reason'];
      readonly durationMs?: number;
      readonly at: number;
    };

export interface IAgentRuntimeService {
  readonly _serviceBrand: undefined;

  phase(): AgentPhase;
}

export const IAgentRuntimeService: ServiceIdentifier<IAgentRuntimeService> =
  createDecorator<IAgentRuntimeService>('agentRuntimeService');
