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
  /** Turn source, forwarded to the lease and the snapshot; admission is origin-agnostic. */
  readonly origin?: PromptOrigin;
  /** Stable id reserved by the loop when the turn is enqueued. */
  readonly turnId?: number;
}

export interface ActivityLease {
  readonly kind: 'turn';
  readonly turnId: number;
  readonly origin: PromptOrigin;
  /** Cancellation flows one way from the kernel: `cancel()` aborts this signal. */
  readonly signal: AbortSignal;
  /** True once `cancel()` has been issued and the turn is draining. */
  readonly ending: boolean;
  /** Must be called in a `finally`; idempotent. Returns the lane to `idle` and records the outcome. */
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

  /**
   * Atomic admission: synchronously performs "session admission consult → own
   * lane check → enter turn lane → issue lease → register with the session
   * kernel". Any failing step throws a coded error with no state residue. The
   * synchronous shape (no `await`) is what makes admission atomic under the
   * single-threaded event loop.
   */
  begin(kind: 'turn', opts?: BeginOptions): ActivityLease;

  /** Non-throwing variant: returns `undefined` when admission fails. */
  tryBegin(kind: 'turn', opts?: BeginOptions): ActivityLease | undefined;

  /**
   * Drives the `initializing → idle` transition. Called by the agent bootstrap
   * (`agentLifecycle.create`) once construction (and the eager tool / hook / MCP
   * setup) has finished and the agent is ready to admit turns. Until then
   * `begin` rejects with `activity.initializing`. No-op when not `initializing`.
   */
  markReady(): void;

  /** Unified cancel: `turn(active)` → `turn(ending)` and aborts the lease signal. Idempotent. */
  cancel(reason?: unknown): boolean;

  /** Registers a background activity (compaction etc.): visible, cancellable, aborted on disposal. */
  registerBackground(kind: string, controller: AbortController): IDisposable & { readonly id: string };

  /** Enters `disposing`: rejects new `begin`, aborts every lease and background activity. */
  beginDisposal(): void;
  /** Resolves once every lease and background activity has drained. Awaited by `agentLifecycle`. */
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

  /** Leaves the restore/materialize window and admits normal session commands. */
  markActive(): void;

  /** Admission table for edge (gateway / rpc / legacy) and `agentLifecycle` commands. */
  canAccept(command: SessionCommand): boolean;

  /**
   * Called synchronously by the Agent kernel on `begin` (child-injects-parent):
   * throws `activity.session_rejected` while `quiescing` / `closing` /
   * `restoring`; otherwise registers the lease for settle tracking and returns
   * its unregister handle.
   */
  admitTurn(agentId: string, lease: ActivityLease): IDisposable;

  /**
   * Atomically acquires global quiescence: synchronously flips the lane to
   * `quiescing` (closing the door so subsequent `admitTurn` calls reject), then
   * awaits every in-flight lease to drain.
   */
  quiesce(reason: string): Promise<SessionQuiesceLease>;

  beginClosing(): void;
  settled(): Promise<void>;

  /**
   * Drives the `restoring → active` transition. Called by the session lifecycle
   * once materialization (and, for resume, replay) has finished and the session
   * is ready to accept commands. No-op when not `restoring`.
   */
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

/**
 * Structured read model of "what the agent is doing". The observable state
 * space is `lane × turn sub-phase × pending-approval set × active-tool-call set
 * × background-activity set`; the authoritative machine itself stays the five
 * `AgentLane` positions. Derived by the `runtime` projector from the kernel's
 * `LaneModel` plus `IEventBus` facts; emitted as `agent.activity.updated`.
 */
export interface AgentActivitySnapshot {
  readonly lane: AgentLane;
  readonly turn?: ActivityTurnState;
  readonly lastTurn?: ActivityLastTurnState;
  readonly background: readonly BackgroundActivityRef[];
}
