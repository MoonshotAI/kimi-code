import { createActor as createXStateActor } from 'xstate';
import type { Actor, ActorOptions, AnyActorLogic, EventFromLogic, InputFrom, SnapshotFrom } from 'xstate';

import { currentUnit, pushCleanup, shallowRef, type Ref, type ShallowRef, type RuntimeEvent } from '#/kernel/index';

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

export function useMachine<TLogic extends AnyActorLogic>(
  factory: () => TLogic,
  options: { key: string; input: InputFrom<TLogic>; enrich?: (event: RuntimeEvent) => RuntimeEvent },
): [Ref<SnapshotFrom<TLogic> | undefined>, (event: EventFromLogic<TLogic>) => void, Actor<TLogic>] {
  const node = currentUnit();
  const snapshotRef: ShallowRef<SnapshotFrom<TLogic> | undefined> = shallowRef(undefined);
  const actor = createActor(factory(), { input: options.input });
  actor.on('*', (event) => {
    const emitted = event as RuntimeEvent;
    node.fire(options.enrich !== undefined ? options.enrich(emitted) : emitted);
  });
  actor.subscribe((snapshot) => {
    snapshotRef.value = snapshot as SnapshotFrom<TLogic>;
  });
  node.postSetup.push(() => {
    actor.start();
    snapshotRef.value = actor.getSnapshot() as SnapshotFrom<TLogic>;
  });
  pushCleanup(node, () => {
    actor.stop();
  });
  return [snapshotRef, (event) => actor.send(event), actor];
}
