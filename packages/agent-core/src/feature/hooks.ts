import { computed, toValue, type MaybeRefOrGetter } from '@vue/reactivity';

import { provide, useChildren, type ChildEntry } from '#/kernel/index';

import { Features, type FeatureSpec, type FeatureTier } from './feature';

export function useFeatureSlot(
  tier: FeatureTier,
  features?: MaybeRefOrGetter<readonly FeatureSpec[] | undefined>,
) {
  const list = computed(() => dedupFeatures(toValue(features) ?? []));
  provide(Features, list);
  return useChildren(() => list.value.flatMap((feature) => slotEntries(feature, tier)));
}

export function dedupFeatures(features: readonly FeatureSpec[]): readonly FeatureSpec[] {
  const seen = new Set<string>();
  return features.filter((feature) => {
    if (seen.has(feature.featureName)) {
      return false;
    }
    seen.add(feature.featureName);
    return true;
  });
}

function slotEntries(feature: FeatureSpec, tier: FeatureTier): ChildEntry[] {
  const recipe = feature.slots[tier];
  if (recipe === undefined) {
    return [];
  }
  return [{ key: `${feature.featureName}:${tier}`, recipe }];
}
