/**
 * `turn` domain (L4) — `ITurnEvents` implementation.
 *
 * Owns the turn's event emitters and exposes both the subscribe surfaces and
 * the fire methods, so the Agent-scope lifecycle controller and the per-turn
 * loop / tool executor can drive the same event stream. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  type TurnEndEvent,
  type TurnStartEvent,
  type TurnStepEvent,
  type TurnToolEvent,
  type TurnWillExecuteToolEvent,
  ITurnEvents,
} from './turn';

export class TurnEvents extends Disposable implements ITurnEvents {
  declare readonly _serviceBrand: undefined;

  private readonly _onWillStartTurn = this._register(new Emitter<TurnStartEvent>());
  readonly onWillStartTurn: Event<TurnStartEvent> = this._onWillStartTurn.event;
  private readonly _onWillExecuteTool = this._register(new Emitter<TurnWillExecuteToolEvent>());
  readonly onWillExecuteTool: Event<TurnWillExecuteToolEvent> = this._onWillExecuteTool.event;
  private readonly _onDidFinalizeTool = this._register(new Emitter<TurnToolEvent>());
  readonly onDidFinalizeTool: Event<TurnToolEvent> = this._onDidFinalizeTool.event;
  private readonly _onDidEndStep = this._register(new Emitter<TurnStepEvent>());
  readonly onDidEndStep: Event<TurnStepEvent> = this._onDidEndStep.event;
  private readonly _onDidEndTurn = this._register(new Emitter<TurnEndEvent>());
  readonly onDidEndTurn: Event<TurnEndEvent> = this._onDidEndTurn.event;

  fireWillStartTurn(event: TurnStartEvent): void {
    this._onWillStartTurn.fire(event);
  }
  fireWillExecuteTool(event: TurnWillExecuteToolEvent): void {
    this._onWillExecuteTool.fire(event);
  }
  fireDidFinalizeTool(event: TurnToolEvent): void {
    this._onDidFinalizeTool.fire(event);
  }
  fireDidEndStep(event: TurnStepEvent): void {
    this._onDidEndStep.fire(event);
  }
  fireDidEndTurn(event: TurnEndEvent): void {
    this._onDidEndTurn.fire(event);
  }
}

registerScopedService(LifecycleScope.Agent, ITurnEvents, TurnEvents, InstantiationType.Delayed, 'turn');
