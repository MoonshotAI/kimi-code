import { createFeature, type FeatureSpec } from '#/feature/feature';
import { useLlmRecovery, useMessageResolver } from '#/feature/contribution-hooks';
import { createMediaDegradeRecovery } from '#/llm/builtin/policy/media-degrade';
import { createStoreRefResolver } from '#/llm/builtin/policy/store-ref/index';
import type { StoreRefPorts } from '#/llm/builtin/policy/store-ref/index';

export function createMedia(deps: StoreRefPorts): FeatureSpec {
  return createFeature('media', {
    agent() {
      useMessageResolver(createStoreRefResolver(deps));
      useLlmRecovery(createMediaDegradeRecovery());
    },
  });
}
