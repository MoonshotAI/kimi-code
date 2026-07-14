/**
 * `runtime` domain (L4) — `IAgentRuntimeService` implementation and the Agent
 * activity projector.
 *
 * Folds the agent's live activity into a structured `AgentActivitySnapshot`
 * (`ActivityModel`, mutated only through the `activity.set_snapshot` Op) and a
 * legacy `AgentPhase` (`RuntimeModel`, through `runtime.set_phase`). Inputs:
 * the `activity` kernel's `LaneModel` (authoritative lane / turn / lastTurn /
 * background) plus the existing `IEventBus` facts (step / stream / retry /
 * approval / tool-call). The snapshot adds a pending-approval SET and an
 * active-tool-call SET (keyed by id), so a parallel approval resolve no longer
 * drops the still-waiting ones (矛盾 d) and parallel tool calls are all
 * visible. Subscriptions are edge-triggered: `publishSnapshot` only dispatches
 * when `snapshotEqual` says it changed. Live-only — `wire.replay` stays silent
 * and resumes into `idle`. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import type { PermissionApprovalRequestContext } from '#/agent/permissionGate/permissionGateService';
import type { TurnEndedEvent } from '@moonshot-ai/protocol';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';
import type {
  ActivityRetryState,
  AgentActivitySnapshot,
  ApprovalRef,
  ToolCallRef,
  TurnPhase,
} from '#/activity/activity';
import { LaneModel } from '#/activity/activityOps';

import { type AgentPhase, IAgentRuntimeService } from './runtime';
import {
  phaseEqual,
  RuntimeModel,
  setActivitySnapshot,
  setRuntimePhase,
} from './runtimeOps';

interface TurnCursor {
  readonly turnId: number;
  readonly step: number;
  readonly stepId: string;
}

export class AgentRuntimeService extends Disposable implements IAgentRuntimeService {
  declare readonly _serviceBrand: undefined;

  private cursor: TurnCursor = { turnId: -1, step: 0, stepId: '' };
  private current: AgentPhase = { kind: 'idle' };
  private priorForApproval: AgentPhase | undefined;
  private subPhase: TurnPhase = 'running';
  private subStream: 'assistant' | 'thinking' | 'tool_call' | undefined;
  private subRetry: ActivityRetryState | undefined;
  private readonly pendingApprovals = new Map<string, ApprovalRef>();
  private readonly activeToolCalls = new Map<string, ToolCallRef>();

  constructor(
    @IAgentWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
    this._register(this.eventBus.subscribe('turn.started', (e) => this.onTurnStarted(e.turnId)));
    this._register(
      this.eventBus.subscribe('turn.step.started', (e) =>
        this.onStepStarted(e.turnId, e.step, e.stepId ?? ''),
      ),
    );
    this._register(
      this.eventBus.subscribe('assistant.delta', () => this.onDelta('assistant')),
    );
    this._register(
      this.eventBus.subscribe('thinking.delta', () => this.onDelta('thinking')),
    );
    this._register(
      this.eventBus.subscribe('tool.call.delta', (e) =>
        this.onToolCallDelta(e.toolCallId, e.name),
      ),
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
        this.subPhase = 'retrying';
        this.subStream = undefined;
        this.subRetry = {
          failedAttempt: e.failedAttempt,
          nextAttempt: e.nextAttempt,
          maxAttempts: e.maxAttempts,
          delayMs: e.delayMs,
          errorName: e.errorName,
          statusCode: e.statusCode,
        };
        this.setPhase({
          kind: 'retrying',
          turnId: e.turnId,
          step: e.step,
          stepId: e.stepId ?? '',
          failedAttempt: e.failedAttempt,
          nextAttempt: e.nextAttempt,
          maxAttempts: e.maxAttempts,
          delayMs: e.delayMs,
          errorName: e.errorName,
          statusCode: e.statusCode,
          since: Date.now(),
        });
        this.publishSnapshot();
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.step.interrupted', (e) =>
        this.setPhase({
          kind: 'interrupted',
          turnId: e.turnId,
          step: e.step,
          reason: e.reason as 'aborted' | 'max_steps' | 'error',
          message: e.message,
          at: Date.now(),
        }),
      ),
    );
    this._register(
      this.eventBus.subscribe('turn.step.completed', () => {
        this.subPhase = 'running';
        this.subStream = undefined;
        this.subRetry = undefined;
        this.setPhase(this.running());
        this.publishSnapshot();
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.ended', (e) =>
        this.onTurnEnded(e.turnId, e.reason, e.durationMs),
      ),
    );
    this._register(
      this.eventBus.subscribe('permission.approval.requested', (e) =>
        this.onApprovalRequested(e),
      ),
    );
    this._register(
      this.eventBus.subscribe('permission.approval.resolved', (e) =>
        this.onApprovalResolved(e.toolCallId),
      ),
    );
    this._register(this.wire.subscribe(LaneModel, () => this.publishSnapshot()));
  }

  phase(): AgentPhase {
    return this.wire.getModel(RuntimeModel).phase;
  }

  private onTurnStarted(turnId: number): void {
    this.cursor = { turnId, step: 0, stepId: '' };
    this.priorForApproval = undefined;
    this.subPhase = 'running';
    this.subStream = undefined;
    this.subRetry = undefined;
    this.pendingApprovals.clear();
    this.activeToolCalls.clear();
    this.setPhase(this.running());
    this.publishSnapshot();
  }

  private onStepStarted(turnId: number, step: number, stepId: string): void {
    this.cursor = { turnId, step, stepId };
    this.subPhase = 'running';
    this.subStream = undefined;
    this.subRetry = undefined;
    this.setPhase(this.running());
    this.publishSnapshot();
  }

  private onDelta(stream: 'assistant' | 'thinking'): void {
    this.subPhase = 'streaming';
    this.subStream = stream;
    this.subRetry = undefined;
    this.setPhase({
      kind: 'streaming',
      turnId: this.cursor.turnId,
      step: this.cursor.step,
      stepId: this.cursor.stepId,
      stream,
      since: Date.now(),
    });
    this.publishSnapshot();
  }

  private onToolCallDelta(toolCallId: string, name: string | undefined): void {
    this.subPhase = 'streaming';
    this.subStream = 'tool_call';
    this.subRetry = undefined;
    this.setPhase({
      kind: 'streaming',
      turnId: this.cursor.turnId,
      step: this.cursor.step,
      stepId: this.cursor.stepId,
      stream: 'tool_call',
      toolCallId,
      toolName: name,
      since: Date.now(),
    });
    this.publishSnapshot();
  }

  private onToolCallStarted(toolCallId: string, name: string): void {
    this.subPhase = 'tool_call';
    this.subStream = undefined;
    this.subRetry = undefined;
    this.activeToolCalls.set(toolCallId, { toolCallId, name, since: Date.now() });
    this.setPhase({
      kind: 'tool_call',
      turnId: this.cursor.turnId,
      step: this.cursor.step,
      toolCallId,
      name,
      since: Date.now(),
    });
    this.publishSnapshot();
  }

  private onToolResult(toolCallId: string): void {
    this.activeToolCalls.delete(toolCallId);
    this.subPhase = 'running';
    this.subStream = undefined;
    this.subRetry = undefined;
    this.setPhase(this.running());
    this.publishSnapshot();
  }

  private onTurnEnded(
    turnId: number,
    reason: TurnEndedEvent['reason'],
    durationMs: number | undefined,
  ): void {
    this.setPhase({ kind: 'ended', turnId, reason, durationMs, at: Date.now() });
    this.cursor = { turnId: -1, step: 0, stepId: '' };
    this.priorForApproval = undefined;
    this.subPhase = 'running';
    this.subStream = undefined;
    this.subRetry = undefined;
    this.pendingApprovals.clear();
    this.activeToolCalls.clear();
    this.publishSnapshot();
  }

  private onApprovalRequested(approval: PermissionApprovalRequestContext): void {
    this.priorForApproval = this.current;
    this.pendingApprovals.set(approval.toolCallId, {
      approvalId: approval.toolCallId,
      toolCallId: approval.toolCallId,
      since: Date.now(),
    });
    this.setPhase({
      kind: 'awaiting_approval',
      turnId: approval.turnId,
      step: this.cursor.step || undefined,
      approval,
      since: Date.now(),
    });
    this.publishSnapshot();
  }

  private onApprovalResolved(toolCallId: string): void {
    this.pendingApprovals.delete(toolCallId);
    const resume = this.priorForApproval;
    this.priorForApproval = undefined;
    if (this.pendingApprovals.size > 0) {
      this.setPhase({
        kind: 'awaiting_approval',
        turnId: this.cursor.turnId,
        step: this.cursor.step || undefined,
        approval: undefined,
        since: Date.now(),
      });
    } else if (resume !== undefined && resume.kind !== 'idle' && resume.kind !== 'ended') {
      this.setPhase(resume);
    } else {
      this.setPhase(this.running());
    }
    this.publishSnapshot();
  }

  private running(): AgentPhase {
    return {
      kind: 'running',
      turnId: this.cursor.turnId,
      step: this.cursor.step,
      stepId: this.cursor.stepId,
      since: Date.now(),
    };
  }

  private setPhase(phase: AgentPhase): void {
    if (phaseEqual(this.current, phase)) return;
    this.current = phase;
    this.wire.dispatch(setRuntimePhase({ phase }));
  }

  private publishSnapshot(): void {
    const lane = this.wire.getModel(LaneModel);
    const turn =
      lane.turn === undefined
        ? undefined
        : {
            turnId: lane.turn.turnId,
            origin: lane.turn.origin,
            phase: this.subPhase,
            stream: this.subStream,
            step: this.cursor.step,
            ending: lane.turn.ending,
            endingReason: lane.turn.endingReason,
            retry: this.subRetry,
            pendingApprovals: [...this.pendingApprovals.values()],
            activeToolCalls: [...this.activeToolCalls.values()],
            since: lane.turn.since,
          };
    const snapshot = {
      lane: lane.lane,
      turn,
      lastTurn: lane.lastTurn,
      background: lane.background,
    };
    this.wire.dispatch(
      setActivitySnapshot({ next: snapshot as unknown as AgentActivitySnapshot }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRuntimeService,
  AgentRuntimeService,
  InstantiationType.Delayed,
  'runtime',
);
