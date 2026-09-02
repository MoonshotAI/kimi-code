import type { ServiceClassRecipe } from '#/_base/di/fiber';
import type { FlagId } from '#/app/flag/flagRegistry';

export interface FeatureRegistration {
  readonly recipe: ServiceClassRecipe;
  readonly flag?: FlagId;
}

const _featureRegistrations: FeatureRegistration[] = [];

export function registerFeature(
  recipe: ServiceClassRecipe,
  options: { readonly flag?: FlagId } = {},
): void {
  _featureRegistrations.push({ recipe, flag: options.flag });
}

export function getFeatureRegistrations(): readonly FeatureRegistration[] {
  return _featureRegistrations;
}

export function _clearFeatureRecipesForTests(): void {
  _featureRegistrations.length = 0;
}
