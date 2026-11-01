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
import type { IEnvironmentService } from '#/app/environment/environment';
import { Program, type ProgramWorkdir } from '#/program/program';
import type { ProgramSessionControllerInput } from '#/program/programDependencies';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { environmentBindingId } from '#/environment/environment';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import { FileSkillDiscovery } from '#/features/skill/catalog/fileSkillDiscovery';
import { UserFileSkillSource } from '#/features/skill/catalog/userFileSkillSource';
import { fakeEnvironment } from '../environment/stubs';
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

function setup(readiness = new Map<string, Promise<void>>(), order: string[] = []) {
  const registry = Object.assign(new EnvironmentRegistry(), {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    addProvider: vi.fn(async () => ({ dispose: async () => {} })),
  });
  const controllerInputs: ProgramSessionControllerInput[] = [];
  const program = new Program(
    'workspace',
    registry as unknown as IEnvironmentService,
    programWorkspace('/workspace'),
    {
      agentProfiles: { entries: () => [] },
      createSessionController: (input: ProgramSessionControllerInput) => {
        controllerInputs.push(input);
        return { dispose: input.onDispose } as never;
      },
    } as never,
  );
  const create = vi.fn(() => {
    const lease = registry.acquire({ environmentId: 'local' }, ['fs', 'process']);
    const id = lease.environment.identity.generation;
    lease.dispose();
    const behavior = {
      ready: readiness.get(id) ?? Promise.resolve(),
      reload: async () => {},
      dispose: () => { order.push(`behavior:${id}`); },
    };
    const catalog = {
      listSkills: () => [],
      listInvocableSkills: () => [],
      getSkippedByPolicy: () => [],
      getSkillRoots: () => [],
    };
    const root = {
      state: behavior,
      dirs: behavior,
      fs: behavior,
      git: behavior,
      instructions: { ...behavior, snapshot: {} },
      skills: { ...behavior, catalog },
      agentProfiles: behavior,
    };
    return {
      id,
      workdirs: { root, reload: async () => {}, dispose: () => {} },
      mcpConfig: { ...behavior, servers: () => ({}) },
      mcp: behavior,
      trust: { ...behavior, isTrusted: () => false },
      userAgentProfiles: behavior,
      pluginAgentProfiles: behavior,
      explicitAgentProfiles: behavior,
      extraAgentProfiles: behavior,
      disposables: [behavior],
      ready: false,
      failed: false,
      references: 1,
      retired: false,
    };
  });
  (program as unknown as { createGeneration: typeof create }).createGeneration = create;
  return { registry, program, create, controllerInputs };
}

