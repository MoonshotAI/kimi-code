import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Event } from '#/_base/event';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { AgentProfileRegistryService } from '#/app/agentProfileCatalog/agentProfileRegistryService';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { Program, type ProgramWorkdir } from '#/program/program';
import type { ProgramSessionControllerInput } from '#/program/programDependencies';
import { FileSkillDiscovery } from '#/features/skill/catalog/fileSkillDiscovery';
import { UserFileSkillSource } from '#/features/skill/catalog/userFileSkillSource';
import { noopLogger } from '../wire/stubs';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { writeWorkspaceTrust } from '#/workspace/workspaceTrust/trustRecord';
import { WorkspaceTrustStore } from '#/workspace/workspaceTrust/workspaceTrustStore';
import type { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import type { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';
import type { IWorkspaceGitService } from '#/workspace/workspaceGit/workspaceGit';
import type { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import type { IWorkspaceMcpConfigService } from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import type { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import type { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';

beforeEach(() => { vi.stubEnv('KIMI_CODE_WATCH', 'false'); });
afterEach(() => { vi.unstubAllEnvs(); });

function deferred(): { readonly promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function programWorkspace(cwd: string): IWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workspaceId: 'workspace',
    cwd,
    source: 'local',
    meta: {
      id: 'workspace',
      name: 'workspace',
      root: cwd,
      kind: 'implicit',
      createdAt: 0,
      lastOpenedAt: 0,
    },
    persistenceScope: 'sessions/workspace',
  };
}

const execFileAsync = promisify(execFile);

interface GenerationAccess {
  readonly fs: IWorkspaceFsService;
  readonly git: IWorkspaceGitService;
  readonly mcpConfig: IWorkspaceMcpConfigService;
  readonly instructions: IWorkspaceInstructionsService;
  readonly skills: IWorkspaceSkillCatalog;
  readonly dirs: IWorkspaceDirs;
  readonly agentProfiles: IWorkspaceAgentProfileLoader;
  readonly userAgentProfiles: IUserAgentProfileLoader;
}

interface LocalityFixture {
  readonly program: Program;
  readonly local: () => GenerationAccess;
  readonly workdir: (cwd: string, followsPrimary?: boolean) => Promise<ProgramWorkdir>;
  readonly controllerInputs: ProgramSessionControllerInput[];
  readonly profileRegistry: AgentProfileRegistryService;
  readonly profileRegistrations: { readonly sourceId: string; readonly profiles: readonly string[] }[];
  readonly localGitCalls: string[];
  readonly localRoot: string;
  readonly remoteRoot: string;
  readonly remoteAltRoot: string;
  readonly homeDir: string;
  readonly remoteHomeDir: string;
  readonly cleanup: () => Promise<void>;
}

function scopedFs(base: string, realBase: string, inner: IHostFileSystem, additionalRoots: readonly string[] = []): IHostFileSystem {
  const within = (path: string): boolean =>
    [base, realBase, ...additionalRoots].some((root) => path === root || path.startsWith(`${root}/`));
  const assert = (path: string): void => {
    if (!within(path)) throw new HostFsError(OsFsErrors.codes.OS_FS_NOT_FOUND, `not found: ${path}`);
  };
  return {
    _serviceBrand: undefined,
    readText: (path, options) => { assert(path); return inner.readText(path, options); },
    writeText: (path, data) => { assert(path); return inner.writeText(path, data); },
    appendText: (path, data) => { assert(path); return inner.appendText(path, data); },
    readBytes: (path, n, offset) => { assert(path); return inner.readBytes(path, n, offset); },
    readFileHead: (path, maxBytes) => { assert(path); return inner.readFileHead(path, maxBytes); },
    writeBytes: (path, data) => { assert(path); return inner.writeBytes(path, data); },
    readLines: (path, options) => { assert(path); return inner.readLines(path, options); },
    createExclusive: (path, data) => { assert(path); return inner.createExclusive(path, data); },
    stat: (path) => { assert(path); return inner.stat(path); },
    lstat: inner.lstat.bind(inner),
    readdir: (path) => { assert(path); return inner.readdir(path); },
    walk: (path, options, visit) => { assert(path); return inner.walk(path, options, visit); },
    mkdir: (path, options) => { assert(path); return inner.mkdir(path, options); },
    remove: (path) => { assert(path); return inner.remove(path); },
    realpath: inner.realpath.bind(inner),
  };
}

async function localityFixture(options: { readonly remoteCwd?: string } = {}): Promise<LocalityFixture> {
  const base = await mkdtemp(join(tmpdir(), 'kimi-program-locality-'));
  const localRoot = join(base, 'local');
  const remoteRoot = join(base, 'target');
  const remoteAltRoot = join(base, 'alt');
  const remoteCwd = 'remoteCwd' in options ? options.remoteCwd : remoteRoot;
  const homeDir = join(base, 'home');
  const remoteHomeDir = join(base, 'remote-home');
  const kimiHome = join(homeDir, '.kimi-code');
  await mkdir(localRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await mkdir(remoteAltRoot, { recursive: true });
  await mkdir(kimiHome, { recursive: true });
  await mkdir(join(remoteHomeDir, '.agents'), { recursive: true });

  await writeFile(join(localRoot, 'AGENTS.md'), 'local project instructions');
  await writeFile(join(remoteRoot, 'AGENTS.md'), 'target project instructions');
  await writeFile(join(remoteAltRoot, 'AGENTS.md'), 'alt project instructions');
  await writeFile(join(kimiHome, 'AGENTS.md'), 'user instructions');
  await writeFile(join(remoteHomeDir, '.agents', 'AGENTS.md'), 'remote user instructions');

  const writeSkill = async (root: string, name: string): Promise<void> => {
    await mkdir(join(root, 'skills', name), { recursive: true });
    await writeFile(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\nbody`);
  };
  await writeSkill(join(localRoot, '.kimi-code'), 'local-skill');
  await writeSkill(join(remoteRoot, '.kimi-code'), 'target-skill');
  await writeSkill(kimiHome, 'user-skill');

  const writeAgent = async (dir: string, name: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\n\nYou are ${name}.\n`);
  };
  await writeAgent(join(localRoot, '.kimi-code', 'agents'), 'local-agent');
  await writeAgent(join(remoteRoot, '.kimi-code', 'agents'), 'target-agent');
  await writeAgent(join(remoteAltRoot, '.kimi-code', 'agents'), 'alt-agent');
  await writeAgent(join(kimiHome, 'agents'), 'user-agent');

  await mkdir(join(localRoot, 'localextra'), { recursive: true });
  await mkdir(join(remoteRoot, 'targetextra'), { recursive: true });
  await mkdir(join(remoteAltRoot, 'altextra'), { recursive: true });
  await mkdir(join(localRoot, '.kimi-code'), { recursive: true });
  await mkdir(join(remoteRoot, '.kimi-code'), { recursive: true });
  await mkdir(join(remoteAltRoot, '.kimi-code'), { recursive: true });
  await writeFile(join(localRoot, '.kimi-code', 'local.toml'), '[workspace]\nadditional_dir = ["localextra"]\n');
  await writeFile(join(remoteRoot, '.kimi-code', 'local.toml'), '[workspace]\nadditional_dir = ["targetextra"]\n');
  await writeFile(join(remoteAltRoot, '.kimi-code', 'local.toml'), '[workspace]\nadditional_dir = ["altextra"]\n');

  const mcpJson = (name: string): string => JSON.stringify({ mcpServers: { [name]: { command: 'echo' } } });
  await writeFile(join(localRoot, '.mcp.json'), mcpJson('local-project-server'));
  await writeFile(join(remoteRoot, '.mcp.json'), mcpJson('target-project-server'));
  await writeFile(join(kimiHome, 'mcp.json'), mcpJson('user-server'));

  await execFileAsync('git', ['init', '-b', 'main', remoteRoot]);

  const docsRecords = new Map<string, unknown>();
  const docs = {
    _serviceBrand: undefined,
    get: async <T,>(scope: string, key: string) => docsRecords.get(`${scope}/${key}`) as T | undefined,
    set: async <T,>(scope: string, key: string, value: T) => { docsRecords.set(`${scope}/${key}`, value); },
    delete: async (scope: string, key: string) => { docsRecords.delete(`${scope}/${key}`); },
  };
  await writeWorkspaceTrust(docs as never, localRoot, Date.now());

  const localGitCalls: string[] = [];
  const localGit = {
    status: async (cwd: string) => {
      localGitCalls.push(cwd);
      return { branch: 'local-sentinel', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null };
    },
    diff: async () => ({ path: '', diff: '', truncated: false }),
    findWorkTree: async () => null,
  };

  const controllerInputs: ProgramSessionControllerInput[] = [];
  const profileContainer = new InstantiationService(new ServiceCollection(), true);
  const profileRegistry = profileContainer.createInstance(AgentProfileRegistryService);
  const profileRegistrations: { readonly sourceId: string; readonly profiles: readonly string[] }[] = [];
  const bootstrap = { _serviceBrand: undefined, homeDir: kimiHome, osHomeDir: homeDir, args: {}, getEnv: () => undefined };
  const config = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: () => undefined,
    onDidSectionChange: () => ({ dispose: () => {} }),
  };
  const trustStore = new WorkspaceTrustStore(docs as never, noopTelemetryService, bootstrap as never, config as never);
  const userSkills = new UserFileSkillSource(
    new FileSkillDiscovery(noopLogger),
    bootstrap as never,
    config as never,
  );
  const program = new Program(
    'workspace',
    new HostFileSystem(),
    new HostProcessService(),
    {
      _serviceBrand: undefined,
      osKind: 'Linux',
      osArch: 'x64',
      osVersion: '',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir,
      ready: Promise.resolve(),
    } satisfies IHostEnvironment,
    programWorkspace(localRoot),
    {
      appState: undefined,
      bootstrap,
      config,
      git: { current: localGit, onDidChange: Event.None },
      identity: {
        _serviceBrand: undefined,
        current: () => ({ slug: 'kimi-code' }),
        resolved: async () => ({ slug: 'kimi-code' }),
      },
      log: noopLogger,
      oauth: {
        onEvent: () => () => {},
        setConfigurationSource: () => {},
        removeConfigurationSource: () => {},
      },
      configStore: { onDidWrite: () => ({ dispose: () => {} }) },
      plugins: {
        enabledMcpServers: async () => ({}),
        mcpServerEntries: async () => [],
        onDidReload: () => ({ dispose: () => {} }),
        pluginAgentRoots: async () => [],
        pluginSkillRoots: async () => [],
      },
      sessionManager: { current: undefined, onDidChange: Event.None },
      agentProfiles: {
        _serviceBrand: undefined,
        onDidChange: profileRegistry.onDidChange,
        entries: () => profileRegistry.entries(),
        register: (registration: Parameters<AgentProfileRegistryService['register']>[0]) => {
          profileRegistrations.push({
            sourceId: registration.sourceId,
            profiles: registration.contribution.profiles.map((profile) => profile.name),
          });
          return profileRegistry.register(registration);
        },
      },
      builtinAgentProfiles: { getDefault: () => ({ renderSystemPrompt: () => 'default profile' }) },
      builtinSkills: { _serviceBrand: undefined, id: 'builtin', priority: 0, load: async () => ({ skills: [] }) },
      userSkills,
      telemetry: noopTelemetryService,
      docs: undefined,
      workspaces: {
        _serviceBrand: undefined,
        list: async () => [],
        get: async () => undefined,
        createOrTouch: async () => { throw new Error('unexpected workspace create'); },
      },
      workspaceStore: { onDidChange: () => ({ dispose: () => {} }) },
      trustStore,
      createSessionController: (input: ProgramSessionControllerInput) => {
        controllerInputs.push(input);
        return { dispose: () => {} } as never;
      },
    } as never,
  );

  const local = (): GenerationAccess => {
    const generation = (program as unknown as {
      generation: { workdirs: { root: GenerationAccess }; mcpConfig: IWorkspaceMcpConfigService; userAgentProfiles: IUserAgentProfileLoader };
    }).generation;
    return { ...generation.workdirs.root, mcpConfig: generation.mcpConfig, userAgentProfiles: generation.userAgentProfiles };
  };
  const workdirs: ProgramWorkdir[] = [];
  let controller: { dispose(): void } | undefined;
  const workdir = async (cwd: string, followsPrimary = false): Promise<ProgramWorkdir> => {
    controller ??= program.createSessionController();
    const created = await controllerInputs[0]!.acquireWorkdir(cwd, followsPrimary);
    workdirs.push(created);
    return created;
  };
  return {
    program,
    local,
    workdir,
    controllerInputs,
    profileRegistry,
    profileRegistrations,
    localGitCalls,
    localRoot,
    remoteRoot,
    remoteAltRoot,
    homeDir,
    remoteHomeDir,
    cleanup: async () => {
      await Promise.allSettled([awaitLocality(local()), ...workdirs.map((created) => awaitWorkdir(created))]);
      for (const created of workdirs) created.dispose();
      controller?.dispose();
      await program.dispose();
      userSkills.dispose();
      profileContainer.dispose();
      trustStore.dispose();
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function awaitWorkdir(workdir: ProgramWorkdir): Promise<void> {
  await Promise.all([workdir.instructions.ready, workdir.skills.ready, workdir.dirs.ready, workdir.agentProfiles.ready]);
}

async function awaitLocality(generation: GenerationAccess): Promise<void> {
  await Promise.all([
    generation.instructions.ready,
    generation.skills.ready,
    generation.dirs.ready,
    generation.mcpConfig.ready,
    generation.agentProfiles.ready,
    generation.userAgentProfiles.ready,
  ]);
}

describe('Program local generation and pinned workdirs', () => {
  it('roots the local generation at the workspace root on the local fs, unchanged', async () => {
    const fixture = await localityFixture();
    try {
      const local = fixture.local();
      await awaitLocality(local);

      expect(local.instructions.snapshot.agentsMd).toContain('local project instructions');
      expect(local.instructions.snapshot.agentsMd).toContain('user instructions');
      expect(local.instructions.snapshot.agentsMd).not.toContain('target project instructions');
      expect(local.instructions.snapshot.agentsMd).not.toContain('remote user instructions');

      expect(local.skills.catalog.listSkills().map((skill) => skill.name)).toEqual(['local-skill', 'user-skill']);
      expect(local.dirs.additionalDirs).toEqual([join(fixture.localRoot, 'localextra')]);
      expect(Object.keys(local.mcpConfig.servers()).toSorted()).toEqual(['local-project-server', 'user-server']);
      expect(fixture.profileRegistrations.filter((entry) => entry.sourceId === 'workspace')).toEqual([
        { sourceId: 'workspace', profiles: ['local-agent'] },
      ]);
      expect(fixture.profileRegistry.entries().find((entry) => entry.sourceId === 'workspace')?.contextKey)
        .toBe(`local\0${fixture.localRoot}`);

      await local.git.status();
      expect(fixture.localGitCalls).toEqual([fixture.localRoot]);

      const listed = await local.fs.list({ path: '.', depth: 1, limit: 100, show_hidden: false, follow_gitignore: false, sort: 'name_asc', include_git_status: false });
      expect(listed.items.map((entry) => entry.name)).toContain('AGENTS.md');
    } finally {
      await fixture.cleanup();
    }
  });

  it('roots a pinned workdir at the session cwd while user config stays local', async () => {
    const fixture = await localityFixture();
    try {
      await awaitLocality(fixture.local());
      const localProfilesBefore = fixture.profileRegistrations.length;
      const remote = await fixture.workdir(fixture.remoteRoot);
      await awaitWorkdir(remote);
      const remoteProfiles = fixture.profileRegistrations.slice(localProfilesBefore);

      const agentsMd = remote.instructions.snapshot.agentsMd ?? '';
      expect(agentsMd).toContain('target project instructions');
      expect(agentsMd).toContain('user instructions');
      expect(agentsMd).not.toContain('local project instructions');
      expect(agentsMd).not.toContain('remote user instructions');
      const instructionPaths = remote.instructions.snapshot.agentsMdPaths ?? [];
      expect(instructionPaths).toContain(join(fixture.remoteRoot, 'AGENTS.md'));
      expect(instructionPaths).not.toContain(join(fixture.localRoot, 'AGENTS.md'));

      expect(remote.skills.catalog.listSkills().map((skill) => skill.name)).toEqual(['target-skill', 'user-skill']);
      expect(remote.dirs.additionalDirs).toEqual([join(fixture.remoteRoot, 'targetextra')]);
      expect(remoteProfiles).toEqual([{ sourceId: 'workspace', profiles: ['target-agent'] }]);
      expect(remote.contextKey).toBe(`local\0${fixture.remoteRoot}\0pinned`);
      expect(fixture.profileRegistry.entries().some((entry) => entry.contextKey === remote.contextKey)).toBe(true);

      const listed = await remote.fs.list({ path: '.', depth: 1, limit: 100, show_hidden: false, follow_gitignore: false, sort: 'name_asc', include_git_status: false });
      expect(listed.items.map((entry) => entry.name)).toContain('AGENTS.md');
      expect(fixture.localGitCalls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('loads pinned parent project instructions alongside local personal instructions from a subdirectory', async () => {
    const fixture = await localityFixture();
    try {
      const cwd = join(fixture.remoteRoot, 'src');
      await mkdir(cwd);
      const remote = await fixture.workdir(cwd);
      await awaitWorkdir(remote);
      const instructions = remote.instructions.sessionProvider();
      expect(instructions.agentsMd).toContain('target project instructions');
      expect(instructions.agentsMd).toContain('user instructions');
      expect(instructions.agentsMd).not.toContain('local project instructions');
      expect(instructions.agentsMdPaths).toContain(join(fixture.remoteRoot, 'AGENTS.md'));
    } finally {
      await fixture.cleanup();
    }
  });

  it('expands an additional dir against the local home', async () => {
    const fixture = await localityFixture({ remoteCwd: undefined });
    try {
      await mkdir(join(fixture.remoteHomeDir, 'shared'), { recursive: true });
      await mkdir(join(fixture.homeDir, 'shared'), { recursive: true });
      await writeFile(
        join(fixture.remoteRoot, '.kimi-code', 'local.toml'),
        '[workspace]\nadditional_dir = ["~/shared"]\n',
      );
      const remote = await fixture.workdir(fixture.remoteRoot);
      await awaitWorkdir(remote);
      expect(remote.dirs.additionalDirs).toEqual([join(fixture.homeDir, 'shared')]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('separates pinned and primary-following local workdirs for the same cwd', async () => {
    const fixture = await localityFixture();
    try {
      const pinnedRoot = join(fixture.localRoot, 'pinned');
      await mkdir(pinnedRoot);
      await writeFile(join(pinnedRoot, 'AGENTS.md'), 'pinned project instructions');
      const following = await fixture.workdir(pinnedRoot, true);
      const pinned = await fixture.workdir(pinnedRoot, false);
      await Promise.all([awaitWorkdir(following), awaitWorkdir(pinned)]);

      expect(following.contextKey).not.toBe(pinned.contextKey);
      expect(following.dirs.primary).toBe(fixture.localRoot);
      expect(pinned.dirs.primary).toBe(pinnedRoot);
      expect(following.instructions.snapshot.agentsMd).toContain('local project instructions');
      expect(following.instructions.snapshot.agentsMd).not.toContain('pinned project instructions');
      expect(pinned.instructions.snapshot.agentsMd).toContain('pinned project instructions');
      expect(pinned.instructions.snapshot.agentsMd).not.toContain('local project instructions');
    } finally {
      await fixture.cleanup();
    }
  });

  it('roots each workdir at its own cwd and shares one workdir per cwd', async () => {
    const fixture = await localityFixture({ remoteCwd: undefined });
    try {
      await awaitLocality(fixture.local());
      const target = await fixture.workdir(fixture.remoteRoot);
      const shared = await fixture.workdir(fixture.remoteRoot);
      const alt = await fixture.workdir(fixture.remoteAltRoot);
      await awaitWorkdir(target);
      await awaitWorkdir(alt);

      expect(shared.instructions).toBe(target.instructions);
      expect(alt.instructions).not.toBe(target.instructions);
      expect(target.instructions.snapshot.agentsMd).toContain('target project instructions');
      expect(target.instructions.snapshot.agentsMd).not.toContain('alt project instructions');
      expect(target.dirs.additionalDirs).toEqual([join(fixture.remoteRoot, 'targetextra')]);

      expect(alt.instructions.snapshot.agentsMd).toContain('alt project instructions');
      expect(alt.instructions.snapshot.agentsMd).not.toContain('target project instructions');
      expect(alt.dirs.additionalDirs).toEqual([join(fixture.remoteAltRoot, 'altextra')]);

      target.dispose();
      expect((await fixture.workdir(fixture.remoteRoot)).instructions).toBe(shared.instructions);
      shared.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  it('rebuilds a workdir once every holder released it', async () => {
    const fixture = await localityFixture({ remoteCwd: undefined });
    try {
      const first = await fixture.workdir(fixture.remoteRoot);
      await awaitWorkdir(first);
      first.dispose();
      const second = await fixture.workdir(fixture.remoteRoot);
      await awaitWorkdir(second);
      expect(second.instructions).not.toBe(first.instructions);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reloads pinned workdirs together with the workspace root', async () => {
    const fixture = await localityFixture();
    try {
      await awaitLocality(fixture.local());
      const remote = await fixture.workdir(fixture.remoteRoot);
      await awaitWorkdir(remote);
      await writeFile(join(fixture.remoteRoot, 'AGENTS.md'), 'updated target instructions');
      await writeFile(join(fixture.localRoot, 'AGENTS.md'), 'updated local instructions');

      await fixture.program.reload();

      expect(remote.instructions.snapshot.agentsMd).toContain('updated target instructions');
      expect(fixture.local().instructions.snapshot.agentsMd).toContain('updated local instructions');
    } finally {
      await fixture.cleanup();
    }
  });
});
