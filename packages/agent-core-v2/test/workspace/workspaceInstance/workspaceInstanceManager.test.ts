import { EnvironmentService } from '#/app/environment/environmentService';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Workspace, IWorkspaceService } from '#/app/workspace/workspace';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import type { Environment } from '#/environment/environment';
import { WorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManagerService';

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function workspace(id: string): Workspace {
  return { id, root: `/${id}`, name: id, kind: 'implicit', additionalDirs: [], createdAt: 0, lastOpenedAt: 0 };
}

function environment(_workspaceId: string, environmentId: string, status: Environment['status'] = 'connecting'): FakeEnvironment {
  return new FakeEnvironment({ environmentId, generation: `${environmentId}-one` }, { status });
}

const environmentServices: EnvironmentService[] = [];

afterEach(async () => {
  for (const service of environmentServices.splice(0)) await service.dispose();
});

function environmentService(ready: Promise<void> = Promise.resolve()): EnvironmentService {
  const service = new EnvironmentService({} as never, { ready, pathClass: 'posix', homeDir: '/home/test' } as never, undefined as never, undefined as never);
  environmentServices.push(service);
  return service;
}

function manager(
  values: readonly Workspace[],
  ready: Promise<void> = Promise.resolve(),
  _events: string[] = [],
  customize?: (args: unknown[]) => void,
  environments = environmentService(ready),
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
    ...Array.from({ length: 27 }, () => undefined),
  ];
  args[19] = { entries: () => [] };
  args[29] = environments;
  args[30] = { onDidChange: () => ({ dispose: () => {} }) };
  args[31] = { assertAllowed: () => {} };
  customize?.(args);
  return Reflect.construct(WorkspaceInstanceManager, args) as WorkspaceInstanceManager;
}

describe('WorkspaceInstanceManager', () => {
  it('single-flights materialization and releases the instance with the last lease', async () => {
    const gate = deferred();
    const value = manager([workspace('one')], gate.promise);
    const firstPromise = value.acquire({ workspaceId: 'one' });
    const secondPromise = value.acquire({ root: '/one' });
    gate.resolve();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).not.toBe(second);
    expect(first.instance).toBe(second.instance);
    first.dispose();
    expect(value.get('one')).toBe(first.instance);
    second.dispose();
    await vi.waitFor(() => {
      expect(value.get('one')).toBeUndefined();
    });
    await value.dispose();
  });

  it('rolls back environments registered by a provider that fails to attach', async () => {
    const environments = environmentService();
    const remote = environment('unused', 'remote');
    await expect(environments.addProvider({
      id: 'broken',
      attach: async (host) => {
        host.registerEnvironment(remote);
        throw new Error('attach failed');
      },
    })).rejects.toThrow('attach failed');
    expect(environments.current('remote')).toBeUndefined();
    expect(remote.disposed).toBe(true);
    const registration = await environments.addProvider({ id: 'broken', attach: async () => ({ dispose: () => {} }) });
    await registration.dispose();
  });

  it('materializes the workspace even when project services are unavailable', async () => {
    const value = manager([workspace('one')]);
    const lease = await value.acquire({ workspaceId: 'one' });

    expect(lease.instance.program.status).toBe('degraded');
    expect(lease.instance.snapshot().lifecycle).toBe('active');
    lease.dispose();
    await vi.waitFor(() => {
      expect(value.get('one')).toBeUndefined();
    });
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
      const repo = await value.acquire({ workspaceId: 'repo' });
      const sub = await value.acquire({ workspaceId: 'sub' });
      stubDirs(repo, []);
      stubDirs(sub, []);

      expect(value.findContaining('/repo')?.id).toBe('repo');
      expect(value.findContaining('/repo/sub')?.id).toBe('sub');
      expect(value.findContaining('/repo/sub/deep/pkg')?.id).toBe('sub');
      expect(value.findContaining('/repo/other')?.id).toBe('repo');
      expect(value.findContaining('/repo-other')).toBeUndefined();
      expect(value.findContaining('/outside')).toBeUndefined();
      repo.dispose();
      sub.dispose();
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
      const root = await value.acquire({ workspaceId: 'root' });
      const repo = await value.acquire({ workspaceId: 'repo' });
      stubDirs(root, []);
      stubDirs(repo, []);

      expect(value.findContaining('/')?.id).toBe('root');
      expect(value.findContaining('/elsewhere')?.id).toBe('root');
      expect(value.findContaining('/repo/sub')?.id).toBe('repo');
      root.dispose();
      repo.dispose();
      await value.dispose();
    });
  });
});
