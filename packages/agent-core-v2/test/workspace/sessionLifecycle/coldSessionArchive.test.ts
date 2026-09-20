
import { describe, expect, it, vi } from 'vitest';

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { Emitter, Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { ISessionManager, type UnguardedSessionLifecycle } from '#/app/sessionManager/sessionManager';
import { SessionManager } from '#/app/sessionManager/sessionManagerService';
import {
  ISessionIndex,
  ISessionIndexMirror,
  type SessionSummary,
} from '#/app/sessionIndex/sessionIndex';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import {
  setSessionArchived,
  setSessionArchivedBatch,
} from '#/workspace/sessionLifecycle/coldSessionArchive';
import type { SessionCreatedEvent } from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
import type { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

function accessor(
  entries: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>,
): ServicesAccessor {
  return {
    get<T>(id: ServiceIdentifier<T>): T {
      for (const [key, value] of entries) {
        if (key === id) return value as T;
      }
      throw new Error(`Unexpected service request: ${String(id)}`);
    },
  };
}

const summary: SessionSummary = {
  id: 's1',
  workspaceId: 'wd',
  cwd: '/workspace',
  createdAt: 1,
  updatedAt: 1,
  archived: false,
};

interface ColdPathOptions {
  readonly storeGet: (scope: string, key: string) => Promise<SessionMeta | undefined>;
  readonly indexSummary?: SessionSummary;
  readonly onMirrorRecord?: (recorded: SessionSummary) => void;
  readonly onStoreSet?: (scope: string, key: string, value: unknown) => void;
  readonly onStoreDelete?: (scope: string, key: string) => void;
  readonly resumeError?: Error;
  readonly manager?: ISessionManager;
}

function coldPathAccessor(options: ColdPathOptions): ServicesAccessor {
  return accessor([
    [
      ISessionManager,
      options.manager ?? {
        withLifecycleSerialization: <T>(
          _id: string,
          work: (unguarded: UnguardedSessionLifecycle) => Promise<T>,
        ): Promise<T> => work({ archive: async () => {}, restore: async () => undefined }),
        whenResumeSettled: async () => {
          if (options.resumeError !== undefined) throw options.resumeError;
        },
        get: () => undefined,
      },
    ],
    [ISessionIndex, { get: async () => options.indexSummary ?? summary }],
    [IBootstrapService, { scope: () => 'sessions' }],
    [
      IAtomicDocumentStore,
      {
        get: (scope: string, key: string) => options.storeGet(scope, key),
        set: async (scope: string, key: string, value: unknown) => {
          options.onStoreSet?.(scope, key, value);
        },
        delete: async (scope: string, key: string) => {
          options.onStoreDelete?.(scope, key);
        },
      },
    ],
    [
      ISessionIndexMirror,
      { record: (recorded: SessionSummary) => options.onMirrorRecord?.(recorded) },
    ],
    [IEventService, { publish: () => {} }],
  ]);
}

describe('setSessionArchivedBatch', () => {
  it('maps a metadata read failure to a per-item internal error, not not_found', async () => {
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({
        storeGet: async () => {
          throw new Error('disk on fire');
        },
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: false, reason: 'error', message: 'disk on fire' }]);
  });

  it('maps a missing metadata document to not_found', async () => {
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({ storeGet: async () => undefined }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([
      { id: 's1', ok: false, reason: 'not_found', message: 'session s1 does not exist' },
    ]);
  });

  it('mirrors the persisted metadata, not a stale index summary', async () => {
    const recorded: SessionSummary[] = [];
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({
        indexSummary: { ...summary, title: 'stale', lastPrompt: 'stale-p', updatedAt: 1 },
        storeGet: async () => ({
          id: 's1',
          title: 'fresh',
          lastPrompt: 'fresh-p',
          createdAt: 1,
          updatedAt: 9,
          archived: false,
        }),
        onMirrorRecord: (r) => recorded.push(r),
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: true }]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      workspaceId: 'wd',
      title: 'fresh',
      lastPrompt: 'fresh-p',
      updatedAt: 9,
      archived: true,
    });
    expect(typeof recorded[0]?.archivedAt).toBe('number');
  });

  it('normalizes legacy v1 metadata before persisting and mirroring', async () => {
    const recorded: SessionSummary[] = [];
    const written: unknown[] = [];
    const legacy = {
      workDir: '/workspace',
      customTitle: 'legacy title',
      createdAt: '2026-07-21T19:40:00.000Z',
      updatedAt: '2026-07-22T02:00:00.000Z',
      archived: false,
    } as unknown as SessionMeta;
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({
        storeGet: async () => legacy,
        onMirrorRecord: (r) => recorded.push(r),
        onStoreSet: (_scope, _key, value) => written.push(value),
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: true }]);

    const rec = recorded[0];
    expect(rec?.title).toBe('legacy title');
    expect(rec?.updatedAt).toBe(Date.parse('2026-07-22T02:00:00.000Z'));

    const persisted = written[0] as Record<string, unknown>;
    expect(persisted['version']).toBe(2);
    expect(typeof persisted['updatedAt']).toBe('number');
    expect(persisted['customTitle']).toBeUndefined();
    expect(persisted['isCustomTitle']).toBe(true);
  });

  it('cold-classifies the item when a concurrent resume failed', async () => {
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({
        storeGet: async () => ({ id: 's1', createdAt: 1, updatedAt: 2, archived: false }),
        resumeError: new Error('resume boom'),
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: true }]);
  });

  it('reads and migrates the legacy session-meta location before answering not_found', async () => {
    const written: Array<{ scope: string; value: unknown }> = [];
    const deleted: string[] = [];
    const meta: SessionMeta = { id: 's1', createdAt: 1, updatedAt: 2, archived: false };
    const outcomes = await setSessionArchivedBatch(
      coldPathAccessor({
        storeGet: async (scope) => (scope.endsWith('/session-meta') ? meta : undefined),
        onStoreSet: (scope, _key, value) => written.push({ scope, value }),
        onStoreDelete: (scope) => deleted.push(scope),
      }),
      ['s1'],
      true,
    );
    expect(outcomes).toEqual([{ id: 's1', ok: true }]);
    expect(written).toHaveLength(1);
    expect(written[0]?.scope.endsWith('/session-meta')).toBe(false);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.endsWith('/session-meta')).toBe(true);
  });
});

