import { directoryKey } from '#/_base/utils/paths';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { ProjectPermissionRulesService } from '#/agent/permissionRules/projectPermissionRulesService';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
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
import { cwdStdioFixture } from '../mcpCore/stubs';
import { noopLogger } from '../wire/stubs';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
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
      mcpConfig: { ...behavior, servers: () => ({}) },
      mcp: behavior,
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
      workdirs: { root, currentRoot: root, reload: async () => {}, dispose: () => {} },
      trust: { ...behavior, isTrusted: () => false },
      userAgentProfiles: behavior,
      pluginAgentProfiles: behavior,
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
        mcpConfig: { servers(): Record<string, unknown> };
        mcp: unknown;
      } };
    };
    const skill = { source: 'workspace' };
    generation.workdirs.root.skills.catalog.listSkills = () => [skill];
    generation.workdirs.root.skills.catalog.listInvocableSkills = () => [skill];
    generation.workdirs.root.skills.catalog.getSkippedByPolicy = () => [];
    generation.workdirs.root.skills.catalog.getSkillRoots = () => ['/workspace/.agents/skills'];
    generation.workdirs.root.instructions.snapshot = { agentsMdPaths: ['/workspace/AGENTS.md'] };
    generation.workdirs.root.mcpConfig.servers = () => ({ baseline: {} });
    await program.ready;
    await Promise.resolve();

    expect(program.skills).toBe(generation.workdirs.root.skills);
    expect(program.instructions).toBe(generation.workdirs.root.instructions);
    expect(program.mcpConfig).toBe(generation.workdirs.root.mcpConfig);
    expect(program.mcp).toBe(generation.workdirs.root.mcp);
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
  readonly workdir: (cwd: string, environmentId?: string) => Promise<ProgramWorkdir>;
  readonly controllerInputs: ProgramSessionControllerInput[];
  readonly profileRegistry: AgentProfileRegistryService;
  readonly profileRegistrations: { readonly sourceId: string; readonly profiles: readonly string[] }[];
  readonly localGitCalls: string[];
  readonly localRoot: string;
  readonly remoteRoot: string;
  readonly remoteAltRoot: string;
  readonly homeDir: string;
  readonly remoteHomeDir: string;
  readonly promote: (cwd: string) => void;
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

