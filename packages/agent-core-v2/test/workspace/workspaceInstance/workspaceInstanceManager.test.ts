import { describe, expect, it, vi } from 'vitest';

import type { Workspace, IWorkspaceService } from '#/app/workspace/workspace';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import type { Environment } from '#/environment/environment';
import type { EnvironmentProviderFactory } from '#/environment/environmentProvider';
import { WorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManagerService';
import { sessionDirOf } from '#/workspace/sessionLifecycle/internal/addressing';

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function workspace(id: string): Workspace {
  return { id, root: `/${id}`, name: id, createdAt: 0, lastOpenedAt: 0 };
}

function environment(workspaceId: string, environmentId: string, status: Environment['status'] = 'connecting'): FakeEnvironment {
  return new FakeEnvironment({ workspaceId, environmentId, generation: `${environmentId}-one` }, { status });
}

function provider(
  id: string,
  environmentId: string,
  events: string[],
  options: { failWorkspace?: string; status?: Environment['status'] } = {},
): EnvironmentProviderFactory {
  return {
    id,
    attach: async (context, host) => {
      events.push(`attach:${id}:${context.id}`);
      if (options.failWorkspace === context.id) throw new Error(`attach failed ${context.id}`);
      host.registerEnvironment(environment(context.id, environmentId, options.status));
      return { dispose: () => { events.push(`detach:${id}:${context.id}`); } };
    },
  };
}

function manager(
  values: readonly Workspace[],
  ready: Promise<void> = Promise.resolve(),
  events: string[] = [],
  customize?: (args: unknown[]) => void,
): WorkspaceInstanceManager {
  const byId = new Map(values.map((value) => [value.id, value]));
  const workspaces: IWorkspaceService = {
    _serviceBrand: undefined,
    list: async () => values,
    get: vi.fn(async (id: string) => byId.get(id)),
    createOrTouch: vi.fn(async (root: string) => {
      const value = values.find((entry) => entry.root === root);
      if (value === undefined) throw new Error(`unknown root ${root}`);
      return value;
    }),
    update: async () => undefined,
    delete: async () => {},
  };
  const args: unknown[] = [
    {},
    { scope: () => 'sessions' },
    workspaces,
    { ready },
    ...Array.from({ length: 24 }, () => undefined),
  ];
  args[19] = { entries: () => [] };
  customize?.(args);
  const value = Reflect.construct(WorkspaceInstanceManager, args) as WorkspaceInstanceManager;
  const providers = (value as unknown as { providers: Map<string, EnvironmentProviderFactory> }).providers;
  providers.clear();
  providers.set('local', provider('local', 'local', events));
  return value;
}

describe('WorkspaceInstanceManager', () => {
  it('single-flights materialization and closes an in-flight workspace without leaving an instance', async () => {
    const gate = deferred();
    const events: string[] = [];
    const value = manager([workspace('one')], gate.promise, events);
    const first = value.getOrCreate({ workspaceId: 'one' });
    const second = value.getOrCreate({ workspaceId: 'one' });
    const inflight = (value as unknown as { inflight: Map<string, Promise<unknown>> }).inflight;
    while (!inflight.has('one')) await Promise.resolve();
    const closing = value.close('one');
    gate.resolve();

    const [firstInstance, secondInstance] = await Promise.all([first, second]);
    expect(firstInstance).toBe(secondInstance);
    await closing;
    expect(value.get('one')).toBeUndefined();
    expect(events).toEqual(['attach:local:one', 'detach:local:one']);
  });

  it('keeps environment registries and provider attachments isolated across workspaces', async () => {
    const events: string[] = [];
    const value = manager([workspace('one'), workspace('two')], Promise.resolve(), events);
    const one = await value.getOrCreate({ workspaceId: 'one' });
    const two = await value.getOrCreate({ workspaceId: 'two' });

    expect(one.environments.current('local')?.identity.workspaceId).toBe('one');
    expect(two.environments.current('local')?.identity.workspaceId).toBe('two');
    expect(one.environments.current('local')).not.toBe(two.environments.current('local'));

    await value.close('one');
    expect(value.get('two')).toBe(two);
    expect(two.environments.current('local')).toBeDefined();
    await value.dispose();
  });

  it('maintains both provider and workspace axes and detaches each matrix cell', async () => {
    const events: string[] = [];
    const value = manager([workspace('one'), workspace('two')], Promise.resolve(), events);
    const one = await value.getOrCreate({ workspaceId: 'one' });
    const remote = await value.addProvider(provider('remote-provider', 'remote', events, { status: 'ready' }));
    const two = await value.getOrCreate({ workspaceId: 'two' });

    expect(one.environments.current('remote')).toBeDefined();
    expect(two.environments.current('remote')).toBeDefined();

    await remote.dispose();
    expect(one.environments.current('remote')).toBeUndefined();
    expect(two.environments.current('remote')).toBeUndefined();
    expect(events.filter((event) => event.startsWith('detach:remote-provider:')).toSorted()).toEqual([
      'detach:remote-provider:one',
      'detach:remote-provider:two',
    ]);
    await value.dispose();
  });

  it('rolls back earlier attachments when adding a provider fails on a later workspace', async () => {
    const events: string[] = [];
    const value = manager([workspace('one'), workspace('two')], Promise.resolve(), events);
    const one = await value.getOrCreate({ workspaceId: 'one' });
    await value.getOrCreate({ workspaceId: 'two' });

    await expect(value.addProvider(provider('broken', 'remote', events, { failWorkspace: 'two' })))
      .rejects.toThrow('attach failed two');
    expect(one.environments.current('remote')).toBeUndefined();
    expect(events).toContain('detach:broken:one');

    const three = workspace('three');
    await value.dispose();
    expect(three.id).toBe('three');
  });

  it('session controllers operate on the local session dir even when bound to a remote environment', async () => {
    const removed: string[] = [];
    const remoteRemoved: string[] = [];
    const value = manager([workspace('one')], Promise.resolve(), [], (args) => {
      args[1] = { scope: () => 'sessions', homeDir: '/home/test' };
      args[4] = { remove: async (path: string) => { removed.push(path); } };
      args[7] = { publish: () => {} };
      args[10] = { get: async () => undefined, remove: async () => {} };
      args[11] = { drain: async () => {} };
      args[23] = { withContext: () => ({ track2: () => {} }) };
      args[25] = { append: () => {}, flush: async () => {}, drainRetirements: async () => {} };
      args[26] = { get: async () => undefined };
    });
    const one = await value.getOrCreate({ workspaceId: 'one' });
    await value.addProvider({
      id: 'remote-provider',
      attach: async (context, host) => {
        const remote = new FakeEnvironment(
          { workspaceId: context.id, environmentId: 'remote', generation: 'remote-one' },
          { status: 'ready', capabilities: ['fs', 'process'] },
        );
        Object.assign(remote, {
          fs: { remove: async (path: string) => { remoteRemoved.push(path); } },
          process: {},
        });
        host.registerEnvironment(remote);
        return { dispose: () => {} };
      },
    });

    const program = one.program as unknown as {
      createGeneration: (environmentId: string, cwd?: string) => unknown;
    };
    program.createGeneration = (environmentId: string) => {
      const lease = one.environments.acquire({ workspaceId: 'one', environmentId }, ['fs', 'process']);
      const behavior = { ready: Promise.resolve(), dispose: () => {} };
      const catalog = {
        listSkills: () => [],
        listInvocableSkills: () => [],
        getSkippedByPolicy: () => [],
        getSkillRoots: () => [],
      };
      return {
        id: lease.environment.identity.generation,
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
    };

    const controller = one.program.createSessionController('remote');
    (controller as unknown as { sessions: Map<string, unknown> }).sessions.set('session-x', {
      id: 'session-x',
      kind: 'session',
      accessor: { get: () => ({ list: () => [], setArchived: async () => {} }) },
      dispose: () => {},
    });
    await controller.delete('session-x');

    expect(removed).toEqual([sessionDirOf('/home/test', 'sessions/one', 'session-x')]);
    expect(remoteRemoved).toEqual([]);
    controller.dispose();
    await value.dispose();
  });

  it('materializes once required local structure exists without waiting for ready status', async () => {
    const value = manager([workspace('one')]);
    const instance = await value.getOrCreate({ workspaceId: 'one' });

    expect(instance.environments.current('local')?.status).toBe('connecting');
    expect(instance.program.status).toBe('preparing');
    expect(instance.snapshot().lifecycle).toBe('active');
    await value.dispose();
  });

  describe('findContaining', () => {
    function rootedWorkspace(id: string, root: string): Workspace {
      return { id, root, name: id, createdAt: 0, lastOpenedAt: 0 };
    }

    it('matches exact and nested cwds, preferring the longest containing root', async () => {
      const value = manager([
        rootedWorkspace('repo', '/repo'),
        rootedWorkspace('sub', '/repo/sub'),
      ]);
      await value.getOrCreate({ workspaceId: 'repo' });
      await value.getOrCreate({ workspaceId: 'sub' });

      expect(value.findContaining('/repo')?.id).toBe('repo');
      expect(value.findContaining('/repo/sub')?.id).toBe('sub');
      expect(value.findContaining('/repo/sub/deep/pkg')?.id).toBe('sub');
      expect(value.findContaining('/repo/other')?.id).toBe('repo');
      expect(value.findContaining('/repo-other')).toBeUndefined();
      expect(value.findContaining('/outside')).toBeUndefined();
      await value.dispose();
    });

    it('matches across Windows spelling variants', async () => {
      const value = manager([rootedWorkspace('win', 'C:\\Users\\Foo\\Repo')]);
      await value.getOrCreate({ workspaceId: 'win' });

      expect(value.findContaining('c:/users/foo/repo')?.id).toBe('win');
      expect(value.findContaining('C:/Users/Foo/Repo/sub')?.id).toBe('win');
      expect(value.findContaining('D:/elsewhere')).toBeUndefined();
      await value.dispose();
    });

    it('matches any absolute cwd against a workspace rooted at /', async () => {
      const value = manager([
        rootedWorkspace('root', '/'),
        rootedWorkspace('repo', '/repo'),
      ]);
      await value.getOrCreate({ workspaceId: 'root' });
      await value.getOrCreate({ workspaceId: 'repo' });

      expect(value.findContaining('/')?.id).toBe('root');
      expect(value.findContaining('/elsewhere')?.id).toBe('root');
      expect(value.findContaining('/repo/sub')?.id).toBe('repo');
      await value.dispose();
    });
  });
});
