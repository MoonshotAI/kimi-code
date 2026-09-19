import type { MaybeRefOrGetter } from '@vue/reactivity';

import { createToken, createUnit, type UnitRecipe, type UnitSetup } from '#/kernel/index';

export type FeatureTier = 'app' | 'session' | 'agent';

export interface FeatureSlots {
  readonly app?: UnitSetup<void>;
  readonly session?: UnitSetup<void>;
  readonly agent?: UnitSetup<void>;
}

export interface FeatureSpec {
  readonly featureName: string;
  readonly slots: {
    readonly [K in FeatureTier]?: UnitRecipe;
  };
}

export function createFeature(name: string, slots: FeatureSlots): FeatureSpec {
  return {
    featureName: name,
    slots: {
      app: wrapSlot(name, 'app', slots.app),
      session: wrapSlot(name, 'session', slots.session),
      agent: wrapSlot(name, 'agent', slots.agent),
    },
  };
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
