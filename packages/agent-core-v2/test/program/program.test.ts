import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { Program } from '#/program/program';
import type { ProgramSessionControllerInput } from '#/program/programDependencies';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { RuntimeStatus } from '#/runtime/runtime';
import { RuntimeRegistry } from '#/runtime/runtimeRegistry';

function runtime(generation: string, status: RuntimeStatus = 'ready'): FakeRuntime {
  return Object.assign(
    new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'local', generation },
      { status, capabilities: ['fs', 'process'] },
    ),
    { fs: {}, process: {} },
  ) as FakeRuntime;
}

function remoteRuntime(generation: string, status: RuntimeStatus = 'ready'): FakeRuntime {
  return Object.assign(
    new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'remote', generation },
      { status, capabilities: ['fs', 'process'] },
    ),
    { fs: {}, process: {} },
  ) as FakeRuntime;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function setup(readiness = new Map<string, Promise<void>>(), order: string[] = []) {
  const registry = new RuntimeRegistry('workspace', 50);
  const controllerInputs: ProgramSessionControllerInput[] = [];
  const program = new Program(
    'workspace',
    registry,
    {
      _serviceBrand: undefined,
      workspaceId: 'workspace',
      cwd: '/workspace',
      source: 'local',
      meta: {
        id: 'workspace',
        name: 'workspace',
        root: '/workspace',
        createdAt: 0,
        lastOpenedAt: 0,
      },
      persistenceScope: 'sessions/workspace',
    },
    {
      agentProfiles: { entries: () => [] },
      createSessionController: (input: ProgramSessionControllerInput) => {
        controllerInputs.push(input);
        return { dispose: input.onDispose } as never;
      },
    } as never,
  );
  const create = vi.fn((runtimeId: string) => {
    const lease = registry.acquire({ workspaceId: 'workspace', runtimeId }, ['fs', 'process']);
    const id = lease.runtime.identity.generation;
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
    const current = runtime('one', 'disconnected');
    registry.register(current);
    expect(create).toHaveBeenCalledTimes(1);
    expect(program.status).toBe('degraded');
    expect(() => program.dirs).toThrow('no available generation for runtime local');

    current.setStatus('ready');
    await program.ready;
    expect(create).toHaveBeenCalledTimes(2);
    expect(program.sessionControllerGeneration).toBe('one');
    expect(program.status).toBe('ready');
    program.dispose();
    await registry.dispose();
  });

  it('stays preparing until the fixed local generation behavior becomes ready', async () => {
    const pending = deferred();
    const { registry, program } = setup(new Map([['one', pending.promise]]));
    registry.register(runtime('one'));

    expect(program.binding).toEqual({ workspaceId: 'workspace', runtimeId: 'local' });
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
    registry.register(runtime('one'));
    failed.reject(new Error('failed'));
    await program.ready;
    await Promise.resolve();
    expect(program.status).toBe('degraded');
    program.dispose();
    await registry.dispose();
  });

  it('retains the replaced generation lease until its session controller is disposed', async () => {
    const { registry, program } = setup();
    const first = runtime('one');
    const registration = registry.register(first);
    await program.ready;
    const controller = program.createSessionController();
    const replacement = registration.replace(runtime('two'));
    await Promise.resolve();
    expect(program.sessionControllerGeneration).toBe('two');
    expect(first.disposed).toBe(false);
    controller.dispose();
    await replacement;
    expect(first.disposed).toBe(true);
    program.dispose();
    await registry.dispose();
  });

  it('owns catalog, instructions, MCP, provenance, and current runtime in one generation', async () => {
    const { registry, program, create } = setup();
    registry.register(runtime('one'));
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
      binding: { workspaceId: 'workspace', runtimeId: 'local' },
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
      runtimes: [{ runtimeId: 'local', generation: 'one', status: 'ready' }],
    });

    program.dispose();
    await registry.dispose();
  });

  it('replaces generations atomically and disposes behavior before releasing its lease', async () => {
    const firstReady = deferred();
    const order: string[] = [];
    const { registry, program } = setup(new Map([['one', firstReady.promise]]), order);
    const registration = registry.register(runtime('one'));
    const replacement = registration.replace(runtime('two'));
    await replacement;
    await Promise.resolve();
    expect(program.sessionControllerGeneration).toBe('two');
    expect(program.status).toBe('ready');
    expect(order).toEqual(['behavior:one']);

    firstReady.resolve();
    await Promise.resolve();
    expect(program.sessionControllerGeneration).toBe('two');
    expect(program.status).toBe('ready');
    program.dispose();
    expect(order).toEqual(['behavior:one', 'behavior:two']);
    await registry.dispose();
  });

  it('isolates generations per runtime so same-workspace sessions do not cross project context', async () => {
    const { registry, program, create, controllerInputs } = setup();
    registry.register(runtime('one'));
    registry.register(remoteRuntime('remote-one'));

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toBe('local');

    program.createSessionController();
    expect(create).toHaveBeenCalledTimes(1);

    program.createSessionController('remote');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]).toBe('remote');

    expect(program.sessionControllerGeneration).toBe('one');
    expect(program.sessionControllerGenerationFor('remote')).toBe('remote-one');
    expect(controllerInputs).toHaveLength(2);
    expect(controllerInputs[0]?.fs).not.toBe(controllerInputs[1]?.fs);
    expect(controllerInputs[0]?.fs).toBe(create.mock.results[0]?.value.lease.runtime.fs);
    expect(controllerInputs[1]?.fs).toBe(create.mock.results[1]?.value.lease.runtime.fs);

    expect(() => program.sessionControllerGenerationFor('missing')).toThrow(
      'no available generation for runtime missing',
    );

    program.dispose();
    await registry.dispose();
  });

  it('retires a remote generation when its runtime is removed without touching local', async () => {
    const { registry, program, create } = setup();
    registry.register(runtime('one'));
    const remote = remoteRuntime('remote-one');
    const remoteRegistration = registry.register(remote);
    program.createSessionController('remote');
    expect(program.sessionControllerGenerationFor('remote')).toBe('remote-one');

    await remoteRegistration.remove();
    expect(() => program.sessionControllerGenerationFor('remote')).toThrow(
      'no available generation for runtime remote',
    );
    expect(program.sessionControllerGeneration).toBe('one');
    expect(create).toHaveBeenCalledTimes(2);

    program.dispose();
    await registry.dispose();
  });
});

