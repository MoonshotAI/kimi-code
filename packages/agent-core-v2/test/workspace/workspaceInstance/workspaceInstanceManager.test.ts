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
  return { id, root: `/${id}`, name: id, createdAt: 0, lastOpenedAt: 0 };
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
      for (const registration of registrations.reverse()) await registration.remove();
      throw error;
    }
    let active = true;
    const dispose = async (): Promise<void> => {
      if (!active) return;
      active = false;
      await attachment.dispose();
      for (const registration of registrations.reverse()) await registration.remove();
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
    for (const unit of [...this.units].reverse()) await unit.dispose();
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
    ...Array.from({ length: 22 }, () => undefined),
    new TestRuntimeUnitHostFactory(),
  ];
  args[20] = { entries: () => [] };
  const value = Reflect.construct(WorkspaceInstanceManager, args) as WorkspaceInstanceManager;
  const providers = (value as unknown as { providers: Map<string, RuntimeProviderFactory> }).providers;
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

  it('keeps runtime registries and provider attachments isolated across workspaces', async () => {
    const events: string[] = [];
    const value = manager([workspace('one'), workspace('two')], Promise.resolve(), events);
    const one = await value.getOrCreate({ workspaceId: 'one' });
    const two = await value.getOrCreate({ workspaceId: 'two' });

    expect(one.runtimes.current('local')?.identity.workspaceId).toBe('one');
    expect(two.runtimes.current('local')?.identity.workspaceId).toBe('two');
    expect(one.runtimes.current('local')).not.toBe(two.runtimes.current('local'));

    await value.close('one');
    expect(value.get('two')).toBe(two);
    expect(two.runtimes.current('local')).toBeDefined();
    await value.dispose();
  });

  it('maintains both provider and workspace axes and detaches each matrix cell', async () => {
    const events: string[] = [];
    const value = manager([workspace('one'), workspace('two')], Promise.resolve(), events);
    const one = await value.getOrCreate({ workspaceId: 'one' });
    const remote = await value.addProvider(provider('remote-provider', 'remote', events, { status: 'ready' }));
    const two = await value.getOrCreate({ workspaceId: 'two' });

    expect(one.runtimes.current('remote')).toBeDefined();
    expect(two.runtimes.current('remote')).toBeDefined();

    await remote.dispose();
    expect(one.runtimes.current('remote')).toBeUndefined();
    expect(two.runtimes.current('remote')).toBeUndefined();
    expect(events.filter((event) => event.startsWith('detach:remote-provider:')).sort()).toEqual([
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
    expect(one.runtimes.current('remote')).toBeUndefined();
    expect(events).toContain('detach:broken:one');

    const three = workspace('three');
    await value.dispose();
    expect(three.id).toBe('three');
  });

  it('materializes once required local structure exists without waiting for ready status', async () => {
    const value = manager([workspace('one')]);
    const instance = await value.getOrCreate({ workspaceId: 'one' });

    expect(instance.runtimes.current('local')?.status).toBe('connecting');
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
