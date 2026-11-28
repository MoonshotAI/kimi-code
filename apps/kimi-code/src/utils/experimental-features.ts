import type {
  ExperimentalFeatureState,
  ExperimentalFlagMap,
} from '@moonshot-ai/kimi-code-sdk';

export function experimentalFeatureMap(
  features: readonly (Pick<ExperimentalFeatureState, 'id' | 'enabled'> &
    Partial<Pick<ExperimentalFeatureState, 'active'>>)[],
): ExperimentalFlagMap {
  return Object.fromEntries(
    features.map((feature) => [feature.id, feature.active ?? feature.enabled]),
  );
}