function fakeFsRuntime(runtimeId: string, generation: string): FakeRuntime {
  return Object.assign(
    new FakeRuntime(
      { workspaceId: 'workspace', runtimeId, generation },
      { capabilities: ['fs'] },
    ),
    { fs: new HostFileSystem() },
  ) as FakeRuntime;
}

function suggestSetup() {
  const registry = new RuntimeRegistry('workspace', 50);
  const program = new Program(
    'workspace',
    registry,
    {
      _serviceBrand: undefined,
      workspaceId: 'workspace',
      cwd: '/workspace',
      source: 'local',
      meta: {
        id: 'workspace',
        name: 'workspace',
        root: '/workspace',
        createdAt: 0,
        lastOpenedAt: 0,
      },
      persistenceScope: 'sessions/workspace',
    },
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
  it('suggests files for a runtime with the given session roots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-program-suggest-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'app.ts'), 'app');
      await writeFile(join(dir, 'src', 'index.ts'), 'index');
      await writeFile(join(dir, 'README.md'), 'readme');
      const { registry, program } = suggestSetup();
      registry.register(fakeFsRuntime('local', 'local-one'));

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

  it('routes the suggest to the requested runtime and rejects an unknown runtime', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'kimi-program-suggest-local-'));
    const remoteDir = await mkdtemp(join(tmpdir(), 'kimi-program-suggest-remote-'));
    try {
      await writeFile(join(localDir, 'local-only.ts'), 'local');
      await writeFile(join(remoteDir, 'remote-only.ts'), 'remote');
      const { registry, program } = suggestSetup();
      registry.register(fakeFsRuntime('local', 'local-one'));
      registry.register(fakeFsRuntime('remote', 'remote-one'));

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
