import { isAbsolute, relative } from 'pathe';

import type { ILogService } from '#/_base/log/log';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { BUILTIN_AGENT_PROFILE_SOURCE_ID } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IConfigService } from '#/app/config/config';
import { findGitWorkTree } from '#/app/git/workTree';
import { loadMcpServersDetailed, resolveMcpJsonPaths } from '#/app/mcpConfig/configLoader';
import type { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import {
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  type MergeAllAvailableSkillsConfig,
} from '#/features/skill/catalog/configSection';
import { projectRoots } from '#/features/skill/catalog/skillRoots';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';

import type {
  IWorkspaceTrustDisclosure,
  TrustGatedActivation,
  TrustGatedInstructionSources,
  TrustGatedMcpServer,
} from './trustDisclosure';
import type { IWorkspaceTrust } from './workspaceTrust';

const EMPTY_INSTRUCTION_SOURCES: TrustGatedInstructionSources = {
  agentsMdPaths: [],
  skills: [],
  agentProfiles: [],
};

const EMPTY_ACTIVATION: TrustGatedActivation = {
  mcpServers: [],
  additionalDirs: [],
  instructionSources: EMPTY_INSTRUCTION_SOURCES,
};

export class WorkspaceTrustDisclosureService implements IWorkspaceTrustDisclosure {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly context: IWorkspaceContext,
    private readonly fs: IHostFileSystem,
    private readonly bootstrap: IBootstrapService,
    private readonly config: IConfigService,
    private readonly localConfig: IProjectLocalConfigService,
    private readonly trust: IWorkspaceTrust,
    private readonly skills: IWorkspaceSkillCatalog,
    private readonly agentProfilesLoader: IWorkspaceAgentProfileLoader,
    private readonly agentProfilesRegistry: IAgentProfileRegistry,
    private readonly instructions: IWorkspaceInstructionsService,
    private readonly log: ILogService,
  ) {}

  async describeGatedActivation(): Promise<TrustGatedActivation> {
    await this.trust.ready;
    if (this.trust.isTrusted()) return EMPTY_ACTIVATION;
    const [mcpServers, configuredDirs, skillRoots, instructionSources] = await Promise.all([
      this.describeGatedMcpServers().catch((error: unknown) => {
        this.log.warn(`trust disclosure: MCP scan failed: ${String(error)}`);
        return [];
      }),
      this.readGatedAdditionalDirs().catch((error: unknown) => {
        this.log.warn(`trust disclosure: additional dirs scan failed: ${String(error)}`);
        return [];
      }),
      this.readGatedSkillRoots().catch((error: unknown) => {
        this.log.warn(`trust disclosure: skill roots scan failed: ${String(error)}`);
        return [];
      }),
      this.describeInstructionSources().catch((error: unknown) => {
        this.log.warn(`trust disclosure: instruction sources scan failed: ${String(error)}`);
        return EMPTY_INSTRUCTION_SOURCES;
      }),
    ]);
    const additionalDirs = [...configuredDirs, ...skillRoots].filter(
      (dir, index, all) => all.indexOf(dir) === index,
    );
    return { mcpServers, additionalDirs, instructionSources };
  }

  private async describeGatedMcpServers(): Promise<readonly TrustGatedMcpServer[]> {
    const cwd = this.context.cwd;
    const homeDir = this.bootstrap.homeDir;
    const [paths, loaded] = await Promise.all([
      resolveMcpJsonPaths({ fs: this.fs, cwd, homeDir }),
      loadMcpServersDetailed({ fs: this.fs, cwd, homeDir, includeProject: true }),
    ]);
    const projectPaths = new Set([paths.projectRoot, paths.project]);
    return Object.entries(loaded.servers)
      .filter(([name]) => projectPaths.has(loaded.origins[name] ?? ''))
      .filter(([, config]) => config.enabled !== false)
      .map(([name, config]) => describeMcpServer(name, config, loaded.origins[name] ?? ''))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  private async readGatedAdditionalDirs(): Promise<readonly string[]> {
    const result = await this.localConfig.readAdditionalDirs(this.context.cwd);
    const realRoot = await realpathOrSelf(this.fs, result.projectRoot);
    const dirs: string[] = [];
    for (const dir of result.additionalDirs) {
      const realPath = await realpathOrSelf(this.fs, dir);
      if (isInsideOrEqualDir(realPath, realRoot)) continue;
      dirs.push(realPath);
    }
    return dirs;
  }

  private async readGatedSkillRoots(): Promise<readonly string[]> {
    if ((this.bootstrap.args.skillDirs?.length ?? 0) > 0) return [];
    const mergeAllAvailableSkills =
      this.config.get<MergeAllAvailableSkillsConfig>(MERGE_ALL_AVAILABLE_SKILLS_SECTION) ?? true;
    const projectRoot =
      (await findGitWorkTree(this.fs, this.context.cwd))?.root ?? this.context.cwd;
    const [roots, realRoot] = await Promise.all([
      projectRoots(this.context.cwd, { mergeAllAvailableSkills }),
      realpathOrSelf(this.fs, projectRoot),
    ]);
    return roots
      .filter((root) => !isInsideOrEqualDir(root.path, realRoot))
      .map((root) => root.path);
  }

  private async describeInstructionSources(): Promise<TrustGatedInstructionSources> {
    await Promise.all([
      this.skills.ready,
      this.agentProfilesLoader.ready,
      this.instructions.ready,
    ]);
    const projectRoot =
      (await findGitWorkTree(this.fs, this.context.cwd))?.root ?? this.context.cwd;
    const skills = this.skills.catalog
      .listSkills()
      .filter((skill) => skill.source === 'project')
      .map((skill) => skill.name)
      .toSorted();
    const agentProfiles = this.effectiveWorkspaceProfiles();
    const agentsMdPaths: string[] = [];
    for (const path of this.instructions.snapshot.agentsMdPaths ?? []) {
      if (!isInsideOrEqualDir(path, projectRoot)) continue;
      agentsMdPaths.push(await realpathOrSelf(this.fs, path));
    }
    agentsMdPaths.sort();
    return { agentsMdPaths, skills, agentProfiles };
  }

  private effectiveWorkspaceProfiles(): readonly string[] {
    const entries = this.agentProfilesRegistry
      .entries()
      .filter(
        (entry) =>
          entry.workspaceKey === undefined || entry.workspaceKey === this.context.workspaceId,
      );
    const builtinNames = new Set(
      entries
        .find((entry) => entry.sourceId === BUILTIN_AGENT_PROFILE_SOURCE_ID)
        ?.contribution.profiles.map((profile) => profile.name) ?? [],
    );
    const winners = new Map<string, string>();
    const ordered = entries
      .filter((entry) => entry.sourceId !== BUILTIN_AGENT_PROFILE_SOURCE_ID)
      .toSorted((a, b) => b.priority - a.priority);
    for (const entry of ordered) {
      const entryProfiles = new Map<string, AgentProfile>();
      for (const profile of entry.contribution.profiles) {
        entryProfiles.set(profile.name, profile);
      }
      for (const profile of entryProfiles.values()) {
        if (winners.has(profile.name)) continue;
        if (builtinNames.has(profile.name) && profile.override !== true) continue;
        winners.set(profile.name, entry.sourceId);
      }
    }
    return [...winners]
      .filter(([, sourceId]) => sourceId === 'workspace')
      .map(([name]) => name)
      .toSorted();
  }
}

function describeMcpServer(
  name: string,
  config: McpServerConfig,
  origin: string,
): TrustGatedMcpServer {
  if (config.transport === 'stdio') {
    return {
      name,
      transport: config.transport,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      envKeys: config.env === undefined ? undefined : Object.keys(config.env),
      origin,
    };
  }
  return {
    name,
    transport: config.transport,
    url: config.url,
    headerKeys: config.headers === undefined ? undefined : Object.keys(config.headers),
    bearerTokenEnvVar: config.bearerTokenEnvVar,
    origin,
  };
}

async function realpathOrSelf(fs: IHostFileSystem, dir: string): Promise<string> {
  try {
    return await fs.realpath(dir);
  } catch {
    return dir;
  }
}

function isInsideOrEqualDir(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
