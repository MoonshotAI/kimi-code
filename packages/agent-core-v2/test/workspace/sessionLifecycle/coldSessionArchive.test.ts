import { describe, expect, it } from 'vitest';

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import {
  ISessionIndex,
  ISessionIndexMirror,
  type SessionSummary,
} from '#/app/sessionIndex/sessionIndex';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import {
  setSessionArchivedBatch,
} from '#/workspace/sessionLifecycle/coldSessionArchive';

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
  readonly storeGet: () => Promise<SessionMeta | undefined>;
  readonly indexSummary?: SessionSummary;
  readonly onMirrorRecord?: (recorded: SessionSummary) => void;
}

function coldPathAccessor(options: ColdPathOptions): ServicesAccessor {
  return accessor([
    [
      ISessionManager,
      {
        withLifecycleSerialization: (_id: string, work: () => Promise<unknown>) => work(),
        whenResumeSettled: async () => {},
        get: () => undefined,
      },
    ],
    [ISessionIndex, { get: async () => options.indexSummary ?? summary }],
    [IBootstrapService, { scope: () => 'sessions' }],
    [IAtomicDocumentStore, { get: options.storeGet, set: async () => {} }],
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
});
