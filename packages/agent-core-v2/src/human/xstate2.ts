import { createActor as createXStateActor } from 'xstate';
import type { Actor, ActorOptions, AnyActorLogic } from 'xstate';

import { xstateInspectionCollector } from '#/xstateInspection';

export * from 'xstate';

function createActorWithInspect<TLogic extends AnyActorLogic>(
  logic: TLogic,
  options?: ActorOptions<TLogic>,
): Actor<TLogic> {
  const inspect = options?.inspect;
  return createXStateActor(logic, {
    ...options,
    inspect: (event) => {
      xstateInspectionCollector.publish(event);
      if (typeof inspect === 'function') {
        inspect(event);
      } else {
        inspect?.next?.(event);
      }
    },
  });
}

export const createActor = createActorWithInspect as typeof createXStateActor;
