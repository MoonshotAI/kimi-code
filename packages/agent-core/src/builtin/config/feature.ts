import {
  createCollection,
  createFacadeToken,
  lineage,
  useCleanup,
  useCollection,
  useExpose,
  useFire,
  useInject,
  useReady,
  watch,
  type RuntimeEvent,
  type ShallowRef,
  type UnitNode,
} from '#/kernel/index';
import { useNode } from '#/kernel/hooks';
import { createFeature, type FeatureSpec } from '#/feature/feature';

import {
  createConfigStore,
  type ConfigChangeSource,
  type ConfigOverlayContribution,
  type ConfigPersist,
  type ConfigSectionContribution,
  type ConfigStore,
} from './store';

export const ConfigSections = createCollection<ConfigSectionContribution>('config.sections');

export const ConfigOverlays = createCollection<ConfigOverlayContribution>('config.overlays');

export const ConfigRef = createFacadeToken<ConfigStore>('config');

export function useConfigSection<T>(section: ConfigSectionContribution<T>): void {
  useCleanup(
    ([...lineage(useNode())].at(-1) as UnitNode).contribute(ConfigSections, section as ConfigSectionContribution, 0),
  );
}

export function useConfigOverlay(contribution: ConfigOverlayContribution): void {
  useCleanup(
    ([...lineage(useNode())].at(-1) as UnitNode).contribute(ConfigOverlays, contribution, 0),
  );
}

export function useConfig(): Readonly<ShallowRef<ConfigStore | undefined>> {
  return useInject(ConfigRef);
}

export interface ConfigChangedEvent extends RuntimeEvent {
  readonly type: 'config.changed';
  readonly section: string;
  readonly value: unknown;
  readonly previousValue: unknown;
  readonly source: ConfigChangeSource;
}

export function createConfig(deps: {
  readonly persist?: ConfigPersist;
  readonly env?: Record<string, string | undefined>;
}): FeatureSpec<ConfigChangedEvent> {
  return createFeature<ConfigChangedEvent>('config', {
    app() {
      const fire = useFire();
      const store = createConfigStore({
        persist: deps.persist,
        env: deps.env,
        onChanged: (section, value, previousValue, source) => {
          fire({ type: 'config.changed', section, value, previousValue, source });
        },
      });
      const contributed = useCollection(ConfigSections);
      watch(
        contributed,
        (list) => {
          store.syncSections(list);
        },
        { immediate: true },
      );
      const contributedOverlays = useCollection(ConfigOverlays);
      watch(
        contributedOverlays,
        (list) => {
          store.syncOverlays(list);
        },
        { immediate: true },
      );
      useReady(store.reload());
      useExpose(ConfigRef, store);
      const persistWatch = deps.persist?.watch;
      if (persistWatch !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const off = persistWatch(() => {
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = undefined;
            void store.reload();
          }, 150);
        });
        useCleanup(() => {
          if (timer !== undefined) clearTimeout(timer);
          off();
        });
      }
      useCleanup(() => {
        store.dispose();
      });
    },
  });
}
