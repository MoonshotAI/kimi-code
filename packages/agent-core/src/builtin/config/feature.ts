import {
  createCollection,
  createToken,
  inject,
  lineage,
  pushCleanup,
  useCollection,
  useExpose,
  useFire,
  useNode,
  useReady,
  watch,
  type RuntimeEvent,
  type UnitNode,
} from '#/kernel/index';
import { createFeature, type FeatureSpec } from '#/feature/feature';

import {
  createConfigStore,
  type ConfigChangeSource,
  type ConfigPersist,
  type ConfigSectionContribution,
  type ConfigStore,
} from './store';

export const ConfigSections = createCollection<ConfigSectionContribution>('config.sections');

export const ConfigRef = createToken<ConfigStore>('config');

export function useConfigSection<T>(section: ConfigSectionContribution<T>): void {
  const node = useNode();
  pushCleanup(
    node,
    ([...lineage(node)].at(-1) as UnitNode).contribute(ConfigSections, section as ConfigSectionContribution, 0),
  );
}

export function useConfig(): ConfigStore {
  return inject(ConfigRef);
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
      const node = useNode();
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
        pushCleanup(node, () => {
          if (timer !== undefined) clearTimeout(timer);
          off();
        });
      }
      pushCleanup(node, () => {
        store.dispose();
      });
    },
  });
}
