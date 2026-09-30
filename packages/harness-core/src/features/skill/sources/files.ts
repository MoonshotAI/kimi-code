import { z } from 'zod';

import type { ConfigSectionContribution } from '@moonshot-ai/agent-core';

import { discoverSkills } from '../catalog/discovery';
import { configuredRoots, projectRoots, userRoots } from '../catalog/roots';
import type { OsFsPort } from '#/features/os/host/index';

import {
  SKILL_SOURCE_PRIORITY,
  type SkillCatalogSource,
  type SkillContribution,
} from './source';

export const EXTRA_SKILL_DIRS_SECTION = 'extraSkillDirs';

export const extraSkillDirsSection: ConfigSectionContribution<string[]> = {
  name: EXTRA_SKILL_DIRS_SECTION,
  schema: z.array(z.string()),
  defaultValue: [],
};

export const MERGE_ALL_AVAILABLE_SKILLS_SECTION = 'mergeAllAvailableSkills';

export const mergeAllAvailableSkillsSection: ConfigSectionContribution<boolean> = {
  name: MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  schema: z.boolean(),
  defaultValue: true,
};

export const USER_SKILL_SOURCE_ID = 'user';
export const WORKSPACE_SKILL_SOURCE_ID = 'workspace';
export const EXTRA_SKILL_SOURCE_ID = 'extra';
export const EXPLICIT_SKILL_SOURCE_ID = 'explicit';

export interface SharedSkillSourceDeps {
  readonly fs: OsFsPort;
  readonly workDir: string;
  readonly osHomeDir?: string;
  readonly mergeAllAvailableSkills: () => boolean;
  readonly hasExplicitDirs: () => boolean;
  readonly extraSkillDirs: () => readonly string[];
  readonly explicitDirs: () => readonly string[];
  readonly warn?: (message: string) => void;
}

export interface FileSkillSourceDeps extends SharedSkillSourceDeps {
  readonly homeDir: string;
}

export function createUserSkillSource(deps: FileSkillSourceDeps): SkillCatalogSource {
  return {
    id: USER_SKILL_SOURCE_ID,
    priority: SKILL_SOURCE_PRIORITY.user,
    load: async (): Promise<SkillContribution> => {
      if (deps.hasExplicitDirs()) return { skills: [] };
      return discoverSkills(
        deps.fs,
        await userRoots(deps.fs, deps.homeDir, deps.osHomeDir, {
          mergeAllAvailableSkills: deps.mergeAllAvailableSkills(),
        }),
        deps.warn,
      );
    },
  };
}

export function createWorkspaceSkillSource(deps: SharedSkillSourceDeps): SkillCatalogSource {
  return {
    id: WORKSPACE_SKILL_SOURCE_ID,
    priority: SKILL_SOURCE_PRIORITY.workspace,
    load: async (): Promise<SkillContribution> => {
      if (deps.hasExplicitDirs()) return { skills: [] };
      return discoverSkills(
        deps.fs,
        await projectRoots(deps.fs, deps.workDir, {
          mergeAllAvailableSkills: deps.mergeAllAvailableSkills(),
        }),
        deps.warn,
      );
    },
  };
}

export function createExtraSkillSource(deps: SharedSkillSourceDeps): SkillCatalogSource {
  return {
    id: EXTRA_SKILL_SOURCE_ID,
    priority: SKILL_SOURCE_PRIORITY.extra,
    load: async (): Promise<SkillContribution> =>
      discoverSkills(
        deps.fs,
        await configuredRoots(deps.fs, deps.extraSkillDirs(), deps.workDir, deps.osHomeDir, 'extra'),
        deps.warn,
      ),
  };
}

export function createExplicitSkillSource(deps: SharedSkillSourceDeps): SkillCatalogSource {
  return {
    id: EXPLICIT_SKILL_SOURCE_ID,
    priority: SKILL_SOURCE_PRIORITY.user,
    load: async (): Promise<SkillContribution> => {
      const explicitDirs = deps.explicitDirs();
      if (explicitDirs.length === 0) return { skills: [] };
      return discoverSkills(
        deps.fs,
        await configuredRoots(deps.fs, explicitDirs, deps.workDir, deps.osHomeDir, 'user'),
        deps.warn,
      );
    },
  };
}
