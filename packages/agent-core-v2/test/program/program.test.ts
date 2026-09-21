import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { Event } from '#/_base/event';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { Program } from '#/program/program';
import type { ProgramSessionControllerInput } from '#/program/programDependencies';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import { FileSkillDiscovery } from '#/features/skill/catalog/fileSkillDiscovery';
import { UserFileSkillSource } from '#/features/skill/catalog/userFileSkillSource';
import { fakeEnvironment } from '../environment/stubs';
import { noopLogger } from '../wire/stubs';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { writeWorkspaceTrust } from '#/workspace/workspaceTrust/trustRecord';
import type { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import type { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';
import type { IWorkspaceGitService } from '#/workspace/workspaceGit/workspaceGit';
import type { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import type { IWorkspaceMcpConfigService } from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import type { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import type { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';

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
      createdAt: 0,
      lastOpenedAt: 0,
    },
    persistenceScope: 'sessions/workspace',
  };
}

function setup(readiness = new Map<string, Promise<void>>(), order: string[] = []) {
  const registry = new EnvironmentRegistry('workspace', 50);
  const controllerInputs: ProgramSessionControllerInput[] = [];
  const program = new Program(
    'workspace',
    registry,
    programWorkspace('/workspace'),
    {
      agentProfiles: { entries: () => [] },
      createSessionController: (input: ProgramSessionControllerInput) => {
        controllerInputs.push(input);
        return { dispose: input.onDispose } as never;
      },
    } as never,
  );
  const create = vi.fn((environmentId: string) => {
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId }, ['fs', 'process']);
    const id = lease.environment.identity.generation;
    const behavior = {
      ready: readiness.get(id) ?? Promise.resolve(),
      dispose: () => { order.push(`behavior:${id}`); },
    };
    const catalog = {
      listSkills: () => [],
      listInvocableSkills: () => [],
      getSkippedByPolicy: () => [],
      getSkillRoots: () => [],
    };
    return {
      id,
      lease,
      state: behavior,
      dirs: behavior,
      fs: behavior,
      git: behavior,
      instructions: { ...behavior, snapshot: {} },
      mcpConfig: { ...behavior, servers: () => ({}) },
      mcp: behavior,
      trust: { ...behavior, isTrusted: () => false },
      skills: { ...behavior, catalog },
      agentProfiles: behavior,
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
    expect(() => program.dirs).toThrow('no available generation for environment local');

    current.setStatus('ready');
    await program.ready;
    expect(create).toHaveBeenCalledTimes(2);
    expect(program.sessionControllerGenerationFor('local')).toBe('one');
    expect(program.status).toBe('ready');
    program.dispose();
    await registry.dispose();
  });

  it('stays preparing until the fixed local generation behavior becomes ready', async () => {
    const pending = deferred();
    const { registry, program } = setup(new Map([['one', pending.promise]]));
    registry.register(fakeEnvironment('local', 'one'));

    expect(program.binding).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
    expect(program.status).toBe('preparing');
    expect(program.snapshot().ready).toBe(false);

    pending.resolve();
    await program.ready;
    await Promise.resolve();
    expect(program.status).toBe('ready');
    expect(program.snapshot().ready).toBe(true);
    program.dispose();
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
    program.dispose();
    await registry.dispose();
  });

  it('retains the replaced generation lease until its session controller is disposed', async () => {
    const { registry, program } = setup();
    const first = fakeEnvironment('local', 'one');
    const registration = registry.register(first);
    await program.ready;
    const controller = program.createSessionController();
    const replacement = registration.replace(fakeEnvironment('local', 'two'));
    await Promise.resolve();
    expect(program.sessionControllerGenerationFor('local')).toBe('two');
    expect(first.disposed).toBe(false);
    controller.dispose();
    await replacement;
    expect(first.disposed).toBe(true);
    program.dispose();
    await registry.dispose();
  });

  it('stops serving new sessions from the previous generation when its replacement is unavailable', async () => {
    const order: string[] = [];
    const { registry, program, create } = setup(new Map(), order);
    const first = fakeEnvironment('local', 'one');
    const registration = registry.register(first);
    await program.ready;
    const controller = program.createSessionController();
    expect(program.sessionControllerGenerationFor('local')).toBe('one');

    const second = fakeEnvironment('local', 'two', { status: 'disconnected' });
    await registration.replace(second);
    await Promise.resolve();

    expect(create).toHaveBeenCalledTimes(3);
    expect(() => program.sessionControllerGenerationFor('local')).toThrow('no available generation for environment local');
    expect(() => program.createSessionController()).toThrow('no available generation for environment local');
    expect(order).toEqual([]);

    second.setStatus('ready');
    await vi.waitFor(() => {
      expect(program.sessionControllerGenerationFor('local')).toBe('two');
    });
    const next = program.createSessionController();
    expect(create).toHaveBeenCalledTimes(4);

    controller.dispose();
    expect(order).toEqual(['behavior:one']);
    next.dispose();
    program.dispose();
    await registry.dispose();
  });

  it('retries a transient replacement failure on the next environment change and recovers', async () => {
    const { registry, program, create } = setup();
    const registration = registry.register(fakeEnvironment('local', 'one'));
    await program.ready;
    expect(program.sessionControllerGenerationFor('local')).toBe('one');

    create.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await registration.replace(fakeEnvironment('local', 'two'));

    await vi.waitFor(() => {
      expect(program.sessionControllerGenerationFor('local')).toBe('two');
    });
    await vi.waitFor(() => {
      expect(program.status).toBe('ready');
    });
    expect(() => program.createSessionController()).not.toThrow();
    program.dispose();
    await registry.dispose();
  });

  it('marks the program degraded and serves no new sessions while the replacement build keeps failing', async () => {
    const { registry, program, create } = setup();
    const registration = registry.register(fakeEnvironment('local', 'one'));
    await program.ready;
    expect(program.status).toBe('ready');

    create.mockImplementation(() => {
      throw new Error('boom');
    });
    await registration.replace(fakeEnvironment('local', 'two'));
    await Promise.resolve();

    expect(program.status).toBe('degraded');
    expect(() => program.sessionControllerGenerationFor('local')).toThrow('no available generation for environment local');
    expect(() => program.createSessionController()).toThrow('no available generation for environment local');
    program.dispose();
    await registry.dispose();
  });

  it('owns catalog, instructions, MCP, provenance, and current environment in one generation', async () => {
    const { registry, program, create } = setup();
    registry.register(fakeEnvironment('local', 'one'));
    const generation = create.mock.results[0]?.value as {
      skills: { catalog: {
        listSkills(): unknown[];
        listInvocableSkills(): unknown[];
        getSkippedByPolicy(): unknown[];
        getSkillRoots(): string[];
      } };
      instructions: { snapshot: { agentsMdPaths?: readonly string[] } };
      mcpConfig: { servers(): Record<string, unknown> };
      mcp: unknown;
    };
    const skill = { source: 'workspace' };
    generation.skills.catalog.listSkills = () => [skill];
    generation.skills.catalog.listInvocableSkills = () => [skill];
    generation.skills.catalog.getSkippedByPolicy = () => [];
    generation.skills.catalog.getSkillRoots = () => ['/workspace/.agents/skills'];
    generation.instructions.snapshot = { agentsMdPaths: ['/workspace/AGENTS.md'] };
    generation.mcpConfig.servers = () => ({ baseline: {} });
    await program.ready;
    await Promise.resolve();

    expect(program.skills).toBe(generation.skills);
    expect(program.instructions).toBe(generation.instructions);
    expect(program.mcpConfig).toBe(generation.mcpConfig);
    expect(program.mcp).toBe(generation.mcp);
    expect(program.snapshot()).toMatchObject({
      workspaceId: 'workspace',
      binding: { workspaceId: 'workspace', environmentId: 'local' },
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

    program.dispose();
    await registry.dispose();
  });

  it('replaces generations atomically and disposes behavior before releasing its lease', async () => {
    const firstReady = deferred();
    const order: string[] = [];
    const { registry, program } = setup(new Map([['one', firstReady.promise]]), order);
    const registration = registry.register(fakeEnvironment('local', 'one'));
    const replacement = registration.replace(fakeEnvironment('local', 'two'));
    await replacement;
    await Promise.resolve();
    expect(program.sessionControllerGenerationFor('local')).toBe('two');
    expect(program.status).toBe('ready');
    expect(order).toEqual(['behavior:one']);

    firstReady.resolve();
    await Promise.resolve();
    expect(program.sessionControllerGenerationFor('local')).toBe('two');
    expect(program.status).toBe('ready');
    program.dispose();
    expect(order).toEqual(['behavior:one', 'behavior:two']);
    await registry.dispose();
  });

  it('isolates generations per environment so same-workspace sessions do not cross project context', async () => {
    const { registry, program, create, controllerInputs } = setup();
    registry.register(fakeEnvironment('local', 'one'));
    registry.register(fakeEnvironment('remote', 'remote-one'));

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toBe('local');

    program.createSessionController();
    expect(create).toHaveBeenCalledTimes(1);

    program.createSessionController('remote');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]).toBe('remote');

    expect(program.sessionControllerGenerationFor('local')).toBe('one');
    expect(program.sessionControllerGenerationFor('remote')).toBe('remote-one');
    expect(controllerInputs).toHaveLength(2);
    expect(controllerInputs[0]).not.toHaveProperty('fs');
    expect(controllerInputs[1]).not.toHaveProperty('fs');

    expect(() => program.sessionControllerGenerationFor('missing')).toThrow(
      'no available generation for environment missing',
    );

    program.dispose();
    await registry.dispose();
  });

  it('retires a remote generation when its environment is removed without touching local', async () => {
    const { registry, program, create } = setup();
    registry.register(fakeEnvironment('local', 'one'));
    const remote = fakeEnvironment('remote', 'remote-one');
    const remoteRegistration = registry.register(remote);
    program.createSessionController('remote');
    expect(program.sessionControllerGenerationFor('remote')).toBe('remote-one');

    await remoteRegistration.remove();
    expect(() => program.sessionControllerGenerationFor('remote')).toThrow(
      'no available generation for environment remote',
    );
    expect(program.sessionControllerGenerationFor('local')).toBe('one');
    expect(create).toHaveBeenCalledTimes(2);

    program.dispose();
    await registry.dispose();
  });
});

