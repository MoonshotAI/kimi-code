import type { OsFsPort } from '#/features/os/host/index';

import { PRIORITY } from '../catalog/catalog';
import { parseAgentFileText } from '../definition/agent-file';
import {
  agentProfileFromFile,
  profilesFromDiscovery,
  type AgentProfileBasePrompt,
} from '../definition/from-file';
import type { AgentProfile } from '../definition/types';
import { discoverAgentFiles } from './discovery';
import type { ProfileFinder } from './finder';
import { resolveAgentPath } from './paths';
import { configuredAgentRoots, projectAgentRoots, userAgentRoots } from './roots';
import { loadSystemMdProfile } from './system-file';

export interface UserFinderDeps {
  readonly fs: OsFsPort;
  readonly homeDir: string;
  readonly osHomeDir?: string;
  readonly builtinDefault: AgentProfile;
  readonly onWarn?: (message: string) => void;
}

export interface UserProfileFinder extends ProfileFinder {
  defaultProfile(): AgentProfile;
}

export function createUserFinder(deps: UserFinderDeps): UserProfileFinder {
  let currentDefault = deps.builtinDefault;
  return {
    sourceId: 'user',
    priority: PRIORITY.user,
    defaultProfile: () => currentDefault,
    load: async () => {
      const roots = await userAgentRoots(deps.fs, deps.homeDir, deps.osHomeDir, deps.onWarn);
      const systemMd = await loadSystemMdProfile(
        deps.fs,
        deps.homeDir,
        deps.builtinDefault,
        deps.onWarn,
      );
      currentDefault = systemMd ?? deps.builtinDefault;
      const contribution = profilesFromDiscovery(
        await discoverAgentFiles(deps.fs, roots, deps.onWarn),
        (context) => currentDefault.renderSystemPrompt(context),
      );
      if (systemMd === undefined) return contribution;
      return { ...contribution, profiles: [...contribution.profiles, systemMd] };
    },
  };
}

export interface WorkspaceFinderDeps {
  readonly fs: OsFsPort;
  readonly workDir: string;
  readonly basePrompt: AgentProfileBasePrompt;
  readonly onWarn?: (message: string) => void;
}

export function createWorkspaceFinder(deps: WorkspaceFinderDeps): ProfileFinder {
  return {
    sourceId: 'workspace',
    priority: PRIORITY.workspace,
    load: async () => {
      const roots = await projectAgentRoots(deps.fs, deps.workDir, deps.onWarn);
      return profilesFromDiscovery(
        await discoverAgentFiles(deps.fs, roots, deps.onWarn),
        deps.basePrompt,
      );
    },
  };
}

export interface ExtraFinderDeps {
  readonly fs: OsFsPort;
  readonly dirs: readonly string[];
  readonly workDir: string;
  readonly osHomeDir?: string;
  readonly basePrompt: AgentProfileBasePrompt;
  readonly onWarn?: (message: string) => void;
}

export function createExtraFinder(deps: ExtraFinderDeps): ProfileFinder {
  return {
    sourceId: 'extra',
    priority: PRIORITY.extra,
    load: async () =>
      profilesFromDiscovery(
        await discoverAgentFiles(
          deps.fs,
          await configuredAgentRoots(
            deps.fs,
            deps.dirs,
            deps.workDir,
            deps.osHomeDir,
            'extra',
            deps.onWarn,
          ),
          deps.onWarn,
        ),
        deps.basePrompt,
      ),
  };
}

export interface ExplicitFinderDeps {
  readonly fs: OsFsPort;
  readonly files: readonly string[];
  readonly workDir: string;
  readonly osHomeDir?: string;
  readonly basePrompt: AgentProfileBasePrompt;
}

export function createExplicitFinder(deps: ExplicitFinderDeps): ProfileFinder {
  return {
    sourceId: 'explicit',
    priority: PRIORITY.explicit,
    fatal: true,
    load: async () => {
      const profiles: AgentProfile[] = [];
      for (const file of deps.files) {
        const filePath = resolveAgentPath(file, deps.workDir, deps.osHomeDir);
        if (filePath === undefined) {
          throw new Error(`Cannot resolve "${file}" without a home directory.`);
        }
        const text = await deps.fs.readText(filePath);
        profiles.push(
          agentProfileFromFile(
            parseAgentFileText({ path: filePath, source: 'explicit', text }),
            deps.basePrompt,
          ),
        );
      }
      return { profiles };
    },
  };
}
