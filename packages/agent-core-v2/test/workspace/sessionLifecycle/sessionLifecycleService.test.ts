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
  it('awaits workspace skill reload after merging additional dirs before creating session scope', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
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
        return blocked;
      }),
    };
    const ready = Promise.resolve();
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
        { ready },
        workspaceDirs,
        workspaceSkillCatalog,
        { sessionProvider: () => ({}) },
        { sessionHandle: () => ({}) },
        { ready },
        { ready },
      ] as unknown as ConstructorParameters<typeof SessionLifecycleService>)
    );
    const materialize = (
      service as unknown as {
        materializeSession(options: {
          sessionId: string;
          workDir: string;
          additionalDirs: readonly string[];
        }): Promise<unknown>;
      }
    ).materializeSession({
      sessionId: 'session_test',
      workDir: '/workspace',
      additionalDirs: ['/additional'],
    });

    try {
      await vi.waitFor(() => {
        expect(workspaceSkillCatalog.reloadSources).toHaveBeenCalledWith(['workspace']);
      });
      expect(createScopedChildHandleMock).not.toHaveBeenCalled();
      release();
      await materialize;
      expect(calls).toEqual(['merge', 'reload', 'scope']);
      expect(workspaceDirs.mergeAdditionalDirs).toHaveBeenCalledWith('/workspace', ['/additional']);
    } finally {
      release();
      await materialize.catch(() => undefined);
      service.dispose();
      createScopedChildHandleMock.mockReset();
    }
  });
});
