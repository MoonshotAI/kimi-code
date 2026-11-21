import { EnvironmentService } from '#/app/environment/environmentService';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project, IProjectService } from '#/app/project/project';
import type { ImplicitProject } from '#/app/project/implicitProject';
import { Error2, ErrorCodes } from '#/errors';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import type { Environment } from '#/environment/environment';
import { ProjectInstanceManager } from '#/project/projectInstance/projectInstanceManagerService';

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function workspace(id: string): Project {
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
  values: readonly Project[],
  ready: Promise<void> = Promise.resolve(),
  _events: string[] = [],
  customize?: (args: unknown[]) => void,
  environments = environmentService(ready),
  revivable: readonly Project[] = [],
): ProjectInstanceManager {
  const byId = new Map(values.map((value) => [value.id, value]));
  const workspaces: IProjectService = {
    _serviceBrand: undefined,
    list: async () => values,
    get: vi.fn(async (id: string) => byId.get(id)),
    create: vi.fn(async (input: { root: string }) => {
      const value = values.find((entry) => entry.root === input.root);
      if (value === undefined) throw new Error(`unknown root ${input.root}`);
      return value;
    }),
    resolveImplicit: vi.fn(async (dir: string) => {
      const value = values.find((entry) => entry.root === dir);
      if (value === undefined) throw new Error(`unknown root ${dir}`);
      return { project: value as ImplicitProject, rule: 'own' as const };
    }),
    peekImplicit: vi.fn(async (dir: string) => {
      throw new Error(`unexpected peek of ${dir}`);
    }),
    reviveImplicit: vi.fn(async (id: string, workDir: string) => {
      const value = revivable.find((entry) => entry.id === id && entry.root === workDir);
      if (value === undefined) throw new Error2(ErrorCodes.WORKSPACE_NOT_FOUND, `cannot revive ${id}`);
      return value;
    }),
    contains: async () => false,
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
  ];
  args[18] = { entries: () => [] };
  args[28] = environments;
  args[29] = { onDidChange: () => ({ dispose: () => {} }) };
  args[30] = { assertAllowed: () => {} };
  customize?.(args);
  return Reflect.construct(ProjectInstanceManager, args) as ProjectInstanceManager;
}

describe('WorkspaceInstanceManager', () => {
  it('single-flights materialization and releases the instance with the last lease', async () => {
    const gate = deferred();
    const value = manager([workspace('one')], gate.promise);
    const firstPromise = value.acquire({ workspaceId: 'one' });
    const secondPromise = value.acquire({ cwd: '/one' });
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

  it('reuses the instance and program when the workspace primary changes', async () => {
    const initial = workspace('one') as { -readonly [K in keyof Project]: Project[K] };
    const value = manager([initial]);
    const first = await value.acquire({ workspaceId: 'one' });
    const instance = first.instance;
    const program = instance.program;
    initial.root = '/two';
    initial.additionalDirs = ['/one'];

    const second = await value.acquire({ workspaceId: 'one' });
    expect(second.instance).toBe(instance);
    expect(second.instance.root).toBe('/two');
    expect(second.instance.program).toBe(program);
    expect(second.instance.snapshot().metadata).toEqual(initial);

    second.dispose();
    first.dispose();
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

  it('acquires only existing workspaces by id and revives a missing one only from a session directory', async () => {
    const gone = workspace('gone');
    const value = manager([], Promise.resolve(), [], undefined, environmentService(), [gone]);

    await expect(value.acquire({ workspaceId: 'gone' })).rejects.toMatchObject({ code: ErrorCodes.WORKSPACE_NOT_FOUND });
    await expect(value.acquire({ workspaceId: 'gone', reviveFrom: '/elsewhere' })).rejects.toMatchObject({
      code: ErrorCodes.WORKSPACE_NOT_FOUND,
    });
    const lease = await value.acquire({ workspaceId: 'gone', reviveFrom: '/gone' });
    expect(lease.instance.id).toBe('gone');
    lease.dispose();
    await value.dispose();
  });
});
