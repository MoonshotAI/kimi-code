import { shallowRef } from '@vue/reactivity';

import { createToken, type UnitRecipe } from '#/kernel/index';
import type { StoreRecipe } from '#/store/index';

export type SlotRecipe = UnitRecipe<any> | StoreRecipe<any>;

export interface FeatureSlots {
  readonly app?: SlotRecipe | readonly SlotRecipe[];
  readonly session?: SlotRecipe | readonly SlotRecipe[];
  readonly agent?: SlotRecipe | readonly SlotRecipe[];
}

export interface FeatureSpec<P = unknown, S extends object = any> {
  readonly featureName: string;
  readonly slots: FeatureSlots;
  readonly handle?: StoreRecipe<S>;
  readonly props: P;
}

export type FeatureFactory<P = unknown, S extends object = any> = (props?: P) => FeatureSpec<P, S>;

export function createFeature<P = void, S extends object = object>(
  name: string,
  slots: FeatureSlots,
  opts?: { handle?: StoreRecipe<S> },
): FeatureFactory<P, S> {
  return (props?: P) => ({ featureName: name, slots, handle: opts?.handle, props: props as P });
}

export const Features = createToken<readonly FeatureSpec<any>[]>('Features');

export const featureSpecs = shallowRef<readonly FeatureSpec<any>[]>([]);
