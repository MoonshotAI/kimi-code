import type { ExperimentalFeatureState, ExperimentalFlagMap } from '@moonshot-ai/kimi-code-sdk';

import { experimentalFeatureMap } from '#/utils/experimental-features';

let snapshot: ExperimentalFlagMap = {};

export function setExperimentalFeatures(
  features: readonly Pick<ExperimentalFeatureState, 'id' | 'enabled'>[],
): void {
  snapshot = experimentalFeatureMap(features);
}

export function isExperimentalFlagEnabled(flag: string | undefined): boolean {
  return flag === undefined || snapshot[flag] === true;
}
