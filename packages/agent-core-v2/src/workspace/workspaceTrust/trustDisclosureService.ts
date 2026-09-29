import { isAbsolute, relative } from 'pathe';

import type { ILogService } from '#/_base/log/log';
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
  paths: [],
};

const EMPTY_ACTIVATION: TrustGatedActivation = {
  mcpServers: [],
  additionalDirs: [],
  additionalDirSources: [],
  warnings: [],
  instructionSources: EMPTY_INSTRUCTION_SOURCES,
};

const SKILL_DISCLOSURE_TIMEOUT_MS = 1000;

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
    const warnings: string[] = [];
    const [mcpServers, configuredDirs, skillRoots, instructionSources] = await Promise.all([
      this.describeGatedMcpServers().catch((error: unknown) => {
        this.log.warn(`trust disclosure: MCP scan failed: ${String(error)}`);
        warnings.push('Could not inspect MCP configuration.');
        return [];
      }),
      this.readGatedAdditionalDirs().catch((error: unknown) => {
        this.log.warn(`trust disclosure: additional dirs scan failed: ${String(error)}`);
        warnings.push('Could not inspect additional directory configuration.');
        return { dirs: [], sources: [] };
      }),
      this.readGatedSkillRoots().catch((error: unknown) => {
        this.log.warn(`trust disclosure: skill roots scan failed: ${String(error)}`);
        warnings.push('Could not inspect project skill directories.');
        return [];
      }),
      this.describeInstructionSources(warnings).catch((error: unknown) => {
        this.log.warn(`trust disclosure: instruction sources scan failed: ${String(error)}`);
        warnings.push('Could not inspect project instructions.');
        return EMPTY_INSTRUCTION_SOURCES;
      }),
    ]);
    const additionalDirs = [...configuredDirs.dirs, ...skillRoots].filter(
      (dir, index, all) => all.indexOf(dir) === index,
    );
    const additionalDirSources = [...new Set([...configuredDirs.sources, ...skillRoots])];
    return { mcpServers, additionalDirs, additionalDirSources, instructionSources, warnings };
  }

  private async describeGatedMcpServers(): Promise<readonly TrustGatedMcpServer[]> {
    const cwd = this.context.cwd;
    const homeDir = this.bootstrap.homeDir;
    const [paths, loaded] = await Promise.all([
      resolveMcpJsonPaths({ fs: this.fs, cwd, homeDir }),
      loadMcpServersDetailed({ fs: this.fs, cwd, homeDir, includeProject: true }),
    ]);
    const projectPaths = new Set([paths.projectRoot, paths.project]);
    const servers = Object.entries(loaded.servers)
      .filter(([name]) => projectPaths.has(loaded.origins[name] ?? ''))
      .filter(([, config]) => config.enabled !== false)
      .map(([name, config]) => describeMcpServer(name, config, loaded.origins[name] ?? ''))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    return Promise.all(
      servers.map(async (server) => ({
        ...server,
        origin: await realpathOrSelf(this.fs, server.origin),
      })),
    );
  }

  private async readGatedAdditionalDirs(): Promise<{
    dirs: readonly string[];
    sources: readonly string[];
  }> {
    const result = await this.localConfig.readAdditionalDirs(this.context.cwd);
    const realRoot = await realpathOrSelf(this.fs, result.projectRoot);
    const dirs: string[] = [];
    for (const dir of result.additionalDirs) {
      const realPath = await realpathOrSelf(this.fs, dir);
      if (isInsideOrEqualDir(realPath, realRoot)) continue;
      dirs.push(realPath);
    }
    return {
      dirs,
      sources: dirs.length > 0 ? [await realpathOrSelf(this.fs, result.configPath)] : [],
    };
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

  private async describeInstructionSources(
    warnings: string[],
  ): Promise<TrustGatedInstructionSources> {
    const [skillsReady] = await Promise.all([
      waitForReady(this.skills.ready, SKILL_DISCLOSURE_TIMEOUT_MS),
      this.agentProfilesLoader.ready,
      this.instructions.ready,
    ]);
    if (!skillsReady) {
      warnings.push('Project skills are still loading; inspect the project skill directories.');
    }
    const projectRoot =
      (await findGitWorkTree(this.fs, this.context.cwd))?.root ?? this.context.cwd;
    if (this.instructions.snapshot.agentsMdWarning !== undefined) {
      warnings.push(this.instructions.snapshot.agentsMdWarning);
    }
    const skills = this.skills.catalog.listSkills().filter((skill) => skill.source === 'project');
    const profiles = this.effectiveWorkspaceProfiles();
    const agentsMdPaths: string[] = [];
    for (const path of this.instructions.snapshot.agentsMdPaths ?? []) {
      if (!isInsideOrEqualDir(path, projectRoot)) continue;
      agentsMdPaths.push(await realpathOrSelf(this.fs, path));
    }
    agentsMdPaths.sort();
    const workspaceProfiles = this.agentProfilesRegistry
      .entries()
      .find(
        (entry) =>
          entry.sourceId === 'workspace' && entry.workspaceKey === this.context.workspaceId,
      );
    const [skillPaths, profilePaths] = await Promise.all([
      skillsReady
        ? this.sourceLocations(
            skills.map((skill) => skill.path),
            this.skills.catalog.getSkillRoots(),
          )
        : this.projectSkillRootPaths(),
      Promise.all(
        (profiles.length > 0 ? workspaceProfiles?.contribution.scannedRoots ?? [] : [])
          .map(async (root) => `${await realpathOrSelf(this.fs, root)}/`),
      ),
    ]);
    return {
      agentsMdPaths,
      skills: skills.map((skill) => skill.name).toSorted(),
      agentProfiles: profiles,
      paths: [...new Set([...agentsMdPaths, ...skillPaths, ...profilePaths])],
    };
  }

  private async sourceLocations(
    paths: readonly string[],
    roots: readonly string[],
  ): Promise<string[]> {
    const realRoots = await Promise.all(roots.map((root) => realpathOrSelf(this.fs, root)));
    realRoots.sort((a, b) => b.length - a.length);
    const locations = await Promise.all(
      paths.map(async (path) => {
        const realPath = await realpathOrSelf(this.fs, path);
        const root = realRoots.find((root) => isInsideOrEqualDir(realPath, root));
        return root === undefined ? realPath : `${root}/`;
      }),
    );
    return [...new Set(locations)].toSorted();
  }

  private async projectSkillRootPaths(): Promise<readonly string[]> {
    const mergeAllAvailableSkills =
      this.config.get<MergeAllAvailableSkillsConfig>(MERGE_ALL_AVAILABLE_SKILLS_SECTION) ?? true;
    return (await projectRoots(this.context.cwd, { mergeAllAvailableSkills }))
      .map((root) => root.path)
      .toSorted();
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
      const seen = new Set<string>();
      for (const profile of entry.contribution.profiles) {
        if (seen.has(profile.name)) continue;
        seen.add(profile.name);
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
      origin,
    };
  }
  return {
    name,
    transport: config.transport,
    url: config.url,
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
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

async function waitForReady(ready: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ready.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
