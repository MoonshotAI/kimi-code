/**
 * `activityView` domain (L4) — `IAgentActivityView` implementation.
 *
 * A pure fold of the agent's own event bus: turn boundaries drive the turn
 * slice (active → detail updates → ended → `lastTurn`), step/delta/tool/retry
 * events drive the live phase/stream/retry detail, permission approval events
 * drive the pending-approval list, while task and full-compaction events drive
 * the background-work slice. The view seeds once from `IAgentLoopService`,
 * `IAgentTaskService`, and `IAgentFullCompactionService` (reads, never writes)
 * and otherwise holds only derived state, so it can be discarded and rebuilt
 * at any time. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { TurnEndReason } from '#/agent/loop/turnEvents';

import type {
  ActivityLastTurnState,
  ActivityRetryState,
  ActivityTurnState,
  ActivityViewLifecycle,
  AgentActivityState,
  ApprovalRef,
  BackgroundRef,
  ToolCallRef,
  TurnPhase,
} from './activityView';
import { IAgentActivityView } from './activityView';

type EndingReason = NonNullable<ActivityTurnState['endingReason']>;
const FULL_COMPACTION_BACKGROUND_ID = 'full-compaction';

export class AgentActivityView extends Disposable implements IAgentActivityView {
  declare readonly _serviceBrand: undefined;

  private lifecycle: ActivityViewLifecycle = 'ready';
  private turn: MutableTurn | undefined;
  private lastTurn: ActivityLastTurnState | undefined;
  private readonly background = new Map<string, BackgroundRef>();
  private current: AgentActivityState = { lifecycle: 'ready', background: [] };

  constructor(
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentFullCompactionService private readonly fullCompaction: IAgentFullCompactionService,
  ) {
    super();
    this.seedFromLoop();
    this.seedFromTasks();
    this.seedFromFullCompaction();

    this._register(this.eventBus.subscribe('turn.started', (e) => this.onTurnStarted(e.turnId, e.origin)));
    this._register(this.eventBus.subscribe('turn.step.started', (e) => this.onStepStarted(e.step)));
    this._register(this.eventBus.subscribe('assistant.delta', () => this.onDelta('assistant')));
    this._register(this.eventBus.subscribe('thinking.delta', () => this.onDelta('thinking')));
    this._register(this.eventBus.subscribe('tool.call.delta', () => this.onDelta('tool_call')));
    this._register(
      this.eventBus.subscribe('tool.call.started', (e) => this.onToolCallStarted(e.toolCallId, e.name)),
    );
    this._register(this.eventBus.subscribe('tool.result', (e) => this.onToolResult(e.toolCallId)));
    this._register(
      this.eventBus.subscribe('turn.step.retrying', (e) => {
        this.mutateTurn((t) => {
          t.phase = 'retrying';
          t.stream = undefined;
          t.retry = {
            failedAttempt: e.failedAttempt,
            nextAttempt: e.nextAttempt,
            maxAttempts: e.maxAttempts,
            delayMs: e.delayMs,
            errorName: e.errorName,
            statusCode: e.statusCode,
          };
        });
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.step.completed', () => {
        this.mutateTurn((t) => {
          t.phase = 'running';
          t.stream = undefined;
          t.retry = undefined;
        });
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.step.interrupted', (e) => this.onStepInterrupted(e.turnId, e.reason)),
    );
    this._register(
      this.eventBus.subscribe('turn.ended', (e) => this.onTurnEnded(e.turnId, e.reason)),
    );
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
    this._register(
      this.eventBus.subscribe('task.started', (e) => {
        this.background.set(e.info.taskId, {
          kind: e.info.kind,
          id: e.info.taskId,
          since: e.info.startedAt,
        });
        this.publish();
      }),
    );
    this._register(
      this.eventBus.subscribe('task.terminated', (e) => {
        if (this.background.delete(e.info.taskId)) this.publish();
      }),
    );
    this._register(
      this.eventBus.subscribe('compaction.started', () => {
        this.background.set(FULL_COMPACTION_BACKGROUND_ID, {
          kind: 'compaction',
          id: FULL_COMPACTION_BACKGROUND_ID,
          since: Date.now(),
        });
        this.publish();
      }),
    );
    this._register(
      this.eventBus.subscribe('compaction.completed', () => {
        this.onFullCompactionEnded();
      }),
    );
    this._register(
      this.eventBus.subscribe('compaction.cancelled', () => {
        this.onFullCompactionEnded();
      }),
    );
  }

  state(): AgentActivityState {
    return this.current;
  }

  override dispose(): void {
    this.lifecycle = 'disposed';
    this.publish();
    super.dispose();
  }

  // -------------------------------------------------------------------------

  private seedFromLoop(): void {
    const status = this.loop.status();
    if (status.state !== 'running' || status.activeTurnId === undefined) return;
    this.turn = new MutableTurn(status.activeTurnId, USER_PROMPT_ORIGIN);
    this.publish();
  }

  /** Seed the background slice from the task registry (restart-persistent
   *  tasks may already be running when the view is created). */
  private seedFromTasks(): void {
    for (const info of this.tasks.list(true)) {
      this.background.set(info.taskId, { kind: info.kind, id: info.taskId, since: info.startedAt });
    }
    if (this.background.size > 0) this.publish();
  }

  private seedFromFullCompaction(): void {
    if (this.fullCompaction.compacting === null) return;
    this.background.set(FULL_COMPACTION_BACKGROUND_ID, {
      kind: 'compaction',
      id: FULL_COMPACTION_BACKGROUND_ID,
      since: Date.now(),
    });
    this.publish();
  }

  private onFullCompactionEnded(): void {
    if (this.background.delete(FULL_COMPACTION_BACKGROUND_ID)) this.publish();
  }

  private onTurnStarted(turnId: number, origin?: PromptOrigin): void {
    this.turn = new MutableTurn(turnId, origin ?? USER_PROMPT_ORIGIN);
    // A fresh turn means there is no current outcome: drop the previous
    // turn's terminal reason so consumers (the work_changed fold, REST
    // session facts) stop reporting it while this turn runs. turn.ended
    // publishes the new outcome when the turn finishes.
    this.lastTurn = undefined;
    this.publish();
  }

  private onTurnEnded(turnId: number, reason: TurnEndReason): void {
    if (this.turn === undefined || this.turn.turnId !== turnId) {
      // A turn the view never saw (e.g. seeded late) — still record the outcome.
      this.lastTurn = { turnId, reason, at: Date.now() };
      this.publish();
      return;
    }
    this.lastTurn = { turnId, reason, durationMs: Date.now() - this.turn.since, at: Date.now() };
    this.turn = undefined;
    this.publish();
  }

  private onStepStarted(step: number): void {
    this.mutateTurn((t) => {
      t.step = step;
      t.phase = 'running';
      t.stream = undefined;
      t.retry = undefined;
    });
  }

  private onStepInterrupted(turnId: number, reason: string): void {
    if (reason !== 'aborted' && reason !== 'max_steps' && reason !== 'error') return;
    this.mutateTurn((t) => {
      if (t.turnId !== turnId) return;
      t.ending = true;
      t.endingReason = reason;
    });
  }

  private onDelta(stream: 'assistant' | 'thinking' | 'tool_call'): void {
    this.mutateTurn((t) => {
      t.phase = 'streaming';
      t.stream = stream;
      t.retry = undefined;
    });
  }

  private onToolCallStarted(toolCallId: string, name: string): void {
    this.mutateTurn((t) => {
      t.phase = 'tool_call';
      t.stream = undefined;
      t.retry = undefined;
      t.activeToolCalls.set(toolCallId, { toolCallId, name, since: Date.now() });
    });
  }

  private onToolResult(toolCallId: string): void {
    this.mutateTurn((t) => {
      t.activeToolCalls.delete(toolCallId);
      t.phase = t.activeToolCalls.size === 0 ? 'running' : 'tool_call';
      t.stream = undefined;
      t.retry = undefined;
    });
  }

  private onApprovalRequested(toolCallId: string): void {
    this.mutateTurn((t) => {
      t.pendingApprovals.set(toolCallId, { approvalId: toolCallId, toolCallId, since: Date.now() });
    });
  }

  private onApprovalResolved(toolCallId: string): void {
    this.mutateTurn((t) => {
      t.pendingApprovals.delete(toolCallId);
    });
  }

  // -------------------------------------------------------------------------

  private mutateTurn(mutate: (t: MutableTurn) => void): void {
    if (this.turn === undefined) return;
    mutate(this.turn);
    this.publish();
  }

  private publish(): void {
    const t = this.turn;
    const next: AgentActivityState = {
      lifecycle: this.lifecycle,
      turn: t === undefined ? undefined : t.snapshot(),
      lastTurn: this.lastTurn,
      background: [...this.background.values()],
    };
    if (activityEqual(this.current, next)) return;
    this.current = next;
    this.eventBus.publish({ type: 'agent.activity.updated', ...next });
  }
}

