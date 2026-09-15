import type { ChildEntry } from '#/kernel/index';

import type { FeatureSpec } from './feature';

export function slotEntries(feature: FeatureSpec<any>, tier: 'app' | 'session' | 'agent'): ChildEntry[] {
  const slot = feature.slots[tier];
  if (slot === undefined) {
    return [];
  }
  const recipes = Array.isArray(slot) ? slot : [slot];
  return recipes.map((recipe) => ({
    key: `${feature.featureName}:${recipe.name}`,
    recipe,
    props: feature.props,
  }));
}
