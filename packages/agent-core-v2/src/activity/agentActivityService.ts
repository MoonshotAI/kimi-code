/**
 * `activity` domain (L4) — `IAgentActivityService` implementation.
 *
 * Owns the Agent lifecycle (`initializing → ready → disposing → disposed`) and
 * its independent active turn, then projects lifecycle, turn, stream, retry,
 * approval, tool-call and background state onto `agent.activity.updated`.
 * `begin('turn')` atomically consults the Session kernel
 * (`ISessionActivityKernel.admitTurn`, child-injects-parent), reads the next
 * turn id from the `turn` `TurnModel`, records the active turn and returns an
 * `ActivityLease`; the lease's `AbortSignal` is the only cancellation channel,
 * and `lease.end()` is the only path back to `idle`. Background activities
 * (`registerBackground`) are tracked so disposal can abort and await them. The
 * lifecycle starts at `initializing` and is driven to `ready` by `markReady()` once
 * the agent bootstrap (`agentLifecycle.create`) finishes; until then `begin`
 * rejects with `activity.initializing`. The half-replay window on resume is
 * gated by the Session kernel (`restoring`). Bound at Agent scope.
 */

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { userCancellationReason } from '#/_base/utils/abort';
import { IEventBus } from '#/app/event/eventBus';
import { ErrorCodes, Error2 } from '#/errors';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { TurnModel } from '#/agent/loop/turnOps';
import { IWireService } from '#/wire/wire';

import type {
  ActivityRetryState,
  ActivityLease,
  ActivityLastTurnState,
  ActivityTurnState,
  AgentActivityState,
  AgentLifecycleState,
  ApprovalRef,
  BackgroundActivityRef,
  BeginOptions,
  ToolCallRef,
  TurnPhase,
} from './activity';
import { IAgentActivityService, ISessionActivityKernel } from './activity';

let nextBackgroundId = 0;

type ActivityEndingReason = NonNullable<ActivityTurnState['endingReason']>;

interface BackgroundEntry {
  readonly ref: BackgroundActivityRef;
  readonly controller: AbortController;
}

class LeaseImpl implements ActivityLease {
  readonly kind = 'turn' as const;
  readonly origin: PromptOrigin;
  readonly turnId: number;
  readonly since: number;
  private readonly controller = new AbortController();
  private _ending = false;
  private _ended = false;
  private _endingReason: ActivityEndingReason | undefined;
  registration: IDisposable = Disposable.None;

  constructor(
    turnId: number,
    origin: PromptOrigin,
    private readonly owner: AgentActivityService,
  ) {
    this.turnId = turnId;
    this.origin = origin;
    this.since = Date.now();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get ending(): boolean {
    return this._ending;
  }

  get endingReason(): ActivityEndingReason | undefined {
    return this._endingReason;
  }

  markEnding(reason?: unknown): void {
    if (this._ending || this._ended) return;
    this._ending = true;
    this._endingReason = 'aborted';
    this.controller.abort(reason ?? userCancellationReason());
  }

  markInterrupted(reason: ActivityEndingReason): void {
    if (this._ending || this._ended) return;
    this._ending = true;
    this._endingReason = reason;
  }

  end(outcome: 'completed' | 'cancelled' | 'failed', detail?: { error?: unknown }): void {
    if (this._ended) return;
    this._ended = true;
    if (outcome === 'failed' && this._endingReason === undefined) {
      this._endingReason = 'error';
    }
    this.owner.onLeaseEnd(this, outcome, detail);
  }
}

export class AgentActivityService extends Disposable implements IAgentActivityService {
  declare readonly _serviceBrand: undefined;

  private _lifecycle: AgentLifecycleState = 'initializing';
  private _step = 0;
  private _phase: TurnPhase = 'running';
  private _stream: 'assistant' | 'thinking' | 'tool_call' | undefined;
  private _retry: ActivityRetryState | undefined;
  private _currentState: AgentActivityState = { lifecycle: 'initializing', background: [] };
  private activeLease: LeaseImpl | undefined;
  private lastTurn: ActivityLastTurnState | undefined;
  private readonly background = new Map<string, BackgroundEntry>();
  private readonly pendingApprovals = new Map<string, ApprovalRef>();
  private readonly activeToolCalls = new Map<string, ToolCallRef>();
  private readonly settleWaiters: Array<() => void> = [];

