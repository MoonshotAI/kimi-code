/**
 * `sessionSkillCatalog` test stubs — shared config / plugin / workspace
 * fakes for the catalog scenario tests in this directory.
 *
 * `configStub()` serves the skill-catalog config sections in memory and can
 * fire synthetic section changes; `pluginStub()` is an inert plugin service
 * with optional skill roots and reload event; `workspaceStub()` is a mutable
 * in-memory workspace context. Import from a relative path (`./stubs`).
 */

import type { Emitter } from '#/_base/event';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import type { ReloadSummary } from '#/app/plugin/types';
import {
  EXTRA_SKILL_DIRS_SECTION,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
} from '#/app/skillCatalog/configSection';
import type { SkillRoot } from '#/app/skillCatalog/types';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

export function configStub(): IConfigService & {
  setExtraSkillDirs(dirs: readonly string[]): void;
  setMergeAllAvailableSkills(value: boolean): void;
  fireSectionChange(domain: string): void;
} {
  let extraSkillDirs: readonly string[] = [];
  let mergeAllAvailableSkills = true;
  const sectionChangeListeners: Array<(event: unknown) => void> = [];
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidSectionChange: (listener: (event: unknown) => void) => {
      sectionChangeListeners.push(listener);
      return { dispose: () => {} };
    },
    get: (domain: string) => {
      if (domain === EXTRA_SKILL_DIRS_SECTION) return [...extraSkillDirs];
      if (domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) return mergeAllAvailableSkills;
      return undefined;
    },
    inspect: () => ({ value: undefined, defaultValue: undefined, userValue: undefined, memoryValue: undefined }),
    getAll: () => ({}),
    set: async () => {},
    replace: async () => {},
    reload: async () => {},
    diagnostics: () => [],
    setExtraSkillDirs: (dirs: readonly string[]) => {
      extraSkillDirs = [...dirs];
    },
    setMergeAllAvailableSkills: (value: boolean) => {
      mergeAllAvailableSkills = value;
    },
    fireSectionChange: (domain: string) => {
      for (const listener of sectionChangeListeners) {
        listener({ domain, source: 'set', value: undefined, previousValue: undefined });
      }
    },
  } as unknown as IConfigService & {
    setExtraSkillDirs(dirs: readonly string[]): void;
    setMergeAllAvailableSkills(value: boolean): void;
    fireSectionChange(domain: string): void;
  };
}

export function pluginStub(
  skillRoots: readonly SkillRoot[] = [],
  reloadEmitter?: Emitter<ReloadSummary>,
): IPluginService {
  return {
    _serviceBrand: undefined,
    onDidReload: reloadEmitter !== undefined ? reloadEmitter.event : () => ({ dispose: () => {} }),
    listPlugins: async () => [],
    installPlugin: async () => ({ id: '' }) as never,
    setPluginEnabled: async () => {},
    setPluginMcpServerEnabled: async () => {},
    removePlugin: async () => {},
    reloadPlugins: async () => ({ added: [], removed: [], errors: [] }),
    getPluginInfo: async () => {
      throw new Error('getPluginInfo is not used by these tests');
    },
    listPluginCommands: async () => [],
    checkUpdates: async () => [],
    pluginSkillRoots: async () => skillRoots,
    enabledSessionStarts: async () => [],
    enabledMcpServers: async () => ({}),
    enabledHooks: async () => [],
  };
}

export function workspaceStub(workDir: string): {
  readonly stub: ISessionWorkspaceContext;
  setWorkDir(dir: string): void;
} {
  let current = workDir;
  const stub = {
    _serviceBrand: undefined,
    get workDir() {
      return current;
    },
    additionalDirs: [] as readonly string[],
    setWorkDir: (dir: string) => {
      current = dir;
    },
    setAdditionalDirs: () => {},
    resolve: (rel: string) => rel,
    isWithin: () => true,
    assertAllowed: (p: string) => p,
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  } satisfies ISessionWorkspaceContext;
  return { stub, setWorkDir: (dir) => { current = dir; } };
}