async function localityFixture(options: { readonly remoteCwd?: string; readonly relativeResources?: boolean } = {}): Promise<LocalityFixture> {
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

  const docs = new JsonAtomicDocumentStore(new FileStorageService(kimiHome));
  await writeWorkspaceTrust(docs, localRoot, Date.now());

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
  const bootstrap = { _serviceBrand: undefined, homeDir: kimiHome, osHomeDir: homeDir, args: options.relativeResources ? { agentFiles: ['selected.md'], skillDirs: ['explicit-skills'] } : {}, getEnv: () => undefined };
  const config = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: (key: string) => {
      if (!options.relativeResources) return undefined;
      if (key === 'extraAgentDirs') return ['custom-agents'];
      if (key === 'extraSkillDirs') return ['configured'];
      return undefined;
    },
    onDidSectionChange: () => ({ dispose: () => {} }),
  };
  const trustStore = new WorkspaceTrustStore(docs, noopTelemetryService, bootstrap as never, config as never, noopLogger);
  const userSkills = new UserFileSkillSource(
    new FileSkillDiscovery(noopLogger),
    bootstrap as never,
    config as never,
  );
  const projectChange = new Emitter<void>();
  const context = programWorkspace(localRoot);
  let meta = context.meta;
  const program = new Program(
    'workspace',
    registry as unknown as IEnvironmentService,
    { ...context, get meta() { return meta; }, onDidChangeProject: projectChange.event },
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
        now: () => Date.now(),
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

  const local = (): GenerationAccess => ({
    fs: program.fs,
    git: program.git,
    mcpConfig: program.mcpConfig,
    instructions: program.instructions,
    skills: program.skills,
    dirs: program.dirs,
    agentProfiles: program.agentProfiles,
    userAgentProfiles: program.userAgentProfiles,
  });
  const workdirs: ProgramWorkdir[] = [];
  let controller: { dispose(): void } | undefined;
  const workdir = async (cwd: string, environmentId = 'remote'): Promise<ProgramWorkdir> => {
    controller ??= program.createSessionController();
    const created = await controllerInputs[0]!.acquireWorkdir(environmentId, cwd);
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
    promote: (cwd) => {
      meta = { ...meta, root: cwd };
      projectChange.fire();
    },
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
      projectChange.dispose();
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
        .toBe(environmentBindingId('local', directoryKey(fixture.localRoot)));

      await local.git.status();
      expect(fixture.localGitCalls).toEqual([fixture.localRoot]);

      const listed = await local.fs.list({ path: '.', depth: 1, limit: 100, show_hidden: false, follow_gitignore: false, sort: 'name_asc', include_git_status: false });
      expect(listed.items.map((entry) => entry.name)).toContain('AGENTS.md');
    } finally {
      await fixture.cleanup();
    }
  });

  it('resolves explicit and configured resources inside each local workdir', async () => {
    const fixture = await localityFixture({ relativeResources: true });
    try {
      for (const name of ['first', 'second']) {
        const cwd = join(fixture.localRoot, name);
        for (const source of ['explicit-skills', 'configured']) {
          const skill = `${name}-${source}`;
          const folder = join(cwd, source, skill);
          await mkdir(folder, { recursive: true });
          await writeFile(join(folder, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${skill}\n---\nBody`);
        }
        const profile = (source: string) => `---\nname: ${name}-${source}\ndescription: Test profile\n---\n\nUse this profile.\n`;
        await writeFile(join(cwd, 'selected.md'), profile('selected'));
        await mkdir(join(cwd, 'custom-agents'));
        await writeFile(join(cwd, 'custom-agents', 'agent.md'), profile('extra'));
        const view = await fixture.workdir(cwd, 'local');
        await Promise.all([view.agentProfiles.ready, view.skills.ready]);
        expect(view.skills.catalog.listSkills().map((skill) => skill.name)).toEqual(expect.arrayContaining([
          `${name}-explicit-skills`, `${name}-configured`,
        ]));
        const sources = fixture.profileRegistry.entries().filter((entry) => entry.contextKey === view.contextKey);
        expect(sources.flatMap((entry) => entry.contribution.profiles.map((profile) => profile.name)).toSorted())
          .toEqual([`${name}-extra`, `${name}-selected`]);
      }
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
      expect(remoteProfiles.toSorted((a, b) => a.sourceId.localeCompare(b.sourceId))).toEqual([
        { sourceId: 'explicit', profiles: [] },
        { sourceId: 'extra', profiles: [] },
      ]);
      expect(remote.contextKey).toBe(environmentBindingId('remote', fixture.remoteRoot));
      expect(fixture.profileRegistry.entries().filter((entry) => entry.contextKey === remote.contextKey)
        .map((entry) => entry.sourceId).toSorted()).toEqual(['explicit', 'extra']);

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

  it('isolates instructions, permission rules and live MCP connections in two linked checkouts', async () => {
    vi.stubEnv('KIMI_CODE_WATCH', 'true');
    const fixture = await localityFixture();
    const checkout = (name: string) => join(fixture.localRoot, name);
    const cwd = (name: string) => join(checkout(name), 'src');
    const server = { command: process.execPath, args: [cwdStdioFixture] };
    const permissions: ProjectPermissionRulesService[] = [];
    const rulesFor = (view: ProgramWorkdir) => {
      const session = { cwd: view.dirs.primary } as ISessionContext;
      const workdir = { _serviceBrand: undefined, environmentId: 'local', cwd: session.cwd, dirs: view.dirs, fs: view.fs };
      const rules = new ProjectPermissionRulesService(session, workdir, view.localConfig, fixture.program.trust);
      permissions.push(rules);
      return rules;
    };
    const localConfig = (pattern: string) =>
      `[workspace]\nadditional_dir = ["extra"]\n[[permission.rules]]\ndecision = "allow"\npattern = "${pattern}"\n`;
    const callCwd = async (view: ProgramWorkdir, name: string) => {
      await view.mcp.ready;
      const connection = view.mcp.connectionManager().resolved(name);
      expect(connection).toBeDefined();
      return (await connection!.client.callTool('get_cwd', {})).content[0];
    };
    try {
      await writeFile(join(fixture.homeDir, '.kimi-code', 'mcp.json'), '{}');
      await execFileAsync('git', ['init', '-b', 'main', checkout('one')]);
      await execFileAsync('git', ['-C', checkout('one'), '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--no-gpg-sign', '--allow-empty', '-m', 'initial']);
      await execFileAsync('git', ['-C', checkout('one'), 'worktree', 'add', '--detach', checkout('two'), 'HEAD']);
      const views = await Promise.all(['one', 'two'].map(async (name) => {
        await mkdir(join(checkout(name), '.kimi-code'));
        await mkdir(join(cwd(name), '.kimi-code'), { recursive: true });
        await mkdir(join(checkout(name), 'extra'));
        await writeFile(join(checkout(name), 'AGENTS.md'), name);
        await writeFile(join(checkout(name), '.kimi-code', 'local.toml'), localConfig(`Bash(${name} *)`));
        await writeFile(join(checkout(name), '.mcp.json'), JSON.stringify({ mcpServers: { repo: server } }));
        await writeFile(join(cwd(name), '.kimi-code', 'mcp.json'), JSON.stringify({ mcpServers: { shared: { ...server, env: { CHECKOUT: name } } } }));
        return fixture.workdir(cwd(name), 'local');
      }));
      for (const [index, name] of ['one', 'two'].entries()) {
        const view = views[index]!;
        await awaitWorkdir(view);
        const rules = rulesFor(view);
        await rules.ready;
        expect(rules.rules).toEqual([{ decision: 'allow', scope: 'project', pattern: `Bash(${name} *)` }]);
        expect(view.instructions.snapshot.agentsMd).toContain(name);
        expect(view.dirs.additionalDirs).toEqual([join(checkout(name), 'extra')]);
        expect(await callCwd(view, 'shared')).toEqual({ type: 'text', text: await realpath(cwd(name)) });
        expect(await callCwd(view, 'repo')).toEqual({ type: 'text', text: await realpath(checkout(name)) });
        expect(view.mcpConfig.servers()['shared']).toMatchObject({ env: { CHECKOUT: name } });
      }
      const [one, two] = views;
      await writeFile(join(checkout('one'), '.kimi-code', 'local.toml'), localConfig('Write'));
      await vi.waitFor(() => expect(permissions[0]!.rules[0]?.pattern).toBe('Write'));
      expect(permissions[1]!.rules[0]?.pattern).toBe('Bash(two *)');
      await one!.dirs.mergeAdditionalDirs(checkout('one'), ['.kimi-code']);
      expect(two!.dirs.additionalDirs).toEqual([join(checkout('two'), 'extra')]);
      const oldConnections = one!.mcp.connectionManager();
      permissions[0]!.dispose();
      one!.dispose();
      expect(oldConnections.resolved('shared')).toBeUndefined();
      expect(await callCwd(two!, 'shared')).toEqual({ type: 'text', text: await realpath(cwd('two')) });

      const reopened = await fixture.workdir(cwd('one'), 'local');
      expect(await callCwd(reopened, 'shared')).toEqual({ type: 'text', text: await realpath(cwd('one')) });
      const reopenedRules = rulesFor(reopened);
      await reopenedRules.ready;
      expect(reopenedRules.rules[0]?.pattern).toBe('Write');
      await fixture.program.trust.untrust();
      await Promise.all([reopenedRules.refreshTrust(), permissions[1]!.refreshTrust()]);
      expect(reopenedRules.rules).toEqual([]);
      expect(permissions[1]!.rules).toEqual([]);
      await vi.waitFor(() => {
        expect(reopened.mcp.connectionManager().resolved('shared')).toBeUndefined();
        expect(two!.mcp.connectionManager().resolved('shared')).toBeUndefined();
      });
    } finally {
      for (const rules of permissions) rules.dispose();
      await fixture.cleanup();
    }
  });

  it('keeps a remote session’s host MCP connection until the session closes after a project primary change', async () => {
    const fixture = await localityFixture();
    try {
      const promoted = join(fixture.localRoot, 'promoted');
      await mkdir(promoted);
      await writeFile(join(fixture.localRoot, '.mcp.json'), '{}');
      const server = { command: process.execPath, args: [cwdStdioFixture] };
      await writeFile(join(fixture.homeDir, '.kimi-code', 'mcp.json'), JSON.stringify({ mcpServers: { user: server } }));
      const remote = await fixture.workdir(fixture.remoteRoot);
      const handle = remote.mcp.sessionHandle();
      await handle.ready;
      const connection = handle.connectionManager.resolved('user');
      expect(connection).toBeDefined();
      fixture.promote(promoted);
      expect(fixture.program.dirs.primary).toBe(promoted);
      expect(handle.connectionManager.resolved('user')?.client).toBe(connection!.client);
      expect((await connection!.client.callTool('get_cwd', {})).content[0]).toEqual({ type: 'text', text: await realpath(fixture.localRoot) });
      remote.dispose();
      expect(handle.connectionManager.list()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('opens a valid workdir when the default directory has an invalid local.toml', async () => {
    const fixture = await localityFixture();
    try {
      const invalidFile = join(fixture.localRoot, '.kimi-code', 'local.toml');
      await writeFile(invalidFile, '[workspace');
      const cwd = join(fixture.localRoot, 'valid');
      await mkdir(cwd);
      await writeFile(join(cwd, 'AGENTS.md'), 'valid workdir instructions');
      const valid = await fixture.workdir(cwd, 'local');
      await awaitWorkdir(valid);
      const invalid = await fixture.workdir(fixture.localRoot, 'local');
      await expect(invalid.dirs.ready).rejects.toThrow(invalidFile);
      expect(valid.instructions.snapshot.agentsMd).toContain('valid workdir instructions');
    } finally {
      await fixture.cleanup();
    }
  });

  it('shares local configuration for the same cwd and keeps other directories independent', async () => {
    const fixture = await localityFixture();
    try {
      const cwd = join(fixture.localRoot, 'pinned');
      await mkdir(cwd);
      await writeFile(join(cwd, 'AGENTS.md'), 'pinned project instructions');
      const first = await fixture.workdir(cwd, 'local');
      const second = await fixture.workdir(cwd, 'local');
      const root = await fixture.workdir(fixture.localRoot, 'local');
      await Promise.all([awaitWorkdir(first), awaitWorkdir(second), awaitWorkdir(root)]);
      expect(first.contextKey).toBe(second.contextKey);
      expect(first.instructions).toBe(second.instructions);
      expect(first.dirs.primary).toBe(cwd);
      expect(root.instructions.snapshot.agentsMd).toContain('local project instructions');
      expect(root.instructions.snapshot.agentsMd).not.toContain('pinned project instructions');
      expect(first.instructions.snapshot.agentsMd).toContain('pinned project instructions');
      expect(first.instructions.snapshot.agentsMd).not.toContain('local project instructions');
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