  constructor(
    @IWireService private readonly wire: IWireService,
    @ISessionActivityKernel private readonly sessionKernel: ISessionActivityKernel,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
    this._register(
      this.eventBus.subscribe('turn.step.started', (e) => this.onStepStarted(e.step)),
    );
    this._register(
      this.eventBus.subscribe('assistant.delta', () => this.onDelta('assistant')),
    );
    this._register(
      this.eventBus.subscribe('thinking.delta', () => this.onDelta('thinking')),
    );
    this._register(
      this.eventBus.subscribe('tool.call.delta', () => this.onDelta('tool_call')),
    );
    this._register(
      this.eventBus.subscribe('tool.call.started', (e) =>
        this.onToolCallStarted(e.toolCallId, e.name),
      ),
    );
    this._register(
      this.eventBus.subscribe('tool.result', (e) => this.onToolResult(e.toolCallId)),
    );
    this._register(
      this.eventBus.subscribe('turn.step.retrying', (e) => {
        this._phase = 'retrying';
        this._stream = undefined;
        this._retry = {
          failedAttempt: e.failedAttempt,
          nextAttempt: e.nextAttempt,
          maxAttempts: e.maxAttempts,
          delayMs: e.delayMs,
          errorName: e.errorName,
          statusCode: e.statusCode,
        };
        this.publishActivity();
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.step.completed', () => {
        this.resetStepState();
        this.publishActivity();
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.step.interrupted', (e) =>
        this.onStepInterrupted(e.turnId, e.reason),
      ),
    );
    this._register(this.eventBus.subscribe('turn.ended', () => this.resetTurnState()));
    this._register(
      this.eventBus.subscribe('permission.approval.requested', (e) =>
        this.onApprovalRequested(e.toolCallId),
      ),
    );
    this._register(
      this.eventBus.subscribe('permission.approval.resolved', (e) =>
        this.onApprovalResolved(e.toolCallId),
      ),
    );
  }

  isIdle(): boolean {
    return this._lifecycle === 'ready' && this.activeLease === undefined;
  }

  begin(kind: 'turn', opts?: BeginOptions): ActivityLease {
    if (kind !== 'turn') {
      throw new Error2(ErrorCodes.NOT_IMPLEMENTED, `Unsupported activity kind: ${String(kind)}`);
    }
    switch (this._lifecycle) {
      case 'disposing':
        throw new Error2(ErrorCodes.ACTIVITY_DISPOSING, 'Agent is disposing');
      case 'disposed':
        throw new Error2(ErrorCodes.ACTIVITY_DISPOSED, 'Agent is disposed');
      case 'initializing':
        throw new Error2(ErrorCodes.ACTIVITY_INITIALIZING, 'Agent is still restoring');
      case 'ready':
        break;
    }
    if (this.activeLease !== undefined) {
      throw new Error2(
        ErrorCodes.ACTIVITY_AGENT_BUSY,
        `Cannot begin a new turn while turn ${this.activeLease.turnId} is active`,
        { details: { turnId: this.activeLease.turnId } },
      );
    }

    const turnId = opts?.turnId ?? this.wire.getModel(TurnModel).nextTurnId;
    const origin = opts?.origin ?? USER_PROMPT_ORIGIN;
    const lease = new LeaseImpl(turnId, origin, this);
    lease.registration = this.sessionKernel.admitTurn(this.scopeContext.agentId, lease);

    this.activeLease = lease;
    this.publishActivity();
    return lease;
  }

  tryBegin(kind: 'turn', opts?: BeginOptions): ActivityLease | undefined {
    try {
      return this.begin(kind, opts);
    } catch (error) {
      if (error instanceof Error2) return undefined;
      throw error;
    }
  }

  markReady(): void {
    if (this._lifecycle !== 'initializing') return;
    this._lifecycle = 'ready';
    this.publishActivity();
  }

  cancel(reason?: unknown): boolean {
    const lease = this.activeLease;
    if (lease === undefined) return false;
    if (lease.ending) return true;
    lease.markEnding(reason);
    this.publishActivity();
    return true;
  }

  registerBackground(kind: string, controller: AbortController): IDisposable & { readonly id: string } {
    const id = `bg-${nextBackgroundId++}`;
    const ref: BackgroundActivityRef = {
      kind,
      id,
      since: Date.now(),
      signal: controller.signal,
    };
    this.background.set(id, { ref, controller });
    this.publishActivity();
    const dispose = (): void => {
      if (this.background.delete(id)) {
        this.publishActivity();
      }
      this.maybeSettle();
    };
    return { id, dispose };
  }

  beginDisposal(): void {
    if (this._lifecycle === 'disposing' || this._lifecycle === 'disposed') return;
    this._lifecycle = 'disposing';
    this.activeLease?.markEnding();
    for (const entry of this.background.values()) {
      entry.controller.abort();
    }
    this.publishActivity();
    this.maybeSettle();
  }

  settled(): Promise<void> {
    if (this._lifecycle === 'disposed') return Promise.resolve();
    if (
      this._lifecycle !== 'disposing' &&
      this.activeLease === undefined &&
      this.background.size === 0
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.settleWaiters.push(resolve);
    });
  }

