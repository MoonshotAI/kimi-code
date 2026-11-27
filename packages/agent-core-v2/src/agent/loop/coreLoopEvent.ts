/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { LoopEmitted, TurnOutcome } from '@moonshot-ai/core/loop/index';

import type { IDisposable } from '#/_base/di/lifecycle';
import { AgentEvent2 } from '#/app/event/event2';
import type { IEventBus } from '#/app/event/eventBus';

import type { TurnEndReason } from './turnEvents';

export interface CoreLoopEventPayload {
  readonly agentId: string;
  readonly event: LoopEmitted;
}

export class CoreLoopEvent extends AgentEvent2<CoreLoopEventPayload> {
  static override readonly type = 'core.loop.event';
  static override readonly durable = false;
  static override readonly observable = true;
}
export interface CoreLoopEvent extends CoreLoopEventPayload {}

export function onCoreLoopEvent<T extends LoopEmitted['type']>(
  bus: IEventBus,
  type: T,
  handler: (event: Extract<LoopEmitted, { type: T }>, envelope: CoreLoopEvent) => void,
): IDisposable {
  return bus.subscribe(CoreLoopEvent, (envelope) => {
    if (envelope.event.type !== type) return;
    handler(envelope.event as Extract<LoopEmitted, { type: T }>, envelope);
  });
}

export function turnOutcomeReason(outcome: TurnOutcome): TurnEndReason {
  switch (outcome.type) {
    case 'done':
      return 'completed';
    case 'aborted':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
  }
}
