/**
 * `features` domain — the module-level feature recipe table ("import =
 * register").
 *
 * Each feature module calls `registerFeature(Recipe)` at its top level; the
 * assembly drains the table once at App-scope creation. Pure data — no DI, no
 * container — so feature modules stay importable in any bootstrap order.
 */

import type { ServiceClassRecipe } from '#/_base/di/fiber';

const _featureRecipes: ServiceClassRecipe[] = [];

export function registerFeature(recipe: ServiceClassRecipe): void {
  _featureRecipes.push(recipe);
}

export function getFeatureRecipes(): readonly ServiceClassRecipe[] {
  return _featureRecipes;
}

export function _clearFeatureRecipesForTests(): void {
  _featureRecipes.length = 0;
}
