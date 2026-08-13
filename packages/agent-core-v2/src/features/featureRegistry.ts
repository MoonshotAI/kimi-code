/**
 * `features` domain — the module-level feature recipe table ("import =
 * register") plus the contributed-service table (one entry per
 * `Feature.contributeService` call — the record that lets the debug RPC
 * dispatcher reach runtime-contributed Services without opening the door to
 * arbitrary decorator names).
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
