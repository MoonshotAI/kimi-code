import { onScopeDispose } from '@vue/reactivity';

import type { CollectionView } from '../di/collection';
import type { LiveRef } from '../di/instantiation';
import { shallowRef, type ShallowRef } from './primitives';

export function useLiveRef<T>(live: LiveRef<T>): Readonly<ShallowRef<T | undefined>> {
  const value = shallowRef(live.current);
  const subscription = live.onDidChange(() => {
    value.value = live.current;
  });
  onScopeDispose(() => {
    subscription.dispose();
  });
  return value;
}

export function useCollectionView<T>(view: CollectionView<T>): Readonly<ShallowRef<readonly T[]>> {
  const value = shallowRef(view.items);
  const subscription = view.onDidChange(() => {
    value.value = view.items;
  });
  onScopeDispose(() => {
    subscription.dispose();
  });
  return value;
}