function fakeFsEnvironment(environmentId: string, generation: string): FakeEnvironment {
  return Object.assign(
    new FakeEnvironment(
      { workspaceId: 'workspace', environmentId, generation },
      { capabilities: ['fs'] },
    ),
    { fs: new HostFileSystem() },
  ) as FakeEnvironment;
}

function suggestSetup() {
  const registry = new EnvironmentRegistry('workspace', 50);
  const program = new Program(
    'workspace',
    registry,
    programWorkspace('/workspace'),
    {
      agentProfiles: { entries: () => [] },
      createSessionController: () => ({ dispose: () => {} }) as never,
      telemetry: noopTelemetryService,
      git: { current: undefined, onDidChange: () => ({ dispose: () => {} }) },
    } as never,
  );
  (program as unknown as { createGeneration: () => unknown }).createGeneration = () => {
    throw new Error('generations are not exercised by suggestFiles tests');
  };
  return { registry, program };
}

describe('Program.suggestFiles', () => {
  it('suggests files for a environment with the given session roots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-program-suggest-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'app.ts'), 'app');
      await writeFile(join(dir, 'src', 'index.ts'), 'index');
      await writeFile(join(dir, 'README.md'), 'readme');
      const { registry, program } = suggestSetup();
      registry.register(fakeFsEnvironment('local', 'local-one'));

      const result = await program.suggestFiles(
        'local',
        { workDir: dir },
        { query: 'app', limit: 20, follow_gitignore: true, show_hidden: false },
      );

      expect(result.items).toContainEqual(
        expect.objectContaining({ kind: 'file', path: 'src/app.ts', name: 'app.ts' }),
      );
      const topLevel = await program.suggestFiles(
        'local',
        { workDir: dir },
        { query: '', limit: 20, follow_gitignore: true, show_hidden: false },
      );
      expect(topLevel.items).toContainEqual(expect.objectContaining({ kind: 'directory', name: 'src' }));

      program.dispose();
      await registry.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('routes the suggest to the requested environment and rejects an unknown environment', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'kimi-program-suggest-local-'));
    const remoteDir = await mkdtemp(join(tmpdir(), 'kimi-program-suggest-remote-'));
    try {
      await writeFile(join(localDir, 'local-only.ts'), 'local');
      await writeFile(join(remoteDir, 'remote-only.ts'), 'remote');
      const { registry, program } = suggestSetup();
      registry.register(fakeFsEnvironment('local', 'local-one'));
      registry.register(fakeFsEnvironment('remote', 'remote-one'));

      const remoteResult = await program.suggestFiles(
        'remote',
        { workDir: remoteDir },
        { query: 'remote-only', limit: 20, follow_gitignore: true, show_hidden: false },
      );
      expect(remoteResult.items).toContainEqual(
        expect.objectContaining({ kind: 'file', path: 'remote-only.ts', name: 'remote-only.ts' }),
      );

      await expect(
        program.suggestFiles(
          'ghost',
          { workDir: localDir },
          { query: 'a', limit: 20, follow_gitignore: true, show_hidden: false },
        ),
      ).rejects.toThrow(/ghost/);

      program.dispose();
      await registry.dispose();
    } finally {
      await rm(localDir, { recursive: true, force: true });
      await rm(remoteDir, { recursive: true, force: true });
    }
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
  readonly generations: Map<string, GenerationAccess>;
  readonly controllerInputs: ProgramSessionControllerInput[];
  readonly profileRegistrations: { readonly sourceId: string; readonly profiles: readonly string[] }[];
  readonly localGitCalls: string[];
  readonly localRoot: string;
  readonly remoteRoot: string;
  readonly remoteAltRoot: string;
  readonly replaceLocal: (generation: string) => Promise<void>;
  readonly replaceRemote: (generation: string, cwd: string) => Promise<void>;
  readonly cleanup: () => Promise<void>;
}

function generationKey(environmentId: string, cwd?: string): string {
  return cwd === undefined ? environmentId : `${environmentId}\0${cwd}`;
}

function scopedFs(base: string, realBase: string, inner: IHostFileSystem): IHostFileSystem {
  const within = (path: string): boolean =>
    path === base || path.startsWith(`${base}/`) || path === realBase || path.startsWith(`${realBase}/`);
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
    lstat: (path) => { assert(path); return inner.lstat(path); },
    readdir: (path) => { assert(path); return inner.readdir(path); },
    mkdir: (path, options) => { assert(path); return inner.mkdir(path, options); },
    remove: (path) => { assert(path); return inner.remove(path); },
    realpath: (path) => { assert(path); return inner.realpath(path); },
  };
}

