import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import { RootRef } from '@moonshot-ai/agent-core/app/units';
import { useCleanup, useExpose, useInject, watch } from '@moonshot-ai/agent-core/kernel/index';
import {
  anthropicRequester,
  googleGenAIRequester,
  googleVertexRequester,
  openAIRequester,
  openAIResponsesRequester,
} from '@moonshot-ai/agent-core/llm/builtin/provider/index';

import {
  ConfigRef,
  MODEL_CATALOG_CONFIG_SECTION,
  type ModelCatalogConfig,
} from '#/features/config/index';
import { useProviderProtocol } from '#/features/provider-catalog/index';

import { createModelsDevService, ModelsDevRef } from './service';

export const DEFAULT_MODELS_DEV_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface CreateModelsDevProps {
  readonly builtinCatalog?: () => unknown;
  readonly userAgent?: string;
}

export function createModelsDev(props: CreateModelsDevProps = {}): Feature<void> {
  return createFeature('models-dev', {
    app() {
      const config = useInject(ConfigRef);
      const root = useInject(RootRef);
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
      watch(
        () =>
          config.value?.section<ModelCatalogConfig>(MODEL_CATALOG_CONFIG_SECTION)
            .value,
        (section) => {
          clearTimer();
          if (!started) {
            started = true;
            void root.ready().then(
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