class MutableTurn {
  phase: TurnPhase = 'running';
  stream: ActivityTurnState['stream'];
  step = 0;
  ending = false;
  endingReason: EndingReason | undefined;
  retry: ActivityRetryState | undefined;
  readonly pendingApprovals = new Map<string, ApprovalRef>();
  readonly activeToolCalls = new Map<string, ToolCallRef>();
  readonly since = Date.now();

  constructor(
    readonly turnId: number,
    readonly origin: PromptOrigin,
  ) {}

  snapshot(): ActivityTurnState {
    return {
      turnId: this.turnId,
      origin: this.origin,
      phase: this.phase,
      stream: this.stream,
      step: this.step,
      ending: this.ending,
      endingReason: this.endingReason,
      retry: this.retry,
      pendingApprovals: [...this.pendingApprovals.values()],
      activeToolCalls: [...this.activeToolCalls.values()],
      since: this.since,
    };
  }
}

function activityEqual(a: AgentActivityState, b: AgentActivityState): boolean {
  if (a.lifecycle !== b.lifecycle) return false;
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
  if (a.background.length !== b.background.length) return false;
  for (let i = 0; i < a.background.length; i++) {
    if (a.background[i]!.id !== b.background[i]!.id || a.background[i]!.kind !== b.background[i]!.kind) {
      return false;
    }
  }
  return true;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentActivityView,
  AgentActivityView,
  InstantiationType.Delayed,
  'activityView',
);
