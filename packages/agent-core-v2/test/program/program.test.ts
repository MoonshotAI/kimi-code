import { describe, expect, it, vi } from 'vitest';

import { Program } from '#/program/program';
import type { ProgramSessionControllerInput } from '#/program/programDependencies';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { RuntimeStatus } from '#/runtime/runtime';
import { RuntimeRegistry } from '#/runtime/runtimeRegistry';

function runtime(generation: string, status: RuntimeStatus = 'ready'): FakeRuntime {
  return Object.assign(
    new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'local', generation },
      { status, capabilities: ['fs', 'process', 'watch'] },
    ),
    { fs: {}, process: {}, watch: {} },
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
      createSessionController: (input: ProgramSessionControllerInput) => ({ dispose: input.onDispose }) as never,
    } as never,
  );
  const create = vi.fn(() => {
    const lease = registry.acquire(program.binding, ['fs', 'process', 'watch']);
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
      watch: behavior,
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
  return { registry, program, create };
}

describe('Program', () => {
  it('acquires only available local generations and recovers after reconnect', async () => {
    const { registry, program, create } = setup();
    const current = runtime('one', 'disconnected');
    registry.register(current);
    expect(create).toHaveBeenCalledTimes(1);
    expect(program.status).toBe('degraded');
    expect(() => program.dirs).toThrow('no available local runtime generation');

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
});
