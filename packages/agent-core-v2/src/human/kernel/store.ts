import { toValue, watch } from '@vue/reactivity';

import type { Token } from './primitives';
import {
  pushCleanup,
  type FaceEventMeta,
  type UnitNode,
  type UnitRecipe,
  type UnitSetup,
  type Unsubscribe,
} from './runtime';

export interface StoreHandle<S> {
  readonly name: string;
  getState(): S;
  select<R>(selector: (state: S) => R): R;
  subscribe(listener: (state: S) => void): Unsubscribe;
}

export type StoreResolution<S> = StoreHandle<S> & S;

export interface StoreStateEvent {
  readonly type: 'store.state';
  readonly store: string;
  readonly state: Record<string, unknown>;
}

export interface StoreRecipe<S = any> extends Omit<UnitRecipe<void>, 'setup'> {
  readonly key: string;
  readonly type?: StoreResolution<S>;
  readonly store: true;
  readonly storeName: string;
  readonly faceEvent: FaceEventMeta;
  readonly onMount: (recipe: UnitRecipe<any>, node: UnitNode) => void;
  readonly setup: UnitSetup<void>;
}

export function createStore<S extends object>(name: string, setup: () => S): StoreRecipe<S> {
  const recipe: StoreRecipe<S> = {
    name: `store:${name}`,
    key: `store:${name}`,
    store: true,
    storeName: name,
    faceEvent: { type: 'store.state', payloadKey: 'store', name },
    onMount: (_recipe, node) => {
      bindFaceWatchers(name, node);
      const parent = node.parent;
      if (parent === null) {
        return;
      }
      const handle = buildStoreHandle(name, node);
      const withdraw = parent.provide(recipe as unknown as Token<unknown>, handle);
      pushCleanup(node, withdraw);
    },
    setup: setup as UnitSetup<void>,
  };
  return recipe;
}

export function isStoreRecipe(recipe: unknown): recipe is StoreRecipe<any> {
  return (recipe as { store?: boolean }).store === true;
}

export function buildStoreHandle(
  name: string,
  node: UnitNode,
): StoreResolution<any> {
  const latestFace = (): Record<string, unknown> => {
    const face = node.setupResult;
    if (face === null || typeof face !== 'object') {
      throw new Error(`store '${name}' has no face yet`);
    }
    return face as Record<string, unknown>;
  };
  const handle: Record<string, unknown> = {
    name,
    getState: () => latestFace(),
    select: (selector: (state: never) => unknown) => selector(latestFace() as never),
    subscribe: (listener: (state: never) => void) => {
      let watchers = node.faceWatchers;
      if (watchers === undefined) {
        watchers = new Set();
        node.faceWatchers = watchers;
      }
      const typed = listener as (face: unknown) => void;
      watchers.add(typed);
      return () => watchers.delete(typed);
    },
  };
  const face = latestFace();
  for (const [key, value] of Object.entries(face)) {
    if (typeof value === 'function') {
      handle[key] = (...args: unknown[]) => {
        const fn = latestFace()[key];
        if (typeof fn !== 'function') {
          throw new Error(`'${key}' is no longer an action of '${name}'`);
        }
        return (fn as (...args: unknown[]) => unknown)(...args);
      };
    } else {
      Object.defineProperty(handle, key, {
        get: () => latestFace()[key],
        enumerable: true,
      });
    }
  }
  return handle as StoreResolution<any>;
}

function bindFaceWatchers(name: string, node: UnitNode): void {
  const face = node.setupResult;
  if (face === null || typeof face !== 'object') {
    return;
  }
  const record = face as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => typeof record[key] !== 'function');
  node.scope.run(() => {
    for (const key of keys) {
      watch(
        () => toValue(record[key]),
        () => {
          node.fire({
            type: 'store.state',
            store: name,
            state: nonFunctionFields(record),
          });
          if (node.faceWatchers !== undefined) {
            for (const listener of Array.from(node.faceWatchers)) {
              listener(face);
            }
          }
        },
      );
    }
  });
}

function nonFunctionFields(face: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(face)) {
    if (typeof value !== 'function') {
      out[key] = toValue(value);
    }
  }
  return out;
}