  onLeaseEnd(
    lease: LeaseImpl,
    outcome: 'completed' | 'cancelled' | 'failed',
    _detail?: { error?: unknown },
  ): void {
    if (this.activeLease !== lease) return;
    this.activeLease = undefined;
    lease.registration.dispose();
    lease.registration = Disposable.None;
    this.lastTurn = { turnId: lease.turnId, reason: outcome, at: Date.now() };
    if (this._lifecycle === 'disposing') {
      this.maybeSettle();
      return;
    }
    this.publishActivity();
    this.maybeSettle();
  }

  private maybeSettle(): void {
    if (this.activeLease !== undefined || this.background.size > 0) return;
    if (this._lifecycle === 'disposing') {
      this._lifecycle = 'disposed';
      this.publishActivity();
    }
    if (this.settleWaiters.length === 0) return;
    const waiters = this.settleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private onStepStarted(step: number): void {
    this._step = step;
    this.resetStepState();
    this.publishActivity();
  }

  private onStepInterrupted(turnId: number, reason: string): void {
    if (reason !== 'aborted' && reason !== 'max_steps' && reason !== 'error') return;
    const lease = this.activeLease;
    if (lease === undefined || lease.turnId !== turnId) return;
    lease.markInterrupted(reason);
    this.publishActivity();
  }

  private onDelta(stream: 'assistant' | 'thinking' | 'tool_call'): void {
    this._phase = 'streaming';
    this._stream = stream;
    this._retry = undefined;
    this.publishActivity();
  }

  private onToolCallStarted(toolCallId: string, name: string): void {
    this._phase = 'tool_call';
    this._stream = undefined;
    this._retry = undefined;
    this.activeToolCalls.set(toolCallId, { toolCallId, name, since: Date.now() });
    this.publishActivity();
  }

  private onToolResult(toolCallId: string): void {
    this.activeToolCalls.delete(toolCallId);
    this._phase = this.activeToolCalls.size === 0 ? 'running' : 'tool_call';
    this._stream = undefined;
    this._retry = undefined;
    this.publishActivity();
  }

  private resetTurnState(): void {
    this._step = 0;
    this.resetStepState();
    this.pendingApprovals.clear();
    this.activeToolCalls.clear();
  }

  private onApprovalRequested(toolCallId: string): void {
    this.pendingApprovals.set(toolCallId, {
      approvalId: toolCallId,
      toolCallId,
      since: Date.now(),
    });
    this.publishActivity();
  }

  private onApprovalResolved(toolCallId: string): void {
    this.pendingApprovals.delete(toolCallId);
    this.publishActivity();
  }

  private resetStepState(): void {
    this._phase = 'running';
    this._stream = undefined;
    this._retry = undefined;
  }

  private publishActivity(): void {
    const lease = this.activeLease;
    const turn =
      lease === undefined
        ? undefined
        : {
            turnId: lease.turnId,
            origin: lease.origin,
            phase: this._phase,
            stream: this._stream,
            step: this._step,
            ending: lease.ending,
            endingReason: lease.endingReason,
            retry: this._retry,
            pendingApprovals: [...this.pendingApprovals.values()],
            activeToolCalls: [...this.activeToolCalls.values()],
            since: lease.since,
          };
    const state: AgentActivityState = {
      lifecycle: this._lifecycle,
      turn,
      lastTurn: this.lastTurn,
      background: [...this.background.values()].map((entry) => entry.ref),
    };
    if (activityEqual(this._currentState, state)) return;
    this._currentState = state;
    this.eventBus.publish({ type: 'agent.activity.updated', ...state });
  }
}

function activityEqual(a: AgentActivityState, b: AgentActivityState): boolean {
  if (a.lifecycle !== b.lifecycle) return false;
  if (a.background.length !== b.background.length) return false;
  if ((a.turn === undefined) !== (b.turn === undefined)) return false;
  if (a.turn !== undefined && b.turn !== undefined) {
    const ta = a.turn;
    const tb = b.turn;
    if (
      ta.turnId !== tb.turnId ||
      ta.phase !== tb.phase ||
      ta.stream !== tb.stream ||
      ta.step !== tb.step ||
      ta.ending !== tb.ending ||
      ta.endingReason !== tb.endingReason ||
      ta.pendingApprovals.length !== tb.pendingApprovals.length ||
      ta.activeToolCalls.length !== tb.activeToolCalls.length
    ) {
      return false;
    }
    if (ta.retry?.nextAttempt !== tb.retry?.nextAttempt) return false;
  }
  if ((a.lastTurn === undefined) !== (b.lastTurn === undefined)) return false;
  if (a.lastTurn !== undefined && b.lastTurn !== undefined) {
    if (a.lastTurn.turnId !== b.lastTurn.turnId || a.lastTurn.reason !== b.lastTurn.reason) {
      return false;
    }
  }
  return true;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentActivityService,
  AgentActivityService,
  InstantiationType.Eager,
  'activity',
);
