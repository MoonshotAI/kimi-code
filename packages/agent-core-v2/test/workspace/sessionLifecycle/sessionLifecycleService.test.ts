import { describe, expect, it, vi } from 'vitest';

import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';

const { createScopedChildHandleMock } = vi.hoisted(() => ({
  createScopedChildHandleMock: vi.fn(),
}));

vi.mock('#/_base/di/scope', async (importOriginal) => {
  const original = await importOriginal<typeof import('#/_base/di/scope')>();
  return { ...original, createScopedChildHandle: createScopedChildHandleMock };
});

describe('SessionLifecycleService', () => {
  it('does not rescan workspace skills when additional dirs are session-only', async () => {
    const calls: string[] = [];
    const workspaceDirs = {
      ready: Promise.resolve(),
      mergeAdditionalDirs: vi.fn(async () => {
        calls.push('merge');
      }),
      sessionInfo: () => ({}),
    };
    const workspaceSkillCatalog = {
      sessionData: () => ({}),
      reloadSources: vi.fn(() => {
        calls.push('reload');
        return Promise.resolve();
      }),
    };
    const ready = Promise.resolve();
    const workdir = {
      dirs: workspaceDirs,
      skills: workspaceSkillCatalog,
      contextKey: 'local:/workspace',
      fs: {},
      instructions: { sessionProvider: () => ({}) },
      agentProfiles: { ready },
      dispose: vi.fn(),
    };
    const handle = {
      accessor: { get: () => ({ ready }) },
      dispose: vi.fn(),
    };
    createScopedChildHandleMock.mockReset();
    createScopedChildHandleMock.mockImplementation(() => {
      calls.push('scope');
      return handle;
    });
    const service = new SessionLifecycleService(
      ...([
        undefined,
        { workspaceId: 'wm_test', persistenceScope: 'sessions/wm_test' },
        { homeDir: '/home' },
        { ready, assertValid: () => {}, get: () => undefined },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        noopTelemetryService,
        undefined,
        { ready },
        { ready },
        { ready },
        { ready },
        { sessionHandle: () => ({}) },
        { ready },
        { ready },
        undefined,
        async () => workdir,
      ] as unknown as ConstructorParameters<typeof SessionLifecycleService>)
    );
    const materialize = (
      service as unknown as {
        materializeSession(
          options: {
            sessionId: string;
            workDir: string;
            additionalDirs: readonly string[];
          },
          environment: undefined,
          workdir: unknown,
        ): Promise<unknown>;
      }
    ).materializeSession(
      {
        sessionId: 'session_test',
        workDir: '/workspace',
        additionalDirs: ['/additional'],
      },
      undefined,
      workdir,
    );

    try {
      await materialize;
      expect(calls).toEqual(['merge', 'scope']);
      expect(workspaceSkillCatalog.reloadSources).not.toHaveBeenCalled();
      expect(workspaceDirs.mergeAdditionalDirs).toHaveBeenCalledWith('/workspace', ['/additional']);
    } finally {
      await materialize.catch(() => undefined);
      service.dispose();
      createScopedChildHandleMock.mockReset();
    }
  });

  it('seeds the session MCP handle from the MCP set of its workdir, falling back to the workspace set', async () => {
    const ready = Promise.resolve();
    const projectHandle = { name: 'project' };
    const worktreeHandle = { name: 'worktree' };
    const seeded: unknown[] = [];
    createScopedChildHandleMock.mockReset();
    createScopedChildHandleMock.mockImplementation(
      (_instantiation: unknown, _scope: unknown, _id: unknown, options: { readonly seeds: readonly (readonly [unknown, unknown])[] }) => {
        seeded.push(new Map(options.seeds).get(ISessionMcpHandle));
        return { accessor: { get: () => ({ ready }) }, dispose: vi.fn() };
      },
    );
    const workdir = (mcp?: { sessionHandle(): unknown }) => ({
      dirs: { ready, mergeAdditionalDirs: async () => {}, sessionInfo: () => ({}) },
      skills: { sessionData: () => ({}) },
      contextKey: 'local:/workspace',
      fs: {},
      instructions: { sessionProvider: () => ({}) },
      agentProfiles: { ready },
      mcp,
      dispose: vi.fn(),
    });
    const service = new SessionLifecycleService(
      ...([
        undefined,
        { workspaceId: 'wm_test', persistenceScope: 'sessions/wm_test' },
        { homeDir: '/home' },
        { ready, assertValid: () => {}, get: () => undefined },
        ...Array.from({ length: 9 }, () => undefined),
        noopTelemetryService,
        undefined,
        { ready },
        { ready },
        { ready },
        { ready },
        { sessionHandle: () => projectHandle },
        { ready },
        { ready },
      ] as unknown as ConstructorParameters<typeof SessionLifecycleService>)
    );
    const materialize = (sessionId: string, opened: ReturnType<typeof workdir>): Promise<unknown> => (
      service as unknown as {
        materializeSession(options: { sessionId: string; workDir: string }, environment: undefined, workdir: unknown): Promise<unknown>;
      }
    ).materializeSession({ sessionId, workDir: '/workspace' }, undefined, opened);

    try {
      await materialize('session_worktree', workdir({ sessionHandle: () => worktreeHandle }));
      await materialize('session_project', workdir());
      expect(seeded).toEqual([worktreeHandle, projectHandle]);
    } finally {
      service.dispose();
      createScopedChildHandleMock.mockReset();
    }
  });

  it('keeps remote resume cwd independent from the local primary', () => {
    const service = Object.assign(Object.create(SessionLifecycleService.prototype), {
      workspaceContext: { workspaceId: 'workspace', meta: { root: '/new-primary' } },
    }) as unknown as {
      sessionWorkDir(fallbackCwd: string, environment: { environmentId: string; cwd?: string } | undefined): string;
    };

    expect(service.sessionWorkDir('/local-anchor', { environmentId: 'ssh-dev', cwd: '/srv/app' })).toBe('/local-anchor');
    expect(service.sessionWorkDir('/old', undefined)).toBe('/new-primary');
    expect(service.sessionWorkDir('/old', { environmentId: 'local', cwd: '/explicit' })).toBe('/explicit');
  });
});
