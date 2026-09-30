import type { Unsubscribe } from '@moonshot-ai/agent-core/kernel/index';

import type { OsFsPort } from '#/features/os/host/index';
import { discoverSkills } from '#/features/skill/catalog/discovery';
import {
  normalizeSkillName,
  type SkillDefinition,
  type SkillRoot,
} from '#/features/skill/catalog/types';
import {
  PLUGIN_SKILL_SOURCE_ID,
  SKILL_SOURCE_PRIORITY,
  type SkillCatalogSource,
  type SkillContribution,
} from '#/features/skill/sources/source';

export interface PluginSkillSourceDeps {
  readonly fs: OsFsPort;
  readonly roots: () => Promise<readonly SkillRoot[]>;
  readonly warn?: (message: string) => void;
  readonly onDidChange: (listener: () => void) => Unsubscribe;
}

export interface PluginSkillSource {
  readonly source: SkillCatalogSource;
  refresh(roots: readonly SkillRoot[]): Promise<SkillContribution>;
  getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined;
}

export function createPluginSkillSource(deps: PluginSkillSourceDeps): PluginSkillSource {
  let index = new Map<string, SkillDefinition>();
  const refresh = async (roots: readonly SkillRoot[]): Promise<SkillContribution> => {
    const result = await discoverSkills(deps.fs, roots, deps.warn);
    const next = new Map<string, SkillDefinition>();
    for (const skill of result.skills) {
      const plugin = skill.plugin;
      if (plugin === undefined) continue;
      const key = pluginSkillKey(plugin.id, skill.name);
      if (!next.has(key)) next.set(key, skill);
    }
    index = next;
    return {
      skills: result.skills,
      skipped: result.skipped,
      scannedRoots: result.scannedRoots,
    };
  };
  return {
    source: {
      id: PLUGIN_SKILL_SOURCE_ID,
      priority: SKILL_SOURCE_PRIORITY.plugin,
      load: async () => refresh(await deps.roots()),
      onDidChange: deps.onDidChange,
    },
    refresh,
    getPluginSkill: (pluginId, name) => index.get(pluginSkillKey(pluginId, name)),
  };
}

function pluginSkillKey(pluginId: string, name: string): string {
  return `${pluginId}\0${normalizeSkillName(name)}`;
}
