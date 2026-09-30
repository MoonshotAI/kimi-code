import {
  anthropicRequester,
  ConfigRef,
  createFeature,
  googleGenAIRequester,
  googleVertexRequester,
  MODEL_CATALOG_CONFIG_SECTION,
  openAIRequester,
  openAIResponsesRequester,
  useApp,
  useCleanup,
  useInject,
  useProviderProtocol,
  type FeatureSpec,
  type ModelCatalogConfig,
} from '@moonshot-ai/agent-core';
import { useExpose, watch } from '@moonshot-ai/agent-core/kernel/index';

import { createModelsDevService, ModelsDevRef } from './service';

export const DEFAULT_MODELS_DEV_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface CreateModelsDevProps {
  readonly builtinCatalog?: () => unknown;
  readonly userAgent?: string;
}

export function createModelsDev(props: CreateModelsDevProps = {}): FeatureSpec {
  return createFeature('models-dev', {
    app() {
      const config = useInject(ConfigRef);
      const service = createModelsDevService({
        config: () => config.value,
        userAgent: props.userAgent,
        builtinCatalog: props.builtinCatalog,
      });
      useExpose(ModelsDevRef, service);
      useProviderProtocol({
        type: 'openai',
        protocols: () => ({
          openai: openAIRequester,
          openai_responses: openAIResponsesRequester,
        }),
      });
      useProviderProtocol({
        type: 'anthropic',
        protocols: () => ({
          anthropic: anthropicRequester,
        }),
      });
      useProviderProtocol({
        type: 'google-genai',
        protocols: () => ({
          'google-genai': googleGenAIRequester,
        }),
      });
      useProviderProtocol({
        type: 'vertexai',
        protocols: () => ({
          'google-genai': googleVertexRequester,
        }),
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started = false;
      const clearTimer = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      const app = useApp();
      watch(
        () =>
          config.value?.section<ModelCatalogConfig>(MODEL_CATALOG_CONFIG_SECTION)
            .value,
        (section) => {
          clearTimer();
          if (!started) {
            started = true;
            void app.ready().then(
              () => {
                const loaded = config.value?.get<ModelCatalogConfig>(MODEL_CATALOG_CONFIG_SECTION);
                if (loaded?.refreshOnStart ?? true) {
                  void service.refreshRegistries().catch(() => {});
                }
              },
              () => {},
            );
          }
          const interval = section?.refreshIntervalMs ?? DEFAULT_MODELS_DEV_REFRESH_INTERVAL_MS;
          if (interval <= 0) return;
          const scheduleNext = (): void => {
            timer = setTimeout(() => {
              void service.refreshRegistries().catch(() => {});
              scheduleNext();
            }, interval);
            timer.unref?.();
          };
          scheduleNext();
        },
        { immediate: true },
      );
      useCleanup(clearTimer);
    },
  });
}
