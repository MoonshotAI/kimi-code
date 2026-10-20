import { shallowReactive } from '@vue/reactivity';

import { createUnit, type RuntimeEvent, type UnitRecipe, type UnitSetup } from '#/kernel/index';
import type { Agent, Session } from '#/session/index';

import type { App } from './app';

export type FeatureLevel = 'app' | 'session' | 'agent';

export const FEATURE_LEVELS: readonly FeatureLevel[] = ['app', 'session', 'agent'];

export type FeatureUnits<P> = { readonly [L in FeatureLevel]?: UnitSetup<P> };

export interface Feature<P = any, E extends RuntimeEvent = RuntimeEvent> {
  readonly name: string;
  readonly units: { readonly [L in FeatureLevel]?: UnitRecipe<P> };
  readonly events?: E;
}

export function createFeature<E extends RuntimeEvent = RuntimeEvent, P extends object | void = void>(
  name: string,
  units: FeatureUnits<P>,
): Feature<P, E> {
  const recipes: { [L in FeatureLevel]?: UnitRecipe<P> } = {};
  for (const level of FEATURE_LEVELS) {
    const setup = units[level];
    if (setup !== undefined) recipes[level] = createUnit<P>(`${name}:${level}`, setup);
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
