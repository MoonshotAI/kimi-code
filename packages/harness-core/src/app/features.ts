import { shallowReactive } from '@vue/reactivity';

import type { WaitOpts } from '@moonshot-ai/agent-core/utils/wait';

import {
  createUnit,
  type EventHandler,
  type ListenOpts,
  type RuntimeEvent,
  type UnitContext,
  type UnitRecipe,
} from '#/kernel/index';
import { currentUnit } from '#/kernel/runtime';
import type { Agent, Session } from '@moonshot-ai/agent-core/session/index';

import type { App } from './app';

export type FeatureLevel = 'app' | 'session' | 'agent';

export const FEATURE_LEVELS: readonly FeatureLevel[] = ['app', 'session', 'agent'];

export interface FeatureEventMap {
  readonly app?: RuntimeEvent;
  readonly session?: RuntimeEvent;
  readonly agent?: RuntimeEvent;
}

export type FeatureEventsAt<E extends FeatureEventMap, L extends FeatureLevel> =
  E extends { readonly [K in L]?: infer V } ? NonNullable<V> : never;

export type FeatureEvents<E extends FeatureEventMap> = FeatureEventsAt<E, FeatureLevel>;

export interface FeatureLevelContext<F extends RuntimeEvent, H extends RuntimeEvent> extends UnitContext {
  fire(event: F): void;
  on<T extends H['type']>(
    type: T,
    handler: (event: Extract<H, { type: T }>) => void,
    opts?: ListenOpts,
  ): void;
  on(type: '*', handler: (event: H) => void, opts?: ListenOpts): void;
  wait<T extends H['type']>(type: T, opts?: WaitOpts<Extract<H, { type: T }>>): Promise<Extract<H, { type: T }>>;
  wait(type: '*', opts?: WaitOpts<H>): Promise<H>;
}

export type FeatureLevelSetup<P, F extends RuntimeEvent, H extends RuntimeEvent> = (
  props: P,
  ctx: FeatureLevelContext<F, H>,
) => void;

export type FeatureUnits<P, E extends FeatureEventMap = FeatureEventMap> = {
  readonly app?: FeatureLevelSetup<P, FeatureEventsAt<E, 'app'>, FeatureEvents<E>>;
  readonly session?: FeatureLevelSetup<
    P,
    FeatureEventsAt<E, 'session'>,
    FeatureEventsAt<E, 'session' | 'agent'>
  >;
  readonly agent?: FeatureLevelSetup<P, FeatureEventsAt<E, 'agent'>, FeatureEventsAt<E, 'agent'>>;
};

export interface Feature<P = any, E extends FeatureEventMap = FeatureEventMap> {
  readonly name: string;
  readonly units: { readonly [L in FeatureLevel]?: UnitRecipe<P> };
  readonly events?: E;
}

export function createFeature<E extends FeatureEventMap = FeatureEventMap, P extends object | void = void>(
  name: string,
  units: FeatureUnits<P, E>,
): Feature<P, E> {
  const recipes: { [L in FeatureLevel]?: UnitRecipe<P> } = {};
  for (const level of FEATURE_LEVELS) {
    const setup = units[level] as FeatureLevelSetup<P, any, any> | undefined;
    if (setup !== undefined) {
      recipes[level] = createUnit<P>(`${name}:${level}`, (props, ctx) => {
        const node = currentUnit();
        setup(props, {
          ...ctx,
          fire: (event: RuntimeEvent) => {
            node.fire(event);
          },
          on: (type: string, handler: EventHandler, opts?: ListenOpts) => {
            node.own(node.listen(type, handler, opts));
          },
          wait: (type: string, opts?: WaitOpts<RuntimeEvent>) => node.wait(type, opts),
        });
      });
    }
  }
  if (Object.keys(recipes).length === 0) throw new TypeError(`feature '${name}' has no unit`);
  return { name, units: recipes };
}

export type FeatureScope =
  | { readonly session?: undefined; readonly agent?: undefined }
  | { readonly session: string; readonly agent?: string };

export interface Features {
  add<P>(feature: Feature<P>, options?: FeatureScope & { readonly props?: P }): () => Promise<void>;
  delete(feature: Feature | string, scope?: FeatureScope): Promise<void>;
  list(scope?: FeatureScope): readonly Feature[];
}

export interface FeatureEntry {
  readonly feature: Feature;
  readonly props?: unknown;
}

export interface FeatureSet {
  add(entry: FeatureEntry): () => void;
  delete(name: string): void;
  entries(): readonly FeatureEntry[];
}

const sets = new WeakMap<object, FeatureSet>();

function createFeatureSet(): FeatureSet {
  const entries = shallowReactive(new Map<string, FeatureEntry>());
  return {
    add: (entry) => {
      const name = entry.feature.name;
      entries.set(name, entry);
      return () => {
        if (entries.get(name) === entry) entries.delete(name);
      };
    },
    delete: (name) => {
      entries.delete(name);
    },
    entries: () => [...entries.values()],
  };
}

export function featureSetOf(target: App | Session | Agent): FeatureSet {
  let set = sets.get(target);
  if (set === undefined) {
    set = createFeatureSet();
    sets.set(target, set);
  }
  return set;
}
