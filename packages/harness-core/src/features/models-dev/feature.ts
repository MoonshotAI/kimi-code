import {
  anthropicBase,
  ConfigRef,
  createFeature,
  createGoogleGenAIBase,
  googleGenAIBase,
  MODEL_CATALOG_CONFIG_SECTION,
  openAIBase,
  openAIResponsesBase,
  useProviderProtocol,
  type CatalogProviderInfo,
  type FeatureSpec,
  type ModelCatalogConfig,
  type ProviderConnection,
} from '@moonshot-ai/agent-core';
import {
  lineage,
  pushCleanup,
  useExpose,
  useNode,
  watch,
  type UnitNode,
} from '@moonshot-ai/agent-core/kernel/index';

import { createModelsDevService, ModelsDevRef } from './service';

export const DEFAULT_MODELS_DEV_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface CreateModelsDevProps {
  readonly builtinCatalog?: () => unknown;
  readonly userAgent?: string;
}

const vertexGenAIBase = createGoogleGenAIBase({ vertexai: true });

function genericConnection(info: CatalogProviderInfo): ProviderConnection {
  return {
    endpoint: () => ({ defaultBaseUrl: info.baseUrl }),
    defaultHeaders: () =>
      info.customHeaders === undefined ? undefined : { ...info.customHeaders },
  };
}

export function createModelsDev(props: CreateModelsDevProps = {}): FeatureSpec {
  return createFeature('models-dev', {
    app() {
      const node = useNode();
      const configEntries = node.providerRef(ConfigRef);
      const service = createModelsDevService({
        config: () => configEntries.value.at(-1)?.value,
        userAgent: props.userAgent,
        builtinCatalog: props.builtinCatalog,
      });
      useExpose(ModelsDevRef, service);
      useProviderProtocol({
        type: 'openai',
        protocols: (info) => ({
          openai: { base: openAIBase, connection: genericConnection(info) },
          openai_responses: { base: openAIResponsesBase, connection: genericConnection(info) },
        }),
      });
      useProviderProtocol({
        type: 'anthropic',
        protocols: (info) => ({
          anthropic: { base: anthropicBase, connection: genericConnection(info) },
        }),
      });
      useProviderProtocol({
        type: 'google-genai',
        protocols: (info) => ({
          'google-genai': { base: googleGenAIBase, connection: genericConnection(info) },
        }),
      });
      useProviderProtocol({
        type: 'vertexai',
        protocols: (info) => ({
          'google-genai': { base: vertexGenAIBase, connection: genericConnection(info) },
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
      const root = [...lineage(node)].at(-1) as UnitNode;
      watch(
        () =>
          configEntries.value.at(-1)?.value.section<ModelCatalogConfig>(MODEL_CATALOG_CONFIG_SECTION)
            .value,
        (section) => {
          clearTimer();
          if (!started) {
            started = true;
            void root.ready().then(
              () => {
                const loaded = configEntries.value
                  .at(-1)
                  ?.value.get<ModelCatalogConfig>(MODEL_CATALOG_CONFIG_SECTION);
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
      pushCleanup(node, clearTimer);
    },
  });
}
