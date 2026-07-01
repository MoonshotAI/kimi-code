/**
 * `turn` domain (L4) — `ITurnService` implementation.
 *
 * Drives the turn lifecycle and emits its events; runs the turn loop through
 * `loopRunner`, drives agent lifecycle through `agent-lifecycle`, reads
 * history through `context`, enqueues follow-up through `injection`, drives
 * LLM generation through `kosong`, logs through `log`, checks permissions
 * through `permission`, reports telemetry through `telemetry`, executes tools
 * through `tool`, and checks usage through `usage`. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IContextService } from '#/context/context';
import { IInjectionService } from '#/injection/injection';
import { ILLMService } from '#/kosong/kosong';
import { ILogService } from '#/log/log';
import { IPermissionService } from '#/permission/permission';
import { ITelemetryService } from '#/telemetry/telemetry';
import { IToolService } from '#/tool/tool';
import { IUsageService } from '#/usage/usage';

import {
  type TurnEndEvent,
  type TurnStartEvent,
  type TurnStepEvent,
  type TurnToolEvent,
  ILoopRunner,
  ITurnService,
} from './turn';

let nextTurnId = 0;

export class TurnService extends Disposable implements ITurnService {
  declare readonly _serviceBrand: undefined;

  private readonly _onWillStartTurn = this._register(new Emitter<TurnStartEvent>());
  readonly onWillStartTurn: Event<TurnStartEvent> = this._onWillStartTurn.event;
  private readonly _onWillExecuteTool = this._register(new Emitter<TurnToolEvent>());
  readonly onWillExecuteTool: Event<TurnToolEvent> = this._onWillExecuteTool.event;
  private readonly _onDidFinalizeTool = this._register(new Emitter<TurnToolEvent>());
  readonly onDidFinalizeTool: Event<TurnToolEvent> = this._onDidFinalizeTool.event;
  private readonly _onDidEndStep = this._register(new Emitter<TurnStepEvent>());
  readonly onDidEndStep: Event<TurnStepEvent> = this._onDidEndStep.event;
  private readonly _onDidEndTurn = this._register(new Emitter<TurnEndEvent>());
  readonly onDidEndTurn: Event<TurnEndEvent> = this._onDidEndTurn.event;

  private active: { readonly turnId: string; cancelled: boolean } | undefined;
  private readonly steerBuffer: { content: string; origin?: string }[] = [];

  constructor(
    @IContextService _context: IContextService,
    @IToolService _tool: IToolService,
    @IPermissionService _permission: IPermissionService,
    @ILLMService _llm: ILLMService,
    @IInjectionService _injection: IInjectionService,
    @IUsageService _usage: IUsageService,
    @ITelemetryService _telemetry: ITelemetryService,
    @ILogService _log: ILogService,
    @IAgentLifecycleService _agentLifecycle: IAgentLifecycleService,
    @ILoopRunner private readonly loopRunner: ILoopRunner,
  ) {
    super();
  }

  get hasActiveTurn(): boolean {
    return this.active !== undefined;
  }
  get currentId(): string | undefined {
    return this.active?.turnId;
  }

  async prompt(input: string): Promise<void> {
    if (this.active !== undefined) {
      this.steer(input);
      return;
    }
    await this.launch(input);
  }

  steer(content: string, origin?: string): void {
    this.steerBuffer.push({ content, origin });
  }

  retry(): Promise<void> {
    throw new Error('TODO: TurnService.retry');
  }

  cancel(reason?: string): void {
    if (this.active === undefined) return;
    this.active.cancelled = true;
    const turnId = this.active.turnId;
    this.active = undefined;
    this._onDidEndTurn.fire({ turnId, reason: reason ?? 'cancelled' });
  }

  private async launch(input: string): Promise<void> {
    const turnId = `turn-${nextTurnId++}`;
    this.active = { turnId, cancelled: false };
    this._onWillStartTurn.fire({ turnId });
    try {
      await this.loopRunner.run();
      this._onDidEndStep.fire({ turnId, step: 0 });
    } finally {
      if (this.active?.turnId === turnId) {
        this.active = undefined;
        this._onDidEndTurn.fire({ turnId, reason: 'completed' });
      }
    }
    void input;
  }
}

registerScopedService(LifecycleScope.Agent, ITurnService, TurnService, InstantiationType.Delayed, 'turn');
