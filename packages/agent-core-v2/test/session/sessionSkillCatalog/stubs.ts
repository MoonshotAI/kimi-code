/** `sessionSkillCatalog` test stubs — config / plugin / workspace fakes for catalog tests. */

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

type ConfigStub = IConfigService & {
  setExtraSkillDirs(dirs: readonly string[]): void;
  fireSectionChange(domain: string): void;
};

export function configStub(): ConfigStub {
  let extraSkillDirs: readonly string[] = [];
  const listeners: Array<(event: unknown) => void> = [];
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidSectionChange: (listener: (event: unknown) => void) => {
      listeners.push(listener);
      return { dispose: () => {} };
    },
    get: (domain: string) => {
      if (domain === EXTRA_SKILL_DIRS_SECTION) return [...extraSkillDirs];
      if (domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) return true;
      return undefined;
    },
    setExtraSkillDirs: (dirs: readonly string[]) => (extraSkillDirs = [...dirs]),
    fireSectionChange: (domain: string) => listeners.forEach((l) => l({ domain, source: 'set' })),
  } as unknown as ConfigStub;
}

export function pluginStub(
  skillRoots: readonly SkillRoot[] = [],
  reloadEmitter?: Emitter<ReloadSummary>,
): IPluginService {
  return {
    _serviceBrand: undefined,
    onDidReload: reloadEmitter !== undefined ? reloadEmitter.event : () => ({ dispose: () => {} }),
    pluginSkillRoots: async () => skillRoots,
  } as unknown as IPluginService;
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
  } as unknown as ISessionWorkspaceContext;
  return { stub, setWorkDir: (dir: string) => (current = dir) };
}
