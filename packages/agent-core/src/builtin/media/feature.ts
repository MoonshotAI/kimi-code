import { createFeature, type FeatureSpec } from '#/feature/feature';
import { useLlmRecovery, useMediaLower } from '#/feature/contribution-hooks';
import { createMediaDegradeRecovery } from '#/llm/builtin/media/degrade';
import type { MediaUploadCache } from '#/llm/media/cache';
import type { MediaSource } from '#/llm/media/source';

export function createMedia(deps: {
  readonly source: MediaSource;
  readonly cache: MediaUploadCache;
}): FeatureSpec {
  return createFeature('media', {
    agent() {
      useMediaLower({
        source: deps.source,
        cache: deps.cache,
      });
      useLlmRecovery(createMediaDegradeRecovery());
    },
  });
}
