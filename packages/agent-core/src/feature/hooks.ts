import { computed, toValue, type MaybeRefOrGetter } from '@vue/reactivity';

import { provide, useChildren, useNode, type ChildEntry } from '#/kernel/index';

import { Features, type FeatureSpec, type FeatureTier } from './feature';

export function useFeatureSlot(
  tier: FeatureTier,
  extra?: MaybeRefOrGetter<readonly FeatureSpec[] | undefined>,
) {
  const inherited = readInheritedFeatures();
  const features = computed(() => [...toValue(inherited), ...(toValue(extra) ?? [])]);
  provide(Features, features);
  return useChildren(() => features.value.flatMap((feature) => slotEntries(feature, tier)));
}

function slotEntries(feature: FeatureSpec, tier: FeatureTier): ChildEntry[] {
  const recipe = feature.slots[tier];
  if (recipe === undefined) {
    return [];
  }
  return [{ key: `${feature.featureName}:${tier}`, recipe }];
}

function readInheritedFeatures(): MaybeRefOrGetter<readonly FeatureSpec[]> {
  const parent = useNode().parent;
  if (parent === null) {
    return [];
  }
  try {
    return parent.resolve(Features);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('no provider for token')) {
      return [];
    }
    throw error;
  }
}