describe('Program', () => {
  it('acquires only available local generations and recovers after reconnect', async () => {
    const { registry, program, create } = setup();
    const current = fakeEnvironment('local', 'one', { status: 'disconnected' });
    registry.register(current);
    expect(create).toHaveBeenCalledTimes(1);
    expect(program.status).toBe('degraded');
    expect(() => program.dirs).toThrow('no available local environment generation');

    current.setStatus('ready');
    await program.ready;
    expect(create).toHaveBeenCalledTimes(2);
    expect(program.sessionControllerGeneration).toBe('one');
    expect(program.status).toBe('ready');
    await program.dispose();
    await registry.dispose();
  });

  it('stays preparing until the fixed local generation behavior becomes ready', async () => {
    const pending = deferred();
    const { registry, program } = setup(new Map([['one', pending.promise]]));
    registry.register(fakeEnvironment('local', 'one'));

    expect(program.binding).toEqual({ environmentId: 'local' });
    expect(program.status).toBe('preparing');
    expect(program.snapshot().ready).toBe(false);

    pending.resolve();
    await program.ready;
    await Promise.resolve();
    expect(program.status).toBe('ready');
    expect(program.snapshot().ready).toBe(true);
    await program.dispose();
    await registry.dispose();
  });

  it('marks rejected behavior readiness degraded', async () => {
    const failed = deferred();
    const { registry, program } = setup(new Map([['one', failed.promise]]));
    registry.register(fakeEnvironment('local', 'one'));
    failed.reject(new Error('failed'));
    await program.ready;
    await Promise.resolve();
    expect(program.status).toBe('degraded');
    await program.dispose();
    await registry.dispose();
  });

  it('stops serving new sessions from the previous generation when its successor is unavailable', async () => {
    const order: string[] = [];
    const { registry, program, create } = setup(new Map(), order);
    const first = fakeEnvironment('local', 'one');
    const registration = registry.register(first);
    await program.ready;
    const controller = program.createSessionController();
    expect(program.sessionControllerGeneration).toBe('one');

    const second = fakeEnvironment('local', 'two', { status: 'disconnected' });
    await registration.remove();
    registry.register(second);
    await Promise.resolve();

    expect(create).toHaveBeenCalledTimes(2);
    expect(() => program.sessionControllerGeneration).toThrow('no available local environment generation');
    expect(() => program.createSessionController()).toThrow('no available local environment generation');
    expect(order).toEqual([]);

    second.setStatus('ready');
    await vi.waitFor(() => {
      expect(program.sessionControllerGeneration).toBe('two');
    });
    const next = program.createSessionController();
    expect(create).toHaveBeenCalledTimes(3);

    controller.dispose();
    expect(order).toEqual(['behavior:one']);
    next.dispose();
    await program.dispose();
    await registry.dispose();
  });

  it('owns catalog, instructions, MCP, provenance, and current environment in one generation', async () => {
    const { registry, program, create } = setup();
    registry.register(fakeEnvironment('local', 'one'));
    const generation = create.mock.results[0]?.value as unknown as {
      workdirs: { root: {
        skills: { catalog: {
          listSkills(): unknown[];
          listInvocableSkills(): unknown[];
          getSkippedByPolicy(): unknown[];
          getSkillRoots(): string[];
        } };
        instructions: { snapshot: { agentsMdPaths?: readonly string[] } };
      } };
      mcpConfig: { servers(): Record<string, unknown> };
      mcp: unknown;
    };
    const skill = { source: 'workspace' };
    generation.workdirs.root.skills.catalog.listSkills = () => [skill];
    generation.workdirs.root.skills.catalog.listInvocableSkills = () => [skill];
    generation.workdirs.root.skills.catalog.getSkippedByPolicy = () => [];
    generation.workdirs.root.skills.catalog.getSkillRoots = () => ['/workspace/.agents/skills'];
    generation.workdirs.root.instructions.snapshot = { agentsMdPaths: ['/workspace/AGENTS.md'] };
    generation.mcpConfig.servers = () => ({ baseline: {} });
    await program.ready;
    await Promise.resolve();

    expect(program.skills).toBe(generation.workdirs.root.skills);
    expect(program.instructions).toBe(generation.workdirs.root.instructions);
    expect(program.mcpConfig).toBe(generation.mcpConfig);
    expect(program.mcp).toBe(generation.mcp);
    expect(program.snapshot()).toMatchObject({
      workspaceId: 'workspace',
      binding: { environmentId: 'local' },
      status: 'ready',
      ready: true,
      generation: 'one',
      trusted: false,
      catalog: {
        skills: { total: 1, invocable: 1, skipped: 0 },
        agentProfiles: 0,
        mcpServers: 1,
      },
      sources: {
        skills: [{ source: 'workspace', count: 1 }],
        skillRoots: ['/workspace/.agents/skills'],
        agentProfiles: [],
        instructionPaths: ['/workspace/AGENTS.md'],
        mcpServers: ['baseline'],
      },
      environments: [{ environmentId: 'local', generation: 'one', status: 'ready' }],
    });

    await program.dispose();
    await registry.dispose();
  });

  it('switches generations and disposes behavior of the replaced one', async () => {
    const firstReady = deferred();
    const order: string[] = [];
    const { registry, program } = setup(new Map([['one', firstReady.promise]]), order);
    const registration = registry.register(fakeEnvironment('local', 'one'));
    await registration.remove();
    registry.register(fakeEnvironment('local', 'two'));
    await Promise.resolve();
    expect(program.sessionControllerGeneration).toBe('two');
    await vi.waitFor(() => {
      expect(program.status).toBe('ready');
    });
    expect(order).toEqual(['behavior:one']);

    firstReady.resolve();
    await Promise.resolve();
    expect(program.sessionControllerGeneration).toBe('two');
    expect(program.status).toBe('ready');
    await program.dispose();
    expect(order).toEqual(['behavior:one', 'behavior:two']);
    await registry.dispose();
  });

  it('ignores non-local environments so remote churn never rebuilds the workspace generation', async () => {
    const { registry, program, create } = setup();
    registry.register(fakeEnvironment('local', 'one'));
    const remote = registry.register(fakeEnvironment('remote', 'remote-one'));
    await remote.remove();
    expect(create).toHaveBeenCalledTimes(1);
    expect(program.sessionControllerGeneration).toBe('one');
    await program.dispose();
    await registry.dispose();
  });
});

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
  readonly registry: EnvironmentRegistry;
  readonly program: Program;
  readonly local: () => GenerationAccess;
  readonly workdir: (cwd: string) => Promise<ProgramWorkdir>;
  readonly controllerInputs: ProgramSessionControllerInput[];
  readonly profileRegistry: AgentProfileRegistryService;
  readonly profileRegistrations: { readonly sourceId: string; readonly profiles: readonly string[] }[];
  readonly localGitCalls: string[];
  readonly localRoot: string;
  readonly remoteRoot: string;
  readonly remoteAltRoot: string;
  readonly homeDir: string;
  readonly remoteHomeDir: string;
  readonly replaceLocal: (generation: string) => Promise<void>;
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
    writeBytes: (path, data) => { assert(path); return inner.writeBytes(path, data); },
    readLines: (path, options) => { assert(path); return inner.readLines(path, options); },
    createExclusive: (path, data) => { assert(path); return inner.createExclusive(path, data); },
    stat: (path) => { assert(path); return inner.stat(path); },
    lstat: inner.lstat.bind(inner),
    readdir: (path) => { assert(path); return inner.readdir(path); },
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

  const registry = new EnvironmentRegistry();
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
    registry as unknown as IEnvironmentService,
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
      oauth: { onEvent: () => () => {} },
      configStore: { onDidWrite: () => ({ dispose: () => {} }) },
      plugins: {
        enabledMcpServers: async () => ({}),
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
        return { dispose: input.onDispose } as never;
      },
    } as never,
  );

  const realFs = new HostFileSystem();
  const localFs = scopedFs(localRoot, await realpath(localRoot), realFs, [homeDir, await realpath(homeDir)]);
  const localRegistration = registry.register(Object.assign(
    new FakeEnvironment(
      { environmentId: 'local', generation: 'local-one' },
      { capabilities: ['fs', 'process'], host: { homeDir } },
    ),
    { fs: localFs, process: new HostProcessService() },
  ) as FakeEnvironment);
  const remoteRegistration = registry.register(Object.assign(
    new FakeEnvironment(
      { environmentId: 'remote', generation: 'remote-one' },
      { capabilities: ['fs', 'process'], host: { homeDir: remoteHomeDir } },
    ),
    remoteCwd === undefined
      ? { fs: realFs, process: new HostProcessService() }
      : { fs: scopedFs(remoteRoot, await realpath(remoteRoot), realFs), process: new HostProcessService() },
  ) as FakeEnvironment);

  const local = (): GenerationAccess => {
    const generation = (program as unknown as {
      generation: { workdirs: { root: GenerationAccess }; mcpConfig: IWorkspaceMcpConfigService; userAgentProfiles: IUserAgentProfileLoader };
    }).generation;
    return { ...generation.workdirs.root, mcpConfig: generation.mcpConfig, userAgentProfiles: generation.userAgentProfiles };
  };
  const workdirs: ProgramWorkdir[] = [];
  let controller: { dispose(): void } | undefined;
  const workdir = async (cwd: string): Promise<ProgramWorkdir> => {
    controller ??= program.createSessionController();
    const created = await controllerInputs[0]!.acquireWorkdir('remote', cwd);
    workdirs.push(created);
    return created;
  };
  return {
    registry,
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
    replaceLocal: async (generation: string) => {
      await localRegistration.remove();
      registry.register(Object.assign(
        new FakeEnvironment(
          { environmentId: 'local', generation },
          { capabilities: ['fs', 'process'], host: { homeDir } },
        ),
        { fs: realFs, process: new HostProcessService() },
      ) as FakeEnvironment);
    },
    cleanup: async () => {
      await Promise.allSettled([awaitLocality(local()), ...workdirs.map((created) => awaitWorkdir(created))]);
      for (const created of workdirs) created.dispose();
      controller?.dispose();
      await program.dispose();
      userSkills.dispose();
      profileContainer.dispose();
      trustStore.dispose();
      await registry.dispose();
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

describe('Program local generation and remote workdirs', () => {
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
        .toBe(environmentBindingId('local', fixture.localRoot));

      await local.git.status();
      expect(fixture.localGitCalls).toEqual([fixture.localRoot]);

      const listed = await local.fs.list({ path: '.', depth: 1, limit: 100, show_hidden: false, follow_gitignore: false, sort: 'name_asc', include_git_status: false });
      expect(listed.items.map((entry) => entry.name)).toContain('AGENTS.md');
    } finally {
      await fixture.cleanup();
    }
  });

  it('roots a remote workdir at the session cwd on the target fs while user config and profiles stay local', async () => {
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
      expect(remoteProfiles).toEqual([]);
      expect(remote.contextKey).toBe(environmentBindingId('remote', fixture.remoteRoot));
      expect(fixture.profileRegistry.entries().some((entry) => entry.contextKey === remote.contextKey)).toBe(false);

      const listed = await remote.fs.list({ path: '.', depth: 1, limit: 100, show_hidden: false, follow_gitignore: false, sort: 'name_asc', include_git_status: false });
      expect(listed.items.map((entry) => entry.name)).toContain('AGENTS.md');
      expect(fixture.localGitCalls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('loads remote parent project instructions alongside local personal instructions from a subdirectory', async () => {
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

  it('expands a remote additional dir against the target home', async () => {
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
      expect(remote.dirs.additionalDirs).toEqual([join(fixture.remoteHomeDir, 'shared')]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('roots each workdir at its own cwd and shares one workdir per environment and cwd', async () => {
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

  it('refreshes a shared remote workdir for every new holder because the target cannot be watched', async () => {
    const fixture = await localityFixture();
    try {
      const first = await fixture.workdir(fixture.remoteRoot);
      await awaitWorkdir(first);
      await writeFile(join(fixture.remoteRoot, 'AGENTS.md'), 'edited target instructions');
      expect(first.instructions.snapshot.agentsMd).toContain('target project instructions');

      const second = await fixture.workdir(fixture.remoteRoot);

      expect(second.instructions).toBe(first.instructions);
      expect(second.instructions.snapshot.agentsMd).toContain('edited target instructions');
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

  it('reloads remote workdirs together with the workspace root', async () => {
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
