import { createActor as createXStateActor } from 'xstate';
import type { Actor, ActorOptions, AnyActorLogic, InspectionEvent } from 'xstate';

export * from 'xstate';

function reportUnhandled(event: InspectionEvent): void {
  if (event.type !== '@xstate.microstep' || event._transitions.length > 0) {
    return;
  }
  if (event.event.type.startsWith('xstate.')) {
    return;
  }
  console.warn(
    `[agent-core-v3] unhandled event "${event.event.type}" in actor "${event.actorRef.sessionId}"`,
  );
}

function createActorWithInspect<TLogic extends AnyActorLogic>(
  logic: TLogic,
  options?: ActorOptions<TLogic>,
): Actor<TLogic> {
  const inspect = options?.inspect;
  return createXStateActor(logic, {
    ...options,
    inspect: (event) => {
      reportUnhandled(event);
      if (typeof inspect === 'function') {
        inspect(event);
      } else {
        inspect?.next?.(event);
      }
    },
  });
}

export const createActor = createActorWithInspect as typeof createXStateActor;
