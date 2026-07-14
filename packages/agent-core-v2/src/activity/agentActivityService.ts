/**
 * `activity` domain (L4) — `IAgentActivityService` implementation.
 *
 * Owns the Agent activity lane (`idle ⇄ turn(active|ending)`, plus `disposing`
 * / `disposed`) and is the sole dispatcher of the `activityLane` wire Model
 * (`activity.set_lane`). `begin('turn')` atomically consults the Session kernel
 * (`ISessionActivityKernel.admitTurn`, child-injects-parent), reads the next
 * turn id from the `turn` `TurnModel`, enters the turn lane and returns an
 * `ActivityLease`; the lease's `AbortSignal` is the only cancellation channel,
 * and `lease.end()` is the only path back to `idle`. Background activities
 * (`registerBackground`) are tracked so disposal can abort and await them. The
 * lane starts at `initializing` and is driven to `idle` by `markReady()` once
 * the agent bootstrap (`agentLifecycle.create`) finishes; until then `begin`
 * rejects with `activity.initializing`. The half-replay window on resume is
 * gated by the Session kernel (`restoring`). Bound at Agent scope.
 */

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { userCancellationReason } from '#/_base/utils/abort';
import { ErrorCodes, Error2 } from '#/errors';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { TurnModel } from '#/agent/loop/turnOps';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';

import type {
  ActivityLease,
  AgentLane,
  BackgroundActivityRef,
  BeginOptions,
} from './activity';
import { IAgentActivityService, ISessionActivityKernel } from './activity';
import { type LaneLastTurnState, setLane } from './activityOps';

let nextBackgroundId = 0;

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
  private _endingReason: 'aborted' | 'max_steps' | 'error' | undefined;
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

  get endingReason(): 'aborted' | 'max_steps' | 'error' | undefined {
    return this._endingReason;
  }

  markEnding(reason?: unknown): void {
    if (this._ending || this._ended) return;
    this._ending = true;
    this._endingReason = 'aborted';
    this.controller.abort(reason ?? userCancellationReason());
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

  private _lane: AgentLane = 'initializing';
  private activeLease: LeaseImpl | undefined;
  private lastTurn: LaneLastTurnState | undefined;
  private readonly background = new Map<string, BackgroundEntry>();
  private readonly settleWaiters: Array<() => void> = [];

  constructor(
    @IAgentWireService private readonly wire: IWireService,
    @ISessionActivityKernel private readonly sessionKernel: ISessionActivityKernel,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {
    super();
  }

  lane(): AgentLane {
    return this._lane;
  }

  begin(kind: 'turn', opts?: BeginOptions): ActivityLease {
    if (kind !== 'turn') {
      throw new Error2(ErrorCodes.NOT_IMPLEMENTED, `Unsupported activity kind: ${String(kind)}`);
    }
    switch (this._lane) {
      case 'turn':
        throw new Error2(
          ErrorCodes.ACTIVITY_AGENT_BUSY,
          `Cannot begin a new turn while turn ${this.activeLease?.turnId ?? '?'} is active`,
          { details: { turnId: this.activeLease?.turnId } },
        );
      case 'disposing':
        throw new Error2(ErrorCodes.ACTIVITY_DISPOSING, 'Agent is disposing');
      case 'disposed':
        throw new Error2(ErrorCodes.ACTIVITY_DISPOSED, 'Agent is disposed');
      case 'initializing':
        throw new Error2(ErrorCodes.ACTIVITY_INITIALIZING, 'Agent is still restoring');
      case 'idle':
        break;
    }

    const turnId = opts?.turnId ?? this.wire.getModel(TurnModel).nextTurnId;
    const origin = opts?.origin ?? USER_PROMPT_ORIGIN;
    const lease = new LeaseImpl(turnId, origin, this);
    lease.registration = this.sessionKernel.admitTurn(this.scopeContext.agentId, lease);

    this.activeLease = lease;
    this._lane = 'turn';
    this.publishLane();
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
    if (this._lane !== 'initializing') return;
    this._lane = 'idle';
    this.publishLane();
  }

  cancel(reason?: unknown): boolean {
    const lease = this.activeLease;
    if (lease === undefined) return false;
    if (lease.ending) return true;
    lease.markEnding(reason);
    this.publishLane();
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
    this.publishLane();
    const dispose = (): void => {
      if (this.background.delete(id)) {
        this.publishLane();
      }
      this.maybeSettle();
    };
    return { id, dispose };
  }

  beginDisposal(): void {
    if (this._lane === 'disposing' || this._lane === 'disposed') return;
    this._lane = 'disposing';
    this.activeLease?.markEnding();
    for (const entry of this.background.values()) {
      entry.controller.abort();
    }
    this.publishLane();
    this.maybeSettle();
  }

  settled(): Promise<void> {
    if (this._lane === 'disposed') return Promise.resolve();
    if (
      this._lane !== 'disposing' &&
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
    if (this._lane === 'disposing') {
      this.maybeSettle();
      return;
    }
    this._lane = 'idle';
    this.publishLane();
    this.maybeSettle();
  }

  private maybeSettle(): void {
    if (this.activeLease !== undefined || this.background.size > 0) return;
    if (this._lane === 'disposing') {
      this._lane = 'disposed';
      this.publishLane();
    }
    if (this.settleWaiters.length === 0) return;
    const waiters = this.settleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private publishLane(): void {
    const lease = this.activeLease;
    this.wire.dispatch(
      setLane({
        next: {
          lane: this._lane,
          turn:
            lease === undefined
              ? undefined
              : {
                  turnId: lease.turnId,
                  origin: lease.origin,
                  ending: lease.ending,
                  endingReason: lease.endingReason,
                  since: lease.since,
                },
          lastTurn: this.lastTurn,
          background: [...this.background.values()].map((entry) => entry.ref),
        },
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentActivityService,
  AgentActivityService,
  InstantiationType.Delayed,
  'activity',
);
