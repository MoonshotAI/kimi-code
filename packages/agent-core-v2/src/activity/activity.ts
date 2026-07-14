/**
 * `activity` domain (L4) — Agent / Session activity kernel contracts.
 *
 * Defines the authoritative activity state machines shared by the Agent and
 * Session scopes. `IAgentActivityService` is the Agent-scope lane machine: it
 * owns turn admission (`begin`/`tryBegin`), cancellation, background-activity
 * registration and disposal settlement, and is the sole dispatcher of the
 * `activityLane` wire Model (`activityOps`). `ISessionActivityKernel` is the
 * Session-scope lifecycle lane + admission table that the Agent kernel consults
 * synchronously on every `begin` (child-injects-parent), so admission stays
 * atomic inside a single event-loop turn. The `ActivityLease` returned by
 * `begin` carries the turn's `AbortSignal` and is the only path back to `idle`
 * (`lease.end`). Multi-scope domain: `IAgentActivityService` bound at Agent
 * scope, `ISessionActivityKernel` bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { TurnEndReason } from '@moonshot-ai/protocol';

export type AgentLane = 'initializing' | 'idle' | 'turn' | 'disposing' | 'disposed';

export interface BeginOptions {
  readonly origin?: PromptOrigin;
  readonly turnId?: number;
}

export interface ActivityLease {
  readonly kind: 'turn';
  readonly turnId: number;
  readonly origin: PromptOrigin;
  readonly signal: AbortSignal;
  readonly ending: boolean;
  end(outcome: 'completed' | 'cancelled' | 'failed', detail?: { error?: unknown }): void;
}

export interface BackgroundActivityRef {
  readonly kind: 'compaction' | 'task' | (string & {});
  readonly id: string;
  readonly since: number;
  readonly signal: AbortSignal;
}

export interface IAgentActivityService {
  readonly _serviceBrand: undefined;

  lane(): AgentLane;

  begin(kind: 'turn', opts?: BeginOptions): ActivityLease;

  tryBegin(kind: 'turn', opts?: BeginOptions): ActivityLease | undefined;

  markReady(): void;

  cancel(reason?: unknown): boolean;

  registerBackground(kind: string, controller: AbortController): IDisposable & { readonly id: string };

  beginDisposal(): void;
  settled(): Promise<void>;
}

export const IAgentActivityService: ServiceIdentifier<IAgentActivityService> =
  createDecorator<IAgentActivityService>('agentActivityService');

export type SessionLane = 'restoring' | 'active' | 'quiescing' | 'closing' | 'disposed';

export type SessionCommand =
  | 'turn.begin'
  | 'agent.create'
  | 'session.fork'
  | 'session.archive'
  | 'session.close'
  | (string & {});

export interface SessionQuiesceLease extends IDisposable {
  readonly reason: string;
}

export interface ISessionActivityKernel {
  readonly _serviceBrand: undefined;

  lane(): SessionLane;

  markActive(): void;

  canAccept(command: SessionCommand): boolean;

  admitTurn(agentId: string, lease: ActivityLease): IDisposable;

  quiesce(reason: string): Promise<SessionQuiesceLease>;

  beginClosing(): void;
  settled(): Promise<void>;

  markActive(): void;
}

export const ISessionActivityKernel: ServiceIdentifier<ISessionActivityKernel> =
  createDecorator<ISessionActivityKernel>('sessionActivityKernel');

export type TurnPhase = 'running' | 'streaming' | 'tool_call' | 'retrying';

export interface ApprovalRef {
  readonly approvalId: string;
  readonly toolCallId?: string;
  readonly since: number;
}

export interface ToolCallRef {
  readonly toolCallId: string;
  readonly name: string;
  readonly since: number;
}

export interface ActivityRetryState {
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName?: string;
  readonly statusCode?: number;
}

export interface ActivityTurnState {
  readonly turnId: number;
  readonly origin: PromptOrigin;
  readonly phase: TurnPhase;
  readonly stream?: 'assistant' | 'thinking' | 'tool_call';
  readonly step: number;
  readonly ending: boolean;
  readonly endingReason?: 'aborted' | 'max_steps' | 'error';
  readonly retry?: ActivityRetryState;
  readonly pendingApprovals: readonly ApprovalRef[];
  readonly activeToolCalls: readonly ToolCallRef[];
  readonly since: number;
}

export interface ActivityLastTurnState {
  readonly turnId: number;
  readonly reason: TurnEndReason;
  readonly durationMs?: number;
  readonly at: number;
}

export interface AgentActivitySnapshot {
  readonly lane: AgentLane;
  readonly turn?: ActivityTurnState;
  readonly lastTurn?: ActivityLastTurnState;
  readonly background: readonly BackgroundActivityRef[];
}
