import { describe, expect, it, vi } from 'vitest';

import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { ISessionEphemeralMcpServers } from '#/session/mcp/ephemeralMcpServers';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionWorkdir } from '#/session/workdir/workdir';
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
      mcp: { anchor: '/workspace' },
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

  it.each([
    ['requested and contributed ephemeral servers', { requested: { transport: 'stdio', command: 'requested' } }],
    ['no ephemeral servers', undefined],
  ] as const)('builds the session MCP handle from its own workdir after will-create participants run, with %s', async (_label, mcpServers) => {
    const ready = Promise.resolve();
    const lease = { handle: { _serviceBrand: undefined }, dispose: vi.fn(async () => undefined) };
    const sessionHandle = vi.fn(() => lease);
    const workdir = {
      dirs: { ready, mergeAdditionalDirs: vi.fn(async () => undefined), sessionInfo: () => ({}) },
      skills: { sessionData: () => ({}), reloadSources: vi.fn(async () => undefined) },
      contextKey: 'local:/workspace',
      fs: {},
      instructions: { sessionProvider: () => ({}) },
      agentProfiles: { ready },
      mcp: { anchor: '/workspace', sessionHandle },
      dispose: vi.fn(),
    };
    const provided = new Map<unknown, unknown>();
    const kernelEntries: Array<() => void> = [];
    createScopedChildHandleMock.mockReset();
    createScopedChildHandleMock.mockImplementation(
      (_instantiation: unknown, _scope: unknown, _id: unknown, options: {
        readonly seeds: readonly (readonly [unknown, unknown])[];
        readonly configureContainer: (container: unknown) => void;
      }) => {
        for (const [id, value] of options.seeds) provided.set(id, value);
        options.configureContainer({
          invokeFunction: (fn: (accessor: { get(id: unknown): unknown }) => unknown) =>
            fn({ get: (id) => provided.get(id) }),
          provide: (id: unknown, value: unknown) => {
            provided.set(id, value);
          },
          anchorKernelEntry: (dispose: () => void) => {
            kernelEntries.push(dispose);
          },
        });
        return { accessor: { get: () => ({ ready }) }, dispose: vi.fn() };
      },
    );
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
        { ready },
        { ready },
        undefined,
        undefined,
        async () => workdir,
      ] as unknown as ConstructorParameters<typeof SessionLifecycleService>)
    );
    const contributed = { transport: 'http', url: 'https://example.com/mcp' } as const;
    service.onWillCreateSession((event) => {
      event.contributeSeed(ISessionEphemeralMcpServers, {
        ...event.readSeed(ISessionEphemeralMcpServers),
        contributed,
      });
    });

    try {
      await (
        service as unknown as {
          materializeSession(options: object, environment: undefined, workdir: unknown): Promise<unknown>;
        }
      ).materializeSession({ sessionId: 'session_test', workDir: '/workspace', mcpServers }, undefined, workdir);

      expect(sessionHandle).toHaveBeenCalledOnce();
      expect(sessionHandle).toHaveBeenCalledWith({
        sessionId: 'session_test',
        ephemeral: { ...mcpServers, contributed },
      });
      expect(provided.get(ISessionMcpHandle)).toBe(lease.handle);
      expect(provided.get(ISessionWorkdir)).toMatchObject({ environmentId: 'local', anchor: '/workspace' });
      expect(lease.dispose).not.toHaveBeenCalled();
      for (const dispose of kernelEntries) dispose();
      expect(lease.dispose).toHaveBeenCalledOnce();
    } finally {
      service.dispose();
      createScopedChildHandleMock.mockReset();
    }
  });

  it('keeps remote resume cwd independent from the local primary', () => {
    const service = Object.assign(Object.create(SessionLifecycleService.prototype), {
      workspaceContext: { workspaceId: 'workspace', meta: { root: '/new-primary' } },
    }) as unknown as {
      workDirOfBinding(fallbackCwd: string, environment: { environmentId: string; cwd?: string } | undefined): string;
    };

    expect(service.workDirOfBinding('/local-anchor', { environmentId: 'ssh-dev', cwd: '/srv/app' })).toBe('/local-anchor');
    expect(service.workDirOfBinding('/old', undefined)).toBe('/new-primary');
    expect(service.workDirOfBinding('/old', { environmentId: 'local', cwd: '/explicit' })).toBe('/explicit');
  });
});
