import type { MaybeRefOrGetter } from '@vue/reactivity';

import {
  createToken,
  createUnit,
  currentUnit,
  pushCleanup,
  type CertainToken,
  type EventHandler,
  type NodeRef,
  type RuntimeEvent,
  type UnitNode,
  type UnitRecipe,
  type UnitSetup,
  type Unsubscribe,
  type WaitOpts,
} from '#/kernel/index';
import { inject } from '#/kernel/hooks';

import { AgentNodeRef, AppNodeRef, SessionNodeRef } from './tierNodes';

export type { WaitOpts };

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
  wait<E extends RuntimeEvent, T extends E['type']>(
    feature: FeatureSpec<E>,
    type: T,
    opts?: WaitOpts<Extract<E, { type: T }>>,
  ): Promise<Extract<E, { type: T }>>;
  wait<E extends RuntimeEvent>(
    feature: FeatureSpec<E>,
    type: '*',
    opts?: WaitOpts<E>,
  ): Promise<E>;
  wait(type: string, opts?: WaitOpts): Promise<RuntimeEvent>;
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

export function bindHandleOn(node: NodeRef): Pick<FeatureHandleOn, 'on' | 'wait'> {
  return {
    on: ((
      featureOrType: FeatureSpec | string,
      typeOrHandler?: string | EventHandler,
      handlerOrOpts?: EventHandler | ListenOpts,
      opts?: ListenOpts,
    ) => listenOn(node, featureOrType, typeOrHandler, handlerOrOpts, opts)) as FeatureHandleOn['on'],
    wait: ((
      featureOrType: FeatureSpec | string,
      typeOrOpts?: string | WaitOpts,
      opts?: WaitOpts,
    ) => waitOn(node, featureOrType, typeOrOpts, opts)) as FeatureHandleOn['wait'],
  };
}

export function useOnApp<E extends RuntimeEvent, T extends E['type']>(
  feature: FeatureSpec<E>,
  type: T,
  handler: EventHandler<Extract<E, { type: T }>>,
  opts?: ListenOpts,
): void;
export function useOnApp<E extends RuntimeEvent>(
  feature: FeatureSpec<E>,
  type: '*',
  handler: EventHandler<E>,
  opts?: ListenOpts,
): void;
export function useOnApp(type: string, handler: EventHandler, opts?: ListenOpts): void;
export function useOnApp(
  featureOrType: FeatureSpec | string,
  typeOrHandler?: string | EventHandler,
  handlerOrOpts?: EventHandler | ListenOpts,
  opts?: ListenOpts,
): void {
  useTierOn(AppNodeRef, featureOrType, typeOrHandler, handlerOrOpts, opts);
}

export function useOnSession<E extends RuntimeEvent, T extends E['type']>(
  feature: FeatureSpec<E>,
  type: T,
  handler: EventHandler<Extract<E, { type: T }>>,
  opts?: ListenOpts,
): void;
export function useOnSession<E extends RuntimeEvent>(
  feature: FeatureSpec<E>,
  type: '*',
  handler: EventHandler<E>,
  opts?: ListenOpts,
): void;
export function useOnSession(type: string, handler: EventHandler, opts?: ListenOpts): void;
export function useOnSession(
  featureOrType: FeatureSpec | string,
  typeOrHandler?: string | EventHandler,
  handlerOrOpts?: EventHandler | ListenOpts,
  opts?: ListenOpts,
): void {
  useTierOn(SessionNodeRef, featureOrType, typeOrHandler, handlerOrOpts, opts);
}

export function useOnAgent<E extends RuntimeEvent, T extends E['type']>(
  feature: FeatureSpec<E>,
  type: T,
  handler: EventHandler<Extract<E, { type: T }>>,
  opts?: ListenOpts,
): void;
export function useOnAgent<E extends RuntimeEvent>(
  feature: FeatureSpec<E>,
  type: '*',
  handler: EventHandler<E>,
  opts?: ListenOpts,
): void;
export function useOnAgent(type: string, handler: EventHandler, opts?: ListenOpts): void;
export function useOnAgent(
  featureOrType: FeatureSpec | string,
  typeOrHandler?: string | EventHandler,
  handlerOrOpts?: EventHandler | ListenOpts,
  opts?: ListenOpts,
): void {
  useTierOn(AgentNodeRef, featureOrType, typeOrHandler, handlerOrOpts, opts);
}

function useTierOn(
  token: CertainToken<UnitNode>,
  featureOrType: FeatureSpec | string,
  typeOrHandler?: string | EventHandler,
  handlerOrOpts?: EventHandler | ListenOpts,
  opts?: ListenOpts,
): void {
  const node = currentUnit();
  pushCleanup(node, listenOn(inject(token), featureOrType, typeOrHandler, handlerOrOpts, opts));
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

function waitOn(
  node: NodeRef,
  featureOrType: FeatureSpec | string,
  typeOrOpts?: string | WaitOpts,
  opts?: WaitOpts,
): Promise<RuntimeEvent> {
  if (typeof featureOrType === 'string') {
    return node.wait(featureOrType, typeOrOpts as WaitOpts | undefined);
  }
  const type = typeOrOpts as string;
  if (type !== '*') {
    return node.wait(type, opts);
  }
  const prefix = `${featureOrType.featureName}.`;
  return node.wait('*', {
    capture: opts?.capture,
    signal: opts?.signal,
    match: (event) => {
      if (!event.type.startsWith(prefix)) {
        return false;
      }
      return opts?.match?.(event) ?? true;
    },
  });
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
