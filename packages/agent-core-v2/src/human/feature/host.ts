import type { UnitHandle } from '#/kernel/index';
import type { StoreResolution } from '#/store/index';

import type { FeatureSpec } from './feature';

export interface FeatureHost extends UnitHandle {
  get<P, S extends object>(feature: FeatureSpec<P, S>): StoreResolution<S>;
  disposeAsync(): Promise<void>;
}

export function featureHost(handle: UnitHandle): FeatureHost {
  return {
    get name() { return handle.name; },
    get state() { return handle.state; },
    node: handle.node,
    update: (props) => handle.update(props),
    ready: () => handle.ready(),
    unmount: () => handle.unmount(),
    disposeAsync: () => handle.unmount(),
    get: (feature) => {
      if (handle.state === 'unmounted') {
        throw new Error(`feature host '${handle.name}' is unmounted`);
      }
      if (feature.handle === undefined) {
        throw new Error(`feature '${feature.featureName}' has no store handle`);
      }
      return handle.node.resolve(feature.handle);
    },
  };
}
