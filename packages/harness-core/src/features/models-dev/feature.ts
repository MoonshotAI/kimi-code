import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import { RootRef } from '@moonshot-ai/agent-core/app/units';
import { useCleanup, useExpose, useInject, watch } from '@moonshot-ai/agent-core/kernel/index';

import {
  ConfigRef,
  MODEL_CATALOG_CONFIG_SECTION,
  type ModelCatalogConfig,
} from '#/features/config/index';
import {
  useProviderCatalog,
  useProviderRefresh,
  useProviderRefreshUserAgent,
} from '#/features/provider-catalog/index';

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
      const catalog = useProviderCatalog();
      const service = createModelsDevService({
        config: () => config.value,
        userAgent: props.userAgent,
        builtinCatalog: props.builtinCatalog,
        refresh: () => {
          const store = catalog.value;
          return store === undefined
            ? Promise.resolve({ changed: [], unchanged: [], failed: [] })
            : store.refresh();
        },
      });
      useExpose(ModelsDevRef, service);
      useProviderRefreshUserAgent(props.userAgent);
      useProviderRefresh({
        match: (info) => info.source?.['kind'] === 'modelsDev',
        refresh: (input) => service.refreshProvider(input),
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