async function localityFixture(options: { readonly remoteCwd?: string; readonly drainTimeoutMs?: number } = {}): Promise<LocalityFixture> {
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

  const registry = new EnvironmentRegistry('workspace', options.drainTimeoutMs ?? 50);
  const controllerInputs: ProgramSessionControllerInput[] = [];
  const profileRegistrations: { readonly sourceId: string; readonly profiles: readonly string[] }[] = [];
  const bootstrap = { _serviceBrand: undefined, homeDir: kimiHome, osHomeDir: homeDir, args: {} };
  const config = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: () => undefined,
    onDidSectionChange: () => ({ dispose: () => {} }),
  };
  const userSkills = new UserFileSkillSource(
    new FileSkillDiscovery(noopLogger),
    bootstrap as never,
    config as never,
  );
  const program = new Program(
    'workspace',
    registry,
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
        onDidChange: Event.None,
        entries: () => [],
        register: (registration: { sourceId: string; contribution: { profiles: { name: string }[] } }) => {
          profileRegistrations.push({
            sourceId: registration.sourceId,
            profiles: registration.contribution.profiles.map((profile) => profile.name),
          });
          return { dispose: () => {} };
        },
      },
      builtinAgentProfiles: { getDefault: () => ({ renderSystemPrompt: () => 'default profile' }) },
      builtinSkills: { _serviceBrand: undefined, id: 'builtin', priority: 0, load: async () => ({ skills: [] }) },
      userSkills,
      telemetry: noopTelemetryService,
      docs,
      createSessionController: (input: ProgramSessionControllerInput) => {
        controllerInputs.push(input);
        return { dispose: input.onDispose } as never;
      },
    } as never,
  );

  const realFs = new HostFileSystem();
  const localRegistration = registry.register(Object.assign(
    new FakeEnvironment(
      { workspaceId: 'workspace', environmentId: 'local', generation: 'local-one' },
      { capabilities: ['fs', 'process'], host: { homeDir } },
    ),
    { fs: realFs, process: new HostProcessService() },
  ) as FakeEnvironment);
  const remoteRegistration = registry.register(Object.assign(
    new FakeEnvironment(
      { workspaceId: 'workspace', environmentId: 'remote', generation: 'remote-one' },
      { capabilities: ['fs', 'process'], host: { homeDir: remoteHomeDir } },
    ),
    remoteCwd === undefined
      ? { fs: realFs, process: new HostProcessService() }
      : { fs: scopedFs(remoteRoot, await realpath(remoteRoot), realFs), process: new HostProcessService() },
  ) as FakeEnvironment);

  const generations = (program as unknown as { generations: Map<string, GenerationAccess> }).generations;
  return {
    registry,
    program,
    generations,
    controllerInputs,
    profileRegistrations,
    localGitCalls,
    localRoot,
    remoteRoot,
    remoteAltRoot,
    replaceLocal: async (generation: string) => {
      await localRegistration.replace(Object.assign(
        new FakeEnvironment(
          { workspaceId: 'workspace', environmentId: 'local', generation },
          { capabilities: ['fs', 'process'], host: { homeDir } },
        ),
        { fs: realFs, process: new HostProcessService() },
      ) as FakeEnvironment);
    },
    replaceRemote: async (generation: string, cwd: string) => {
      await remoteRegistration.replace(Object.assign(
        new FakeEnvironment(
          { workspaceId: 'workspace', environmentId: 'remote', generation },
          { capabilities: ['fs', 'process'], host: { homeDir: remoteHomeDir } },
        ),
        { fs: scopedFs(cwd, await realpath(cwd), realFs), process: new HostProcessService() },
      ) as FakeEnvironment);
    },
    cleanup: async () => {
      program.dispose();
      userSkills.dispose();
      await registry.dispose();
      await rm(base, { recursive: true, force: true });
    },
  };
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

