import type { MaybeRefOrGetter } from '@vue/reactivity';

import {
  createToken,
  createUnit,
  type EventHandler,
  type NodeRef,
  type RuntimeEvent,
  type UnitRecipe,
  type UnitSetup,
  type Unsubscribe,
} from '#/kernel/index';

export type FeatureTier = 'app' | 'session' | 'agent';

export interface FeatureSlots {
  readonly app?: UnitSetup<void>;
  readonly session?: UnitSetup<void>;
  readonly agent?: UnitSetup<void>;
}

export interface FeatureSpec<E extends RuntimeEvent = RuntimeEvent> {
  readonly featureName: string;
  readonly slots: {
    readonly [K in FeatureTier]?: UnitRecipe;
  };
  readonly events?: E;
}

export type EventsOf<F> = F extends FeatureSpec<infer E> ? E : never;

export type ListenOpts = { once?: boolean; capture?: boolean };

export interface FeatureHandleOn {
  on<E extends RuntimeEvent, T extends E['type']>(
    feature: FeatureSpec<E>,
    type: T,
    handler: EventHandler<Extract<E, { type: T }>>,
    opts?: ListenOpts,
  ): Unsubscribe;
  on<E extends RuntimeEvent>(
    feature: FeatureSpec<E>,
    type: '*',
    handler: EventHandler<E>,
    opts?: ListenOpts,
  ): Unsubscribe;
  on(type: string, handler: EventHandler, opts?: ListenOpts): Unsubscribe;
}

export function createFeature<E extends RuntimeEvent = RuntimeEvent>(
  name: string,
  slots: FeatureSlots,
): FeatureSpec<E> {
  return {
    featureName: name,
    slots: {
      app: wrapSlot(name, 'app', slots.app),
      session: wrapSlot(name, 'session', slots.session),
      agent: wrapSlot(name, 'agent', slots.agent),
    },
  };
}

export function bindHandleOn(node: NodeRef): FeatureHandleOn['on'] {
  return ((
    featureOrType: FeatureSpec | string,
    typeOrHandler?: string | EventHandler,
    handlerOrOpts?: EventHandler | ListenOpts,
    opts?: ListenOpts,
  ) => listenOn(node, featureOrType, typeOrHandler, handlerOrOpts, opts)) as FeatureHandleOn['on'];
}

function listenOn(
  node: NodeRef,
  featureOrType: FeatureSpec | string,
  typeOrHandler?: string | EventHandler,
  handlerOrOpts?: EventHandler | ListenOpts,
  opts?: ListenOpts,
): Unsubscribe {
  if (typeof featureOrType === 'string') {
    return node.on(featureOrType, typeOrHandler as EventHandler, handlerOrOpts as ListenOpts);
  }
  const type = typeOrHandler as string;
  const handler = handlerOrOpts as EventHandler;
  if (type !== '*') {
    return node.on(type, handler, opts);
  }
  const prefix = `${featureOrType.featureName}.`;
  let off: Unsubscribe = () => {};
  off = node.on(
    '*',
    (event) => {
      if (!event.type.startsWith(prefix)) {
        return;
      }
      if (opts?.once) {
        off();
      }
      handler(event);
    },
    { capture: opts?.capture },
  );
  return off;
}

function wrapSlot(
  featureName: string,
  tier: FeatureTier,
  setup: UnitSetup<void> | undefined,
): UnitRecipe | undefined {
  if (setup === undefined) {
    return undefined;
  }
  return createUnit(`${featureName}:${tier}`, setup);
}

export const Features = createToken<MaybeRefOrGetter<readonly FeatureSpec[]>>('Features');
