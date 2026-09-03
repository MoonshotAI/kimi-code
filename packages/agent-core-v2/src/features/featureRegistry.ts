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
