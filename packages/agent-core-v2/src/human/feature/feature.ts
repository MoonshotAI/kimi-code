import { shallowRef } from '@vue/reactivity';

import { createToken, type StoreRecipe, type UnitRecipe } from '#/kernel/index';

export type SlotRecipe = UnitRecipe<any> | StoreRecipe<any>;

export interface FeatureSlots {
  readonly app?: SlotRecipe | readonly SlotRecipe[];
  readonly session?: SlotRecipe | readonly SlotRecipe[];
  readonly agent?: SlotRecipe | readonly SlotRecipe[];
}

export interface FeatureSpec<P = unknown> {
  readonly featureName: string;
  readonly slots: FeatureSlots;
  readonly handle?: SlotRecipe;
  readonly props: P;
}

export type FeatureFactory<P = unknown> = (props?: P) => FeatureSpec<P>;

export function createFeature<P = void>(
  name: string,
  slots: FeatureSlots,
  opts?: { handle?: SlotRecipe },
): FeatureFactory<P> {
  return (props?: P) => ({ featureName: name, slots, handle: opts?.handle, props: props as P });
}

export const Features = createToken<readonly FeatureSpec<any>[]>('Features');

export const featureSpecs = shallowRef<readonly FeatureSpec<any>[]>([]);
