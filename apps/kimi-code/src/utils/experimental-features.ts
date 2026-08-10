/** Experimental-feature snapshot (mirror of the SDK `ExperimentalFeatureState`). */
export interface ExperimentalFeatureState {
  readonly id: string;
  readonly enabled: boolean;
}

/** Resolved enabled-state of every experimental flag (flag id → enabled). */
export type ExperimentalFlagMap = Record<string, boolean>;

export function experimentalFeatureMap(
  features: readonly Pick<ExperimentalFeatureState, 'id' | 'enabled'>[],
): ExperimentalFlagMap {
  return Object.fromEntries(features.map((feature) => [feature.id, feature.enabled]));
}
