import { createCollection, useCleanup } from '#/kernel/index';
import { currentUnit, lineage, type UnitNode } from '#/kernel/runtime';

import type { PluginHookSource } from '#/todo-features/plugin/index';

export type HookSource = PluginHookSource;

export const HookSources = createCollection<HookSource>('externalHooks.hook-sources');

export function useHookSource(source: HookSource): void {
  useCleanup(
    ([...lineage(currentUnit())].at(-1) as UnitNode).register(HookSources, source, 0),
  );
}
