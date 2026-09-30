import { createActor, type ActorRefFrom } from '#/xstate2';

import type { LlmModel } from '#/llm/model';
import type { Plugin } from '#/plugin';

import { createUsageMachine } from './machine';

export type UsageActor = ActorRefFrom<ReturnType<typeof createUsageMachine>>;

export interface UsagePlugin extends Plugin {
  readonly name: 'usage';
  readonly actor: UsageActor;
}

export function createUsagePlugin(input?: { model?: LlmModel }): UsagePlugin {
  const actor = createActor(createUsageMachine());
  actor.start();
  let currentTurnId: number | undefined;
  return {
    name: 'usage',
    actor,
    connect(target) {
      if (target.kind !== 'agent') return;
      target.on('turn.started', (event) => {
        if (event.type === 'turn.started') {
          currentTurnId = event.turnId;
        }
      });
      target.on('llm.streaming.usage', (event) => {
        if (event.type === 'llm.streaming.usage') {
          actor.send({
            type: 'usage.record',
            record: {
              usage: event.usage,
              model: input?.model,
              turnId: currentTurnId,
              at: Date.now(),
            },
          });
        }
      });
    },
  };
}