function sessionManagerResuming(sessionId: string): SessionManager {
  const handle = { id: sessionId } as unknown as ISessionScopeHandle;
  const didCreate = new Emitter<SessionCreatedEvent>();
  const controller = {
    onWillCreateSession: Event.None,
    onDidCreateSession: didCreate.event,
    onWillCloseSession: Event.None,
    onDidCloseSession: Event.None,
    onDidArchiveSession: Event.None,
    onDidForkSession: Event.None,
    resume: async () => {
      didCreate.fire({ sessionId, handle, source: 'startup' });
      return handle;
    },
    dispose: () => {},
  } as unknown as SessionLifecycleService;
  const workspace = {
    id: summary.workspaceId,
    program: { sessionControllerGeneration: 'generation-1', createSessionController: () => controller },
  } as unknown as WorkspaceInstance;
  return new SessionManager(
    { getOrCreate: async () => workspace, get: () => workspace } as unknown as IWorkspaceInstanceManager,
    { get: async () => summary } as unknown as ISessionIndex,
  );
}

async function drainMicrotasks(ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

describe('setSessionArchived', () => {
  it('finishes when a resume is queued behind it on the session lifecycle chain', async () => {
    const manager = sessionManagerResuming('s1');
    let releaseEarlierTransition!: () => void;
    const earlierTransition = manager.withLifecycleSerialization(
      's1',
      () => new Promise<void>((resolve) => {
        releaseEarlierTransition = resolve;
      }),
    );
    let archiveOutcome: string | undefined;
    void setSessionArchived(
      coldPathAccessor({
        manager,
        storeGet: async () => ({ id: 's1', createdAt: 1, updatedAt: 2, archived: false }),
      }),
      's1',
      true,
    ).then((outcome) => {
      archiveOutcome = outcome;
    });
    await drainMicrotasks();
    const resumed = manager.resume('s1');

    releaseEarlierTransition();
    await earlierTransition;

    await vi.waitFor(() => {
      expect(archiveOutcome).toBe('updated');
    });
    await expect(resumed).resolves.toMatchObject({ id: 's1' });
    manager.dispose();
  });
});
