import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Workspace, IWorkspaceService } from '#/app/workspace/workspace';
import { WorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManagerService';

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function workspace(id: string): Workspace {
  return { id, root: `/${id}`, name: id, kind: 'implicit', additionalDirs: [], createdAt: 0, lastOpenedAt: 0 };
}

function manager(
  values: readonly Workspace[],
  ready: Promise<void> = Promise.resolve(),
  customize?: (args: unknown[]) => void,
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
  ];
  args[20] = { entries: () => [] };
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

  it('reuses the instance and program when the workspace primary changes', async () => {
    const initial = workspace('one') as { -readonly [K in keyof Workspace]: Workspace[K] };
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
  });
});
