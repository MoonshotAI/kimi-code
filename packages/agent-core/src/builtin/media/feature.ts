import { useCollection } from '#/kernel/index';
import { createFeature, type FeatureSpec } from '#/feature/feature';
import { useLlmRecovery, useMediaLower } from '#/feature/contribution-hooks';
import { createMediaDegradeRecovery } from '#/llm/builtin/media/degrade';
import type { MediaUploadCache } from '#/llm/media/cache';
import type { MediaSource } from '#/llm/media/source';
import { Providers } from '#/builtin/provider-catalog/feature';

export function createMedia(deps: {
  readonly source: MediaSource;
  readonly cache: MediaUploadCache;
}): FeatureSpec {
  return createFeature('media', {
    agent() {
      const contributed = useCollection(Providers);
      useMediaLower({
        source: deps.source,
        cache: deps.cache,
        providers: () => contributed.value.map((item) => item.provider),
      });
      useLlmRecovery(createMediaDegradeRecovery());
    },
  });
}
