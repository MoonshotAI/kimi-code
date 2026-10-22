import { createCollection, useCleanup } from '#/composition-api/index';
import { currentUnit, lineage, type UnitNode } from '#/composition-api/runtime';

import type { PluginHookSource } from '#/todo-features/plugin/index';

export type HookSource = PluginHookSource;

export const HookSources = createCollection<HookSource>('externalHooks.hook-sources');

export function useHookSource(source: HookSource): void {
  useCleanup(
    ([...lineage(currentUnit())].at(-1) as UnitNode).register(HookSources, source, 0),
  );
}
