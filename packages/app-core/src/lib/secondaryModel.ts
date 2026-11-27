import type { AppConfig } from '../api/types';

export type SecondaryModelConfig = NonNullable<AppConfig['secondaryModel']>;

export function buildSecondaryModelPatch(
  current: AppConfig['secondaryModel'],
  choice: { model: string; effort?: string },
): SecondaryModelConfig {
  const patch: SecondaryModelConfig = { defaultModel: choice.model };
  if (current?.models !== undefined && !Object.hasOwn(current.models, choice.model)) {
    patch.models = { ...current.models, [choice.model]: '' };
  }
  if (choice.effort) patch.defaultEffort = choice.effort;
  return patch;
}
