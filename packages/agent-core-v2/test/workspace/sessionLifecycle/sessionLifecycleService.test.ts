import { describe, expect, it, vi } from 'vitest';

import { noopTelemetryService } from '#/app/telemetry/telemetry';
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
      mcp: { sessionHandle: () => ({}) },
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
          environment: { environmentId: string; cwd: string },
          workdir: unknown,
        ): Promise<unknown>;
      }
    ).materializeSession(
      {
        sessionId: 'session_test',
        workDir: '/workspace',
        additionalDirs: ['/additional'],
      },
      { environmentId: 'local', cwd: '/workspace' },
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

  it.each([
    { meta: { cwd: '/old', environmentId: 'ssh-dev', environmentCwd: '/srv/app' }, host: '/old', environment: 'ssh-dev', cwd: '/srv/app' },
    { meta: { cwd: '/old' }, host: '/old', environment: 'local', cwd: '/old' },
    { meta: { cwd: '/old', environmentCwd: '/explicit' }, host: '/explicit', environment: 'local', cwd: '/explicit' },
    { meta: { workDir: '/legacy' }, host: '/legacy', environment: 'local', cwd: '/legacy' },
    { meta: { custom: { cwd: '/custom' } }, host: '/custom', environment: 'local', cwd: '/custom' },
  ])('resumes a session from its persisted cwd $cwd', async ({ meta, host, environment, cwd }) => {
    const materialized = vi.fn(async () => ({
      accessor: { get: () => ({ get: () => ({}) }) },
    }));
    const openWorkdir = vi.fn(async () => ({}));
    const service = Object.assign(Object.create(SessionLifecycleService.prototype), {
      sessions: new Map(), resuming: new Map(), resumeFailures: new Map(),
      index: { get: async () => ({ workspaceId: 'workspace', cwd: '/wrong' }) },
      docs: { get: async (scope: string) => scope.endsWith('session-meta') ? meta : undefined },
      workspaceContext: { workspaceId: 'workspace', cwd: '/new', meta: { root: '/new' }, persistenceScope: 'sessions/workspace' },
      openWorkdir, materializeSession: materialized, announceCreated: async () => {},
    }) as SessionLifecycleService;
    await service.resume('original');
    expect(openWorkdir).toHaveBeenCalledWith({ environmentId: environment, cwd });
    expect(materialized).toHaveBeenCalledWith(expect.objectContaining({
      workDir: host,
    }), { environmentId: environment, cwd }, {});
  });
});