describe('Program.createGeneration workspace and user locality', () => {
  it('roots the local generation at the workspace root on the local fs, unchanged', async () => {
    const fixture = await localityFixture();
    try {
      const local = fixture.generations.get('local')!;
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

      await local.git.status();
      expect(fixture.localGitCalls).toEqual([fixture.localRoot]);

      const listed = await local.fs.list({ path: '.', depth: 1, limit: 100, show_hidden: false, follow_gitignore: false, sort: 'name_asc', include_git_status: false });
      expect(listed.items.map((entry) => entry.name)).toContain('AGENTS.md');
    } finally {
      await fixture.cleanup();
    }
  });

  it('roots a remote generation at the session cwd on the target fs while user config stays local', async () => {
    const fixture = await localityFixture();
    try {
      await awaitLocality(fixture.generations.get('local')!);
      const localProfilesBefore = fixture.profileRegistrations.length;
      fixture.program.createSessionController('remote', fixture.remoteRoot);
      const remote = fixture.generations.get(generationKey('remote', fixture.remoteRoot))!;
      await awaitLocality(remote);
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
      expect(Object.keys(remote.mcpConfig.servers()).toSorted()).toEqual(['local-project-server', 'user-server']);
      expect(remoteProfiles.filter((entry) => entry.sourceId === 'workspace')).toEqual([
        { sourceId: 'workspace', profiles: ['target-agent'] },
      ]);
      expect(remoteProfiles.filter((entry) => entry.sourceId === 'user')).toEqual([
        { sourceId: 'user', profiles: ['user-agent'] },
      ]);

      const status = await remote.git.status();
      expect(status.branch).toBe('main');
      expect(fixture.localGitCalls).toEqual([]);

      const listed = await remote.fs.list({ path: '.', depth: 1, limit: 100, show_hidden: false, follow_gitignore: false, sort: 'name_asc', include_git_status: false });
      expect(listed.items.map((entry) => entry.name)).toContain('AGENTS.md');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('Program remote generation activation', () => {
  it('keeps same-environment generations rooted per session cwd', async () => {
    const fixture = await localityFixture({ remoteCwd: undefined });
    try {
      await awaitLocality(fixture.generations.get('local')!);
      fixture.program.createSessionController('remote', fixture.remoteRoot);
      fixture.program.createSessionController('remote', fixture.remoteAltRoot);

      const target = fixture.generations.get(generationKey('remote', fixture.remoteRoot))!;
      const alt = fixture.generations.get(generationKey('remote', fixture.remoteAltRoot))!;
      expect(target).not.toBe(alt);
      await awaitLocality(target);
      await awaitLocality(alt);

      expect(target.instructions.snapshot.agentsMd).toContain('target project instructions');
      expect(target.instructions.snapshot.agentsMd).not.toContain('alt project instructions');
      expect(target.dirs.additionalDirs).toEqual([join(fixture.remoteRoot, 'targetextra')]);

      expect(alt.instructions.snapshot.agentsMd).toContain('alt project instructions');
      expect(alt.instructions.snapshot.agentsMd).not.toContain('target project instructions');
      expect(alt.dirs.additionalDirs).toEqual([join(fixture.remoteAltRoot, 'altextra')]);

      expect(fixture.program.sessionControllerGenerationFor('remote', fixture.remoteRoot)).toBe('remote-one');
      expect(fixture.program.sessionControllerGenerationFor('remote', fixture.remoteAltRoot)).toBe('remote-one');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rebuilds a remote generation at the same session cwd when the environment is replaced', async () => {
    const fixture = await localityFixture();
    try {
      const local = fixture.generations.get('local')!;
      await awaitLocality(local);
      const first = fixture.program.createSessionController('remote', fixture.remoteRoot);
      expect(fixture.program.sessionControllerGenerationFor('remote', fixture.remoteRoot)).toBe('remote-one');
      expect(fixture.controllerInputs).toHaveLength(1);
      const stale = fixture.generations.get(generationKey('remote', fixture.remoteRoot))!;
      await awaitLocality(stale);
      expect(stale.instructions.snapshot.agentsMd).toContain('target project instructions');
      expect(stale.dirs.additionalDirs).toEqual([join(fixture.remoteRoot, 'targetextra')]);

      await fixture.replaceRemote('remote-two', fixture.remoteRoot);

      expect(fixture.program.sessionControllerGenerationFor('remote', fixture.remoteRoot)).toBe('remote-two');
      fixture.program.createSessionController('remote', fixture.remoteRoot);
      expect(fixture.controllerInputs).toHaveLength(2);
      const remote = fixture.generations.get(generationKey('remote', fixture.remoteRoot))!;
      await awaitLocality(remote);

      const agentsMd = remote.instructions.snapshot.agentsMd ?? '';
      expect(agentsMd).toContain('target project instructions');
      expect(agentsMd).not.toContain('local project instructions');
      expect(remote.dirs.additionalDirs).toEqual([join(fixture.remoteRoot, 'targetextra')]);
      expect(remote.skills.catalog.listSkills().map((skill) => skill.name)).toEqual(['target-skill', 'user-skill']);
      expect(fixture.controllerInputs[0]!.instructions).not.toBe(remote.instructions);
      expect(fixture.controllerInputs[1]!.instructions).toBe(remote.instructions);

      expect(local.instructions.snapshot.agentsMd).toContain('local project instructions');
      expect(local.dirs.additionalDirs).toEqual([join(fixture.localRoot, 'localextra')]);
      first.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  it('falls back to the workspace root when a remote controller is requested without a session cwd', async () => {
    const fixture = await localityFixture({ remoteCwd: undefined });
    try {
      fixture.program.createSessionController('remote');
      const remote = fixture.generations.get('remote')!;
      await awaitLocality(remote);

      expect(remote.instructions.snapshot.agentsMd).toContain('local project instructions');
      expect(remote.dirs.additionalDirs).toEqual([join(fixture.localRoot, 'localextra')]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('releases the remote generation lease while no session controller uses it and re-acquires on demand', async () => {
    const fixture = await localityFixture({ drainTimeoutMs: 5_000 });
    try {
      const first = fixture.program.createSessionController('remote', fixture.remoteRoot);
      const replaced = fixture.replaceRemote('remote-two', fixture.remoteRoot);
      const settled = await Promise.race([
        replaced.then(() => 'replaced' as const),
        new Promise<'pending'>((resolve) => {
          setTimeout(() => {
            resolve('pending');
          }, 200);
        }),
      ]);
      expect(settled).toBe('pending');

      first.dispose();
      await replaced;

      const second = fixture.program.createSessionController('remote', fixture.remoteRoot);
      second.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not pin a remote environment for a generation rebuilt without controllers', async () => {
    const fixture = await localityFixture({ drainTimeoutMs: 5_000 });
    try {
      const controller = fixture.program.createSessionController('remote', fixture.remoteRoot);
      controller.dispose();

      const replaced = fixture.replaceRemote('remote-two', fixture.remoteRoot);
      const settled = await Promise.race([
        replaced.then(() => 'replaced' as const),
        new Promise<'pending'>((resolve) => {
          setTimeout(() => {
            resolve('pending');
          }, 200);
        }),
      ]);
      expect(settled).toBe('replaced');

      const next = fixture.program.createSessionController('remote', fixture.remoteRoot);
      next.dispose();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('Program.onDidChangeTrust', () => {
  it('re-fires local generation trust changes, including across a generation rebuild', async () => {
    const fixture = await localityFixture();
    try {
      const events: boolean[] = [];
      const subscription = fixture.program.onDidChangeTrust((change) => {
        events.push(change.trusted);
      });

      await fixture.program.trust.untrust();
      await fixture.program.trust.trust();
      expect(events).toEqual([false, true]);

      await fixture.replaceLocal('local-two');
      await fixture.program.trust.untrust();
      expect(events).toEqual([false, true, false]);

      subscription.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  it('trust() resolves only after waitUntil promises registered on the re-fired event settle', async () => {
    const fixture = await localityFixture();
    try {
      await fixture.program.trust.untrust();
      let settled = false;
      const subscription = fixture.program.onDidChangeTrust((change) => {
        change.waitUntil(new Promise<void>((resolve) => {
          setTimeout(() => {
            settled = true;
            resolve();
          }, 10);
        }));
      });

      await fixture.program.trust.trust();
      expect(settled).toBe(true);

      subscription.dispose();
    } finally {
      await fixture.cleanup();
    }
  });
});
