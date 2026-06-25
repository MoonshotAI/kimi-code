/**
 * `turn` domain (L4) — drives the turn lifecycle.
 *
 * Defines the public contract of a turn: the `ITurnService` used by upper layers
 * to start, steer, retry, and cancel a turn and to observe its events, the
 * `ITurnEvents` dispatcher that owns the turn's event emitters (subscribed to at
 * Agent scope, fired from both the Agent-scope controller and the per-turn
 * loop), the `IToolCallExecutor` that runs a single tool call through its
 * veto/permission gate, the per-turn `ITurnContext`, and the `ILoopRunner` that
 * runs the turn loop. `ITurnService` / `ITurnEvents` are Agent-scoped;
 * `IToolCallExecutor` / `ILoopRunner` / `ITurnContext` are Turn-scoped.
 */

import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ToolCallResult } from '#/tool/tool';

export interface TurnStartEvent {
  readonly turnId: string;
}
export interface TurnWillExecuteToolEvent {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  veto(value: boolean | Promise<boolean>, id?: string): void;
}
export interface TurnToolEvent {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}
export type ToolCallOutcome =
  | { readonly vetoed: true; readonly reason: string }
  | { readonly vetoed: false; readonly result: ToolCallResult };
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
  readonly onWillExecuteTool: Event<TurnWillExecuteToolEvent>;
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

export interface ITurnEvents {
  readonly _serviceBrand: undefined;
  readonly onWillStartTurn: Event<TurnStartEvent>;
  readonly onWillExecuteTool: Event<TurnWillExecuteToolEvent>;
  readonly onDidFinalizeTool: Event<TurnToolEvent>;
  readonly onDidEndStep: Event<TurnStepEvent>;
  readonly onDidEndTurn: Event<TurnEndEvent>;
  fireWillStartTurn(event: TurnStartEvent): void;
  fireWillExecuteTool(event: TurnWillExecuteToolEvent): void;
  fireDidFinalizeTool(event: TurnToolEvent): void;
  fireDidEndStep(event: TurnStepEvent): void;
  fireDidEndTurn(event: TurnEndEvent): void;
}

export const ITurnEvents: ServiceIdentifier<ITurnEvents> =
  createDecorator<ITurnEvents>('turnEvents');

export interface IToolCallExecutor {
  readonly _serviceBrand: undefined;
  execute(toolCallId: string, toolName: string, args: unknown): Promise<ToolCallOutcome>;
}

export const IToolCallExecutor: ServiceIdentifier<IToolCallExecutor> =
  createDecorator<IToolCallExecutor>('toolCallExecutor');

export interface ITurnContext {
  readonly _serviceBrand: undefined;
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
