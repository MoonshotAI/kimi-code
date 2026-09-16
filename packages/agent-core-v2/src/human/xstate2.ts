import { createActor as createXStateActor } from 'xstate';
import type { Actor, ActorOptions, AnyActorLogic } from 'xstate';

import { isAbortError } from '#/llm/errors';
import { xstateInspectionCollector } from '#/xstateInspection';

export * from 'xstate';

export type RootActorErrorReporter = (err: unknown) => void;

let reportRootActorError: RootActorErrorReporter = () => {};

export function setRootActorErrorReporter(reporter: RootActorErrorReporter): void {
  reportRootActorError = reporter;
}

function createActorWithInspect<TLogic extends AnyActorLogic>(
  logic: TLogic,
  options?: ActorOptions<TLogic>,
): Actor<TLogic> {
  const inspect = options?.inspect;
  const actor = createXStateActor(logic, {
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
  swallowRootAbortError(actor);
  return actor;
}

function swallowRootAbortError(actor: Actor<AnyActorLogic>): void {
  const internal = actor as unknown as { _reportError(err: unknown): void };
  const reportError = internal._reportError.bind(actor);
  internal._reportError = (err: unknown) => {
    if (isAbortError(err)) {
      reportRootActorError(err);
      return;
    }
    reportError(err);
  };
}

export const createActor = createActorWithInspect as typeof createXStateActor;
