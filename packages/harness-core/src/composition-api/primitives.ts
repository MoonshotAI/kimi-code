import { watch } from '@vue/reactivity';
import type { WatchEffect, WatchHandle, WatchOptions } from '@vue/reactivity';

export {
  computed,
  effectScope,
  isRef,
  reactive,
  ref,
  shallowRef,
  toValue,
  unref,
  watch,
} from '@vue/reactivity';
export type { ComputedRef, EffectScope, Ref, ShallowRef } from '@vue/reactivity';

export function watchEffect(effect: WatchEffect, options?: WatchOptions): WatchHandle {
  return watch(effect, null, options);
}

export interface Token<T> {
  readonly key?: string;
  readonly type?: T;
  readonly kind: 'certain' | 'facade';
}

export interface CertainToken<T> extends Token<T> {
  readonly kind: 'certain';
}

export interface FacadeToken<T> extends Token<T> {
  readonly kind: 'facade';
}

export interface CollectionToken<T> {
  readonly key?: string;
  readonly type?: T;
}

export function createToken<T>(key?: string): CertainToken<T> {
  return { key, kind: 'certain' };
}

export function createFacadeToken<T>(key?: string): FacadeToken<T> {
  return { key, kind: 'facade' };
}

export function createCollection<T>(key?: string): CollectionToken<T> {
  return { key };
}
