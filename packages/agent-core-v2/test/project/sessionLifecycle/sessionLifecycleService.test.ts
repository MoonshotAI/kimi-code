import { describe, expect, it, vi } from 'vitest';

import { ISessionPresence } from '#/app/sessionPresence/sessionPresence';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { SessionLifecycleService } from '#/project/sessionLifecycle/sessionLifecycleService';

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
      configuredSources: { contextKey: 'local:/workspace:configured', explicitAgentProfiles: { ready }, extraAgentProfiles: { ready } },
      mcp: { source: () => ({}) },
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
        undefined,
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

  it('keeps remote resume cwd independent from the local primary', () => {
    const service = Object.assign(Object.create(SessionLifecycleService.prototype), {
      projectContext: { workspaceId: 'workspace', meta: { root: '/new-primary' } },
    }) as unknown as {
      sessionWorkDir(fallbackCwd: string, environment: { environmentId: string; cwd?: string } | undefined): string;
    };

    expect(service.sessionWorkDir('/local-anchor', { environmentId: 'ssh-dev', cwd: '/srv/app' })).toBe('/local-anchor');
    expect(service.sessionWorkDir('/old', undefined)).toBe('/new-primary');
    expect(service.sessionWorkDir('/old', { environmentId: 'local', cwd: '/explicit' })).toBe('/explicit');
  });

  it('registers session presence even when the worktree flag starts disabled', async () => {
    const ready = Promise.resolve();
    const disposePresence = vi.fn();
    const markOpen = vi.fn(() => ({ dispose: disposePresence }));
    const anchored: { readonly name: string; readonly fn: () => void }[] = [];
    const workdir = {
      dirs: {
        ready,
        mergeAdditionalDirs: vi.fn(async () => {}),
        sessionInfo: () => ({}),
      },
      skills: { sessionData: () => ({}) },
      contextKey: 'local:/workspace',
      fs: {},
      instructions: { sessionProvider: () => ({}) },
      agentProfiles: { ready },
      configuredSources: {
        contextKey: 'local:/workspace:configured',
        explicitAgentProfiles: { ready },
        extraAgentProfiles: { ready },
      },
      mcp: { source: () => ({}) },
      dispose: vi.fn(),
    };
    const handle = {
      accessor: { get: () => ({ ready }) },
      dispose: vi.fn(),
    };
    createScopedChildHandleMock.mockReset();
    createScopedChildHandleMock.mockImplementation((_ix, _kind, _id, opts) => {
      opts.configureContainer({
        anchorKernelEntry: (fn: () => void, name: string) => {
          anchored.push({ name, fn });
        },
        invokeFunction: (cb: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
          cb({
            get: (id: unknown) => (id === ISessionPresence ? { markOpen } : undefined),
          }),
        provide: () => {},
      });
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
        { enabled: () => false },
        { ready },
        { ready },
        undefined,
        { ready },
        { ready },
        undefined,
        async () => workdir,
      ] as unknown as ConstructorParameters<typeof SessionLifecycleService>),
    );
    try {
      await (
        service as unknown as {
          materializeSession(
            options: { sessionId: string; workDir: string },
            environment: undefined,
            workdir: unknown,
          ): Promise<unknown>;
        }
      ).materializeSession({ sessionId: 'session_flag_off', workDir: '/workspace' }, undefined, workdir);

      expect(markOpen).toHaveBeenCalledWith('/home/sessions/wm_test/session_flag_off');
      const presenceAnchor = anchored.find((entry) => entry.name === 'sessionLifecycle:presence');
      expect(presenceAnchor).toBeDefined();
      presenceAnchor?.fn();
      expect(disposePresence).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose();
      createScopedChildHandleMock.mockReset();
    }
  });
});
