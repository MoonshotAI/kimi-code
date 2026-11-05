import { describe, expect, it, vi } from 'vitest';

import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { Error2, ErrorCodes } from '#/errors';
import { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';

const { createScopedChildHandleMock } = vi.hoisted(() => ({
  createScopedChildHandleMock: vi.fn(),
}));

vi.mock('#/_base/di/scope', async (importOriginal) => {
  const original = await importOriginal<typeof import('#/_base/di/scope')>();
  return { ...original, createScopedChildHandle: createScopedChildHandleMock };
});

function summaryFixture(): SessionSummary {
  return {
    id: 'session_test',
    workspaceId: 'wm_test',
    cwd: '/workspace',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  };
}

function resumeService(summary: SessionSummary): {
  readonly service: SessionLifecycleService;
  readonly track2: ReturnType<typeof vi.fn>;
} {
  const service = Object.create(SessionLifecycleService.prototype) as SessionLifecycleService;
  const track2 = vi.fn();
  Object.assign(service as unknown as Record<string, unknown>, {
    sessions: new Map<string, ISessionScopeHandle>(),
    resuming: new Map(),
    resumeFailures: new Map(),
    workspaceContext: { workspaceId: summary.workspaceId, cwd: summary.cwd },
    index: { get: async () => summary },
    telemetry: { withContext: () => ({ track2 }) },
  });
  return { service, track2 };
}

describe('SessionLifecycleService', () => {
  it('circuits non-retryable failures until an explicit retry', async () => {
    const summary = summaryFixture();
    const { service, track2 } = resumeService(summary);
    const error = new Error2(ErrorCodes.FS_PATH_NOT_FOUND, 'missing');
    const handle = { id: summary.id } as ISessionScopeHandle;
    const doResume = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(handle);
    (service as unknown as { doResume: unknown }).doResume = doResume;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      await expect(service.resume(summary.id)).rejects.toMatchObject({
        code: ErrorCodes.SESSION_WORKSPACE_UNAVAILABLE,
        details: { cause_code: ErrorCodes.FS_PATH_NOT_FOUND, retryable: false },
      });
    }
    expect(doResume).toHaveBeenCalledTimes(1);
    expect(track2).toHaveBeenCalledTimes(1);

    await expect(service.resume(summary.id, { forceRetry: true })).resolves.toBe(handle);
    expect(doResume).toHaveBeenCalledTimes(2);
    expect(track2).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent failures into one real attempt', async () => {
    const summary = summaryFixture();
    const { service, track2 } = resumeService(summary);
    const error = new Error2(ErrorCodes.FS_PATH_NOT_FOUND, 'missing');
    const doResume = vi.fn(async () => {
      throw error;
    });
    (service as unknown as { doResume: unknown }).doResume = doResume;

    const attempts = Array.from({ length: 20 }, () => service.resume(summary.id));
    await Promise.all(attempts.map((attempt) => expect(attempt).rejects.toMatchObject({
        code: ErrorCodes.SESSION_WORKSPACE_UNAVAILABLE,
        details: { cause_code: ErrorCodes.FS_PATH_NOT_FOUND, retryable: false },
      })));
    expect(doResume).toHaveBeenCalledTimes(1);
    expect(track2).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures normally', async () => {
    const summary = summaryFixture();
    const { service } = resumeService(summary);
    const doResume = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(undefined);
    (service as unknown as { doResume: unknown }).doResume = doResume;

    await expect(service.resume(summary.id)).rejects.toThrow('temporary');
    await expect(service.resume(summary.id)).resolves.toBeUndefined();
    expect(doResume).toHaveBeenCalledTimes(2);
  });

  it('allows a real retry after the environment binding changes', async () => {
    const summary = summaryFixture();
    const { service } = resumeService(summary);
    const doResume = vi.fn()
      .mockRejectedValueOnce(new Error2(ErrorCodes.FS_PATH_NOT_FOUND, 'missing'))
      .mockResolvedValueOnce(undefined);
    (service as unknown as { doResume: unknown }).doResume = doResume;

    await expect(service.resume(summary.id)).rejects.toThrow('missing');
    Object.assign(summary, { environmentId: 'remote' });
    await expect(service.resume(summary.id)).resolves.toBeUndefined();
    expect(doResume).toHaveBeenCalledTimes(2);
  });

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
        { ready },
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
});
