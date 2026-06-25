/**
 * `turn` domain (L4) — drives the turn lifecycle.
 *
 * Defines the public contract of a turn: the `ITurnService` used by upper layers
 * to start, steer, retry, and cancel a turn and to observe its events, the
 * per-turn `ITurnContext`, and the `ILoopRunner` that runs the turn loop.
 * `ITurnService` is Agent-scoped; `ILoopRunner` is Turn-scoped.
 */

import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface TurnStartEvent {
  readonly turnId: string;
}
export interface TurnToolEvent {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}
export interface TurnStepEvent {
  readonly turnId: string;
  readonly step: number;
}
export interface TurnEndEvent {
  readonly turnId: string;
  readonly reason: string;
}

export interface ITurnService {
  readonly _serviceBrand: undefined;
  readonly onWillStartTurn: Event<TurnStartEvent>;
  readonly onWillExecuteTool: Event<TurnToolEvent>;
  readonly onDidFinalizeTool: Event<TurnToolEvent>;
  readonly onDidEndStep: Event<TurnStepEvent>;
  readonly onDidEndTurn: Event<TurnEndEvent>;
  readonly hasActiveTurn: boolean;
  readonly currentId: string | undefined;
  prompt(input: string): Promise<void>;
  steer(content: string, origin?: string): void;
  retry(): Promise<void>;
  cancel(reason?: string): void;
}

export const ITurnService: ServiceIdentifier<ITurnService> =
  createDecorator<ITurnService>('turnService');

export interface ITurnContext {
  readonly turnId: string;
}

export const ITurnContext: ServiceIdentifier<ITurnContext> =
  createDecorator<ITurnContext>('turnContext');

export interface ILoopRunner {
  readonly _serviceBrand: undefined;
  run(): Promise<void>;
}

export const ILoopRunner: ServiceIdentifier<ILoopRunner> =
  createDecorator<ILoopRunner>('loopRunner');
