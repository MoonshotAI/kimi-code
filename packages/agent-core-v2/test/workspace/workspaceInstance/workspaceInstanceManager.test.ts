import { describe, expect, it, vi } from 'vitest';

import type { Workspace, IWorkspaceService } from '#/app/workspace/workspace';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { Runtime } from '#/runtime/runtime';
import type { RuntimeProviderFactory } from '#/runtime/runtimeProvider';
import type { RuntimeRegistry } from '#/runtime/runtimeRegistry';
import type {
  RuntimeProviderHost,
  RuntimeProviderRuntimeHandle,
  RuntimeUnitHandle,
  RuntimeUnitHost,
  RuntimeUnitHostFactory,
} from '#/runtime/runtimeUnitHost';
import { WorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManagerService';

const imports = { root: [], imports: [], local: [] } as const;

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function workspace(id: string): Workspace {
  return { id, root: `/${id}`, name: id, kind: 'implicit', additionalDirs: [], createdAt: 0, lastOpenedAt: 0 };
}

function runtime(workspaceId: string, runtimeId: string, status: Runtime['status'] = 'connecting'): FakeRuntime {
  return new FakeRuntime({ workspaceId, runtimeId, generation: `${runtimeId}-one` }, { status });
}

class TestRuntimeUnitHost implements RuntimeUnitHost {
  private readonly units: RuntimeUnitHandle[] = [];

  constructor(private readonly registry: RuntimeRegistry) {}

  async provide<T extends { dispose(): void | Promise<void> }>(
    _imports: typeof imports,
    prepare: (host: RuntimeProviderHost) => Promise<T>,
  ): Promise<RuntimeUnitHandle> {
    const registrations: RuntimeProviderRuntimeHandle[] = [];
    const host: RuntimeProviderHost = {
      get: () => { throw new Error('no imports'); },
      provide: () => { throw new Error('no local services'); },
      registerRuntime: (value) => {
        const registration = this.registry.register(value);
        const handle: RuntimeProviderRuntimeHandle = {
          runtimeId: value.identity.runtimeId,
          update: async (next) => { await registration.replace(await next()); },
          remove: () => registration.remove(),
        };
        registrations.push(handle);
        return handle;
      },
    };
    let attachment: T;
    try {
      attachment = await prepare(host);
    } catch (error) {
      for (const registration of registrations.toReversed()) await registration.remove();
      throw error;
    }
    let active = true;
    const dispose = async (): Promise<void> => {
      if (!active) return;
      active = false;
      await attachment.dispose();
      for (const registration of registrations.toReversed()) await registration.remove();
      const index = this.units.indexOf(handle);
      if (index >= 0) this.units.splice(index, 1);
    };
    const handle: RuntimeUnitHandle = {
      update: async () => { throw new Error('not supported'); },
      remove: dispose,
      dispose,
    };
    this.units.push(handle);
    return handle;
  }

  async update(): Promise<void> {
    throw new Error('not supported');
  }

  remove(handle: RuntimeUnitHandle): Promise<void> {
    return handle.dispose();
  }

  async dispose(): Promise<void> {
    for (const unit of [...this.units].toReversed()) await unit.dispose();
  }
}

class TestRuntimeUnitHostFactory implements RuntimeUnitHostFactory {
  create(_root: never, registry: RuntimeRegistry): RuntimeUnitHost {
    return new TestRuntimeUnitHost(registry);
  }
}

function provider(
  id: string,
  runtimeId: string,
  events: string[],
  options: { failWorkspace?: string; status?: Runtime['status'] } = {},
): RuntimeProviderFactory {
  return {
    id,
    imports,
    attach: async (context, host) => {
      events.push(`attach:${id}:${context.id}`);
      if (options.failWorkspace === context.id) throw new Error(`attach failed ${context.id}`);
      host.registerRuntime(runtime(context.id, runtimeId, options.status));
      return { dispose: () => { events.push(`detach:${id}:${context.id}`); } };
    },
  };
}

function manager(
  values: readonly Workspace[],
  ready: Promise<void> = Promise.resolve(),
  events: string[] = [],
): WorkspaceInstanceManager {
  const byId = new Map(values.map((value) => [value.id, value]));
  const workspaces: IWorkspaceService = {
    _serviceBrand: undefined,
    list: async () => values,
    get: vi.fn(async (id: string) => byId.get(id)),
    create: vi.fn(async (input: { root: string }) => {
      const value = values.find((entry) => entry.root === input.root);
      if (value === undefined) throw new Error(`unknown root ${input.root}`);
      return value;
    }),
    createOrTouch: vi.fn(async (root: string) => {
      const value = values.find((entry) => entry.root === root);
      if (value === undefined) throw new Error(`unknown root ${root}`);
      return value;
    }),
    touch: vi.fn(async (id: string) => byId.get(id)),
    update: async () => undefined,
    setPrimary: async () => undefined,
    readProjectConfigDirs: async () => [],
    delete: async () => {},
  };
  const args: unknown[] = [
    {},
    { scope: () => 'sessions' },
    workspaces,
    { ready },
    ...Array.from({ length: 26 }, () => undefined),
    new TestRuntimeUnitHostFactory(),
  ];
  args[18] = { entries: () => [] };
  const value = Reflect.construct(WorkspaceInstanceManager, args) as WorkspaceInstanceManager;
  const providers = (value as unknown as { providers: Map<string, RuntimeProviderFactory> }).providers;
  providers.clear();
  providers.set('local', provider('local', 'local', events));
  return value;
}

describe('WorkspaceInstanceManager', () => {
  it('single-flights materialization while keeping leases independent and serializing replacement', async () => {
    const materialization = deferred();
    const closing = deferred();
    const events: string[] = [];
    const value = manager([workspace('one')], materialization.promise, events);
    const providers = (value as unknown as { providers: Map<string, RuntimeProviderFactory> }).providers;
    const local = provider('local', 'local', events);
    providers.set('local', {
      ...local,
      attach: async (context, host) => {
        const attachment = await local.attach(context, host);
        return {
          dispose: async () => {
            await closing.promise;
            await attachment.dispose();
          },
        };
      },
    });
    const firstPromise = value.acquire({ workspaceId: 'one' });
    const secondPromise = value.acquire({ root: '/one' });
    materialization.resolve();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).not.toBe(second);
    expect(first.instance).toBe(second.instance);
    first.dispose();
    expect(value.get('one')).toBe(first.instance);
    second.dispose();
    expect(value.get('one')).toBeUndefined();
    const replacementPromise = value.acquire({ workspaceId: 'one' });
    let replacementSettled = false;
    void replacementPromise.then(() => { replacementSettled = true; });
    await Promise.resolve();
    expect(replacementSettled).toBe(false);
    closing.resolve();

    const replacement = await replacementPromise;
    expect(replacement.instance).not.toBe(first.instance);
    second.dispose();
    replacement.dispose();
    await value.dispose();
    expect(events).toEqual([
      'attach:local:one',
      'detach:local:one',
      'attach:local:one',
      'detach:local:one',
    ]);
  });

  it('replaces the instance when the registry root changes', async () => {
    const events: string[] = [];
    const initial = workspace('one');
    const value = manager([initial], Promise.resolve(), events);
    const first = await value.acquire({ workspaceId: 'one' });
    const updated = { ...initial, root: '/new-one' };
    const registry = (value as unknown as { workspaces: { get: (id: string) => Promise<Workspace | undefined> } }).workspaces;
    const originalGet = registry.get;
    registry.get = async (id: string) => (id === 'one' ? updated : originalGet(id));

    const second = await value.acquire({ workspaceId: 'one' });

    expect(second.instance).not.toBe(first.instance);
    expect(second.instance.root).toBe('/new-one');
    expect(events).toEqual([
      'attach:local:one',
      'detach:local:one',
      'attach:local:one',
    ]);
    first.dispose();
    second.dispose();
    await value.dispose();
  });

  it('keeps runtime registries and provider attachments isolated across workspaces', async () => {
    const events: string[] = [];
    const value = manager([workspace('one'), workspace('two')], Promise.resolve(), events);
    const one = await value.acquire({ workspaceId: 'one' });
    const two = await value.acquire({ workspaceId: 'two' });

    expect(one.instance.runtimes.current('local')?.identity.workspaceId).toBe('one');
    expect(two.instance.runtimes.current('local')?.identity.workspaceId).toBe('two');
    expect(one.instance.runtimes.current('local')).not.toBe(two.instance.runtimes.current('local'));

    one.dispose();
    expect(value.get('two')).toBe(two.instance);
    expect(two.instance.runtimes.current('local')).toBeDefined();
    two.dispose();
    await value.dispose();
  });

  it('maintains both provider and workspace axes and isolates concurrent attachment cleanup', async () => {
    const events: string[] = [];
    const value = manager([workspace('one'), workspace('two')], Promise.resolve(), events);
    const one = await value.acquire({ workspaceId: 'one' });
    const remote = await value.addProvider(provider('remote-provider', 'remote', events, { status: 'ready' }));
    const two = await value.acquire({ workspaceId: 'two' });

    expect(one.instance.runtimes.current('remote')).toBeDefined();
    expect(two.instance.runtimes.current('remote')).toBeDefined();

    await remote.dispose();
    expect(one.instance.runtimes.current('remote')).toBeUndefined();
    expect(two.instance.runtimes.current('remote')).toBeUndefined();
    expect(events.filter((event) => event.startsWith('detach:remote-provider:')).toSorted()).toEqual([
      'detach:remote-provider:one',
      'detach:remote-provider:two',
    ]);

    const gate = deferred();
    const adding = value.addProvider({
      id: 'slow',
      imports,
      attach: async (context, host) => {
        events.push(`attach:slow:${context.id}`);
        await gate.promise;
        host.registerRuntime(runtime(context.id, 'slow', 'ready'));
        return { dispose: () => { events.push(`detach:slow:${context.id}`); } };
      },
    });
    await vi.waitFor(() => {
      expect(events).toContain('attach:slow:one');
    });
    one.dispose();
    const replacementPromise = value.acquire({ workspaceId: 'one' });
    gate.resolve();
    const [slow, replacement] = await Promise.all([adding, replacementPromise]);
    expect(replacement.instance).not.toBe(one.instance);
    expect(replacement.instance.runtimes.current('slow')).toBeDefined();
    expect(events.indexOf('detach:slow:one')).toBeLessThan(events.lastIndexOf('attach:slow:one'));
    await slow.dispose();
    replacement.dispose();
    two.dispose();
    await value.dispose();
  });

  it('rolls back earlier attachments when adding a provider fails on a later workspace', async () => {
    const events: string[] = [];
    const value = manager([workspace('one'), workspace('two'), workspace('three')], Promise.resolve(), events);
    const one = await value.acquire({ workspaceId: 'one' });
    const two = await value.acquire({ workspaceId: 'two' });

    await expect(value.addProvider(provider('broken', 'remote', events, { failWorkspace: 'two' })))
      .rejects.toThrow('attach failed two');
    expect(one.instance.runtimes.current('remote')).toBeUndefined();
    expect(events).toContain('detach:broken:one');

    const providers = (value as unknown as { providers: Map<string, RuntimeProviderFactory> }).providers;
    providers.set('local', provider('local', 'local', events, { failWorkspace: 'three' }));
    await expect(value.acquire({ workspaceId: 'three' })).rejects.toThrow('attach failed three');
    expect(value.get('three')).toBeUndefined();
    one.dispose();
    two.dispose();
    await value.dispose();
  });

  it('materializes once required local structure exists without waiting for ready status', async () => {
    const value = manager([workspace('one')]);
    const lease = await value.acquire({ workspaceId: 'one' });

    expect(lease.instance.runtimes.current('local')?.status).toBe('connecting');
    expect(lease.instance.program.status).toBe('preparing');
    expect(lease.instance.snapshot().lifecycle).toBe('active');
    lease.dispose();
    expect(value.get('one')).toBeUndefined();
    await value.dispose();
  });

  describe('findContaining', () => {
    function rootedWorkspace(id: string, root: string): Workspace {
      return { id, root, name: id, kind: 'implicit', additionalDirs: [], createdAt: 0, lastOpenedAt: 0 };
    }

    function stubDirs(lease: { instance: { program: object } }, additionalDirs: readonly string[]): { additionalDirs: readonly string[] } {
      const dirs = { additionalDirs };
      Object.defineProperty(lease.instance.program, 'dirs', { value: dirs });
      return dirs;
    }

    it('matches exact and nested cwds, preferring the longest containing root', async () => {
      const value = manager([
        rootedWorkspace('repo', '/repo'),
        rootedWorkspace('sub', '/repo/sub'),
      ]);
      const leases = [
        await value.acquire({ workspaceId: 'repo' }),
        await value.acquire({ workspaceId: 'sub' }),
      ];
      for (const lease of leases) stubDirs(lease, []);

      expect(value.findContaining('/repo')?.id).toBe('repo');
      expect(value.findContaining('/repo/sub')?.id).toBe('sub');
      expect(value.findContaining('/repo/sub/deep/pkg')?.id).toBe('sub');
      expect(value.findContaining('/repo/other')?.id).toBe('repo');
      expect(value.findContaining('/repo-other')).toBeUndefined();
      expect(value.findContaining('/outside')).toBeUndefined();
      for (const lease of leases) lease.dispose();
      await value.dispose();
    });

    it('matches exact and nested cwds under additional source roots', async () => {
      const value = manager([
        {
          ...rootedWorkspace('multi', '/primary'),
          additionalDirs: ['/extra'],
        },
      ]);
      const lease = await value.acquire({ workspaceId: 'multi' });
      stubDirs(lease, ['/extra']);

      expect(value.findContaining('/extra')?.id).toBe('multi');
      expect(value.findContaining('/extra/nested/pkg')?.id).toBe('multi');
      expect(value.findContaining('/extra-other')).toBeUndefined();
      expect(value.findContaining('/outside')).toBeUndefined();
      lease.dispose();
      await value.dispose();
    });

    it('uses current program dirs instead of the instance metadata snapshot', async () => {
      const initial = rootedWorkspace('multi', '/primary');
      const value = manager([initial]);
      const lease = await value.acquire({ workspaceId: 'multi' });
      const dirs = stubDirs(lease, []);

      dirs.additionalDirs = ['/extra'];
      expect(value.findContaining('/extra/nested')?.id).toBe('multi');
      dirs.additionalDirs = [];
      expect(value.findContaining('/extra/nested')).toBeUndefined();
      lease.dispose();
      await value.dispose();
    });

    it('matches across Windows spelling variants', async () => {
      const value = manager([rootedWorkspace('win', 'C:\\Users\\Foo\\Repo')]);
      const lease = await value.acquire({ workspaceId: 'win' });
      stubDirs(lease, []);

      expect(value.findContaining('c:/users/foo/repo')?.id).toBe('win');
      expect(value.findContaining('C:/Users/Foo/Repo/sub')?.id).toBe('win');
      expect(value.findContaining('D:/elsewhere')).toBeUndefined();
      lease.dispose();
      await value.dispose();
    });

    it('matches any absolute cwd against a workspace rooted at /', async () => {
      const value = manager([
        rootedWorkspace('root', '/'),
        rootedWorkspace('repo', '/repo'),
      ]);
      const leases = [
        await value.acquire({ workspaceId: 'root' }),
        await value.acquire({ workspaceId: 'repo' }),
      ];
      for (const lease of leases) stubDirs(lease, []);

      expect(value.findContaining('/')?.id).toBe('root');
      expect(value.findContaining('/elsewhere')?.id).toBe('root');
      expect(value.findContaining('/repo/sub')?.id).toBe('repo');
      for (const lease of leases) lease.dispose();
      await value.dispose();
    });
  });
});
