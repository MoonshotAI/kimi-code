/**
 * `turn` domain (L4) — `ITurnService` implementation.
 *
 * Drives the turn lifecycle and emits its events through the turn event
 * dispatcher; runs the turn loop through `loopRunner`, drives agent lifecycle
 * through `agent-lifecycle`, reads history through `context`, enqueues
 * follow-up through `injection`, drives LLM generation through `kosong`, logs
 * through `log`, reports telemetry through `telemetry`, and checks usage
 * through `usage`. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IContextService } from '#/context/context';
import { IInjectionService } from '#/injection/injection';
import { ILLMService } from '#/kosong/kosong';
import { ILogService } from '#/log/log';
import { ITelemetryService } from '#/telemetry/telemetry';
import { IUsageService } from '#/usage/usage';

import {
  type TurnEndEvent,
  type TurnStartEvent,
  type TurnStepEvent,
  type TurnToolEvent,
  type TurnWillExecuteToolEvent,
  ILoopRunner,
  ITurnEvents,
  ITurnService,
} from './turn';

let nextTurnId = 0;

export class TurnService extends Disposable implements ITurnService {
  declare readonly _serviceBrand: undefined;

  readonly onWillStartTurn: Event<TurnStartEvent>;
  readonly onWillExecuteTool: Event<TurnWillExecuteToolEvent>;
  readonly onDidFinalizeTool: Event<TurnToolEvent>;
  readonly onDidEndStep: Event<TurnStepEvent>;
  readonly onDidEndTurn: Event<TurnEndEvent>;

  private active: { readonly turnId: string; cancelled: boolean } | undefined;
  private readonly steerBuffer: { content: string; origin?: string }[] = [];

  constructor(
    @IContextService _context: IContextService,
    @ILLMService _llm: ILLMService,
    @IInjectionService _injection: IInjectionService,
    @IUsageService _usage: IUsageService,
    @ITelemetryService _telemetry: ITelemetryService,
    @ILogService _log: ILogService,
    @IAgentLifecycleService _agentLifecycle: IAgentLifecycleService,
    @ILoopRunner private readonly loopRunner: ILoopRunner,
    @ITurnEvents private readonly turnEvents: ITurnEvents,
  ) {
    super();

    this.onWillStartTurn = this.turnEvents.onWillStartTurn;
    this.onWillExecuteTool = this.turnEvents.onWillExecuteTool;
    this.onDidFinalizeTool = this.turnEvents.onDidFinalizeTool;
    this.onDidEndStep = this.turnEvents.onDidEndStep;
    this.onDidEndTurn = this.turnEvents.onDidEndTurn;
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
    this.turnEvents.fireDidEndTurn({ turnId, reason: reason ?? 'cancelled' });
  }

  private async launch(input: string): Promise<void> {
    const turnId = `turn-${nextTurnId++}`;
    this.active = { turnId, cancelled: false };
    this.turnEvents.fireWillStartTurn({ turnId });
    try {
      await this.loopRunner.run();
      this.turnEvents.fireDidEndStep({ turnId, step: 0 });
    } finally {
      if (this.active?.turnId === turnId) {
        this.active = undefined;
        this.turnEvents.fireDidEndTurn({ turnId, reason: 'completed' });
      }
    }
    void input;
  }
}

registerScopedService(LifecycleScope.Agent, ITurnService, TurnService, InstantiationType.Delayed, 'turn');
